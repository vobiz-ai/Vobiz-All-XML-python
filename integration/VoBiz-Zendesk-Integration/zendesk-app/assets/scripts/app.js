/** === Vobiz Calling — Zendesk Support CTI app (top_bar) ===
 *
 * A softphone that lives in the Zendesk top bar. It stays registered over SIP
 * while the panel is open, dials when the agent clicks Call or clicks a phone
 * number in Zendesk, and writes the result back to a ticket.
 *
 * THE BROWSER IS THE A LEG. This panel sends the SIP INVITE itself and the
 * backend answers with <Dial><Number>. The reverse — backend originates to the
 * customer, then bridges this browser in with <Dial><User> — is what the
 * previous build did, and it cannot work: routing *into* a registered WebRTC
 * endpoint is blocked platform-side. See ISSUES.md.
 *
 * This app holds no Vobiz credentials. The agent's Auth ID/Token are POSTed to
 * the backend once at login, exchanged for an opaque session token, and never
 * stored in the browser.
 */

const REGISTRAR_HOST = "registrar.vobiz.ai";

let client = null;
let backendUrl = "";
let agentId = "";
let registrarUrl = `wss://${REGISTRAR_HOST}:5063/`;
let zendeskSubdomain = "";

let sessionToken = "";
let vobizUA = null;
let currentRTCSession = null;
let agentIdentity = null;

// Calling needs BOTH an account session (whose number, whose balance) and a
// live SIP registration (where the audio lands). Gating on one alone lets an
// agent dial while the other is down, which rings the customer into silence.
let accountReady = false;
let sipRegistered = false;

let callDirection = "Outbound";
let callDurationSeconds = 0;
let timerInterval = null;
let resolvedUser = null;
let activeTicketId = null;
let lastDialedNumber = "";
let lastCallRecord = null;

// ─── backend plumbing ────────────────────────────────────────────────────────

/**
 * Every backend call goes through here.
 *
 * The Bearer token is the whole auth story: the backend issues it at login and
 * nothing else the browser holds can be replayed against Vobiz.
 *
 * ngrok's free tier serves a browser interstitial to anything with a browser
 * User-Agent, so a plain fetch() gets an HTML warning page instead of JSON.
 * The header suppresses it and is inert against any other host.
 */
async function backendFetch(pathname, options = {}) {
  const headers = {
    "ngrok-skip-browser-warning": "1",
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
    ...(options.headers || {}),
  };
  // No fallback to a different host, ever. The previous build retried against a
  // hardcoded tunnel hostname, which hands the operator's credentials to
  // whoever owns that hostname once the quick tunnel expires.
  return fetch(`${backendUrl}${pathname}`, { ...options, headers });
}

async function backendJson(pathname, options) {
  const res = await backendFetch(pathname, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${options && options.method || "GET"} ${pathname} failed (${res.status})`);
  return data;
}

/**
 * ZAF hands settings back as a flat object. zcli's local app.json expresses the
 * same thing as an ARRAY of single-key objects:
 *
 *   [{ title: "…" }, { backend_url: "…" }, { agent_id: "…" }]
 *
 * That normally gets normalised before it reaches us, but when it does not the
 * only symptom is the panel reading "Not configured" with correct settings
 * plainly visible in zcli — which sends you looking in entirely the wrong
 * place. Accept both shapes.
 */
function normaliseSettings(raw) {
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw;
  return Object.assign({}, ...raw.filter(Boolean));
}

// ─── boot ────────────────────────────────────────────────────────────────────

init();

async function init() {
  const inZendesk = typeof ZAFClient !== "undefined" && window.location.search.includes("origin=");

  if (inZendesk) {
    client = ZAFClient.init();
    try { await client.invoke("resize", { width: "100%", height: "560px" }); } catch { /* non-fatal */ }

    try {
      const metadata = await client.metadata();
      const settings = normaliseSettings(metadata && metadata.settings);
      backendUrl = String(settings.backend_url || "").trim().replace(/\/+$/, "");
      agentId = String(settings.agent_id || "").trim();
      if (settings.registrar_url) registrarUrl = String(settings.registrar_url).trim();

      const context = await client.context();
      zendeskSubdomain = (context && context.account && context.account.subdomain) || "";
    } catch (err) {
      console.warn("[Vobiz] Could not read app settings:", err);
    }
  } else {
    console.log("[Vobiz] Standalone dev mode — no ZAF client.");
    backendUrl = "http://localhost:8092";
    agentId = "test-agent";
  }

  if (!backendUrl || !agentId) {
    setStatus("Not configured — set the Backend URL and Agent Identity in this app's settings.", "status-error");
    showView("login");
    return;
  }
  // A bare hostname resolves relative to the app origin and 404s silently,
  // which reads as "the backend is down" rather than a typo. localhost is the
  // one exemption: browsers already treat it as a secure context.
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(backendUrl);
  if (!/^https:\/\//i.test(backendUrl) && !isLocal) {
    setStatus("Backend URL must start with https:// — check this app's settings.", "status-error");
    showView("login");
    return;
  }

  wireUi();

  if (inZendesk) client.on("cti.triggerDialer", onTriggerDialer);

  // Leave the registrar cleanly. Without this the binding lingers until it
  // expires (JsSIP defaults to 600s) and inbound routes to a dead leg for up
  // to ten minutes after the agent closes the tab.
  window.addEventListener("beforeunload", () => {
    try { if (vobizUA) vobizUA.stop(); } catch { /* nothing useful on the way out */ }
  });

  await restoreSession();
}

function wireUi() {
  document.getElementById("dialbtn").addEventListener("click", onDialButtonClick);
  document.getElementById("hangupbtn").addEventListener("click", onHangupButtonClick);
  document.getElementById("logbtn").addEventListener("click", onLogButtonClick);
  document.getElementById("auth-save-btn").addEventListener("click", onLoginClick);

  const settingsBtn = document.getElementById("settings-toggle-btn");
  if (settingsBtn) {
    settingsBtn.addEventListener("click", () => {
      const loginVisible = document.getElementById("login-view").style.display !== "none";
      showView(loginVisible && accountReady ? "dialer" : "login");
    });
  }

  const fromSelect = document.getElementById("from-number-select");
  if (fromSelect) fromSelect.addEventListener("change", onSelectNumber);

  const dialInput = document.getElementById("dialnumber");
  if (dialInput) {
    dialInput.addEventListener("keydown", e => { if (e.key === "Enter") onDialButtonClick(); });
  }
}

/**
 * Session restore.
 *
 * sessionStorage, not localStorage, and only the opaque backend token — never
 * the Vobiz Auth Token. It dies with the tab, which is the right lifetime for
 * something that authorises placing billable calls.
 */
async function restoreSession() {
  sessionToken = sessionStorage.getItem("vobiz_session_token") || "";
  if (!sessionToken) {
    showView("login");
    setStatus("Sign in to start calling", "status-connecting");
    return;
  }
  try {
    const session = await backendJson("/session");
    if (!session.loggedIn) throw new Error("expired");
    await onLoggedIn(session.numbers, session.from, session.authId);
  } catch {
    sessionStorage.removeItem("vobiz_session_token");
    sessionToken = "";
    showView("login");
    setStatus("Sign in to start calling", "status-connecting");
  }
}

async function onLoginClick() {
  const authId = document.getElementById("auth-id-input").value.trim();
  const authToken = document.getElementById("auth-token-input").value.trim();
  if (!authId || !authToken) {
    setLoginStatus("Enter both an Auth ID and an Auth Token.");
    return;
  }
  setLoginStatus("Signing in…");
  try {
    const data = await backendJson("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, authId, authToken }),
    });
    sessionToken = data.token;
    sessionStorage.setItem("vobiz_session_token", sessionToken);
    // The token the agent typed is deliberately not kept anywhere. Clear the
    // field so it does not sit in the DOM either.
    document.getElementById("auth-token-input").value = "";
    await onLoggedIn(data.numbers, data.selected, data.authId);
  } catch (err) {
    console.error("[Vobiz] Login failed:", err);
    setLoginStatus(`Sign-in failed: ${err.message}`);
    accountReady = false;
    refreshDialState();
  }
}

async function onLoggedIn(numbers, selected, authId) {
  renderNumberOptions(numbers, selected);
  setLoginStatus(`Signed in as ${authId}`);
  accountReady = Boolean(selected);
  refreshDialState();
  showView("dialer");

  // Bind this SIP endpoint to a Vobiz application pointing at the backend's
  // /answer. This is not optional and not a convenience: when the browser
  // dials, Vobiz fetches the answer URL of the application the ENDPOINT is
  // bound to. Unbound, there is no answer URL, so there is no <Dial> and the
  // call dies with no error anywhere in the panel.
  //
  // Idempotent — the backend reuses an existing application when the answer URL
  // already matches, so this is safe to run on every sign-in.
  try {
    const setup = await backendJson("/setup", { method: "POST" });
    console.log(`[Vobiz] endpoint ${setup.sipUser} bound to app ${setup.appId} (${setup.answerUrl})`);
  } catch (err) {
    // Non-fatal for registration — the panel still comes up and can receive —
    // but outbound will not work, so say so plainly rather than letting the
    // agent discover it on a call that goes nowhere.
    console.error("[Vobiz] Endpoint setup failed:", err);
    setLoginStatus(`Signed in as ${authId} — but call routing is not set up: ${err.message}`);
  }

  initVobizSip();
}

async function onSelectNumber(event) {
  const number = event.target.value;
  try {
    const data = await backendJson("/select-number", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number }),
    });
    setLoginStatus(`Calling from ${data.selected}`);
  } catch (err) {
    console.error("[Vobiz] Could not switch numbers:", err);
    setLoginStatus(`Could not switch numbers: ${err.message}`);
  }
}

// ─── SIP ─────────────────────────────────────────────────────────────────────

async function initVobizSip() {
  setStatus("Connecting…", "status-connecting");

  // Surface a dead microphone path now rather than mid-call. Inside the Zendesk
  // iframe this fails when the app frame is not granted microphone permission,
  // and the symptom otherwise is a call that rings and connects to silence.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("No microphone access in this frame — calls cannot connect.", "status-error");
    return;
  }

  let agent;
  try {
    agent = await backendJson("/agent");
  } catch (err) {
    console.error("[Vobiz] Could not load the SIP identity:", err);
    setStatus("Cannot reach the calling backend — check the Backend URL in this app's settings.", "status-error");
    setSipRegistered(false);
    return;
  }
  agentIdentity = agent;
  if (agent.registrarUrl) registrarUrl = agent.registrarUrl;

  // Everything below throws if the SIP library did not load, and a throw here
  // leaves the panel frozen on "Registering…" forever: the status was already
  // set, and no UA exists to emit registrationFailed. Say what actually
  // happened instead of stalling.
  if (typeof JsSIP === "undefined") {
    console.error("[Vobiz] JsSIP failed to load — assets/lib/jssip.min.js is missing or was blocked.");
    setStatus("SIP library failed to load — the panel cannot register.", "status-error");
    setSipRegistered(false);
    return;
  }

  setStatus(`Registering ${agent.displayName}…`, "status-connecting");

  try {
  const socket = new JsSIP.WebSocketInterface(registrarUrl);
  vobizUA = new JsSIP.UA({
    sockets: [socket],
    uri: `sip:${agent.sipUser}`,
    password: agent.sipPassword,
    register: true,
    // Vobiz's media server rejects JsSIP's default session-timer proposal with
    // "422 Session Interval Too Small", which JsSIP surfaces as the opaque
    // cause "SIP Failure Code" and which produces NO CDR AT ALL, because the
    // call is refused before it is ever created. Vobiz's own SDK sets this same
    // flag, so matching it is the supported configuration, not a workaround.
    session_timers: false,
    // No space in the User-Agent, deliberately. Vobiz stores the registration's
    // User-Agent and later interpolates it unescaped into a gateway URI as a
    // `user_agent=` parameter. JsSIP's default is "JsSIP 3.10.1" — the space
    // makes that URI unparseable and Kamailio drops the INVITE rather than
    // ringing us.
    user_agent: "VobizZendeskCalling/2.0.0",
  });

  vobizUA.on("registered", () => {
    setStatus(`Ready — ${agent.displayName}`, "status-ready");
    setSipRegistered(true);
  });
  vobizUA.on("registrationFailed", e => {
    setStatus(`Registration failed: ${(e && e.cause) || "unknown"}`, "status-error");
    setSipRegistered(false);
  });
  // Without these two a dropped transport leaves the panel reading "Ready"
  // while the endpoint is uncallable.
  vobizUA.on("unregistered", () => {
    setStatus("Not registered — reconnecting…", "status-connecting");
    setSipRegistered(false);
  });
  vobizUA.on("disconnected", () => {
    setStatus("Disconnected from the registrar — reconnecting…", "status-connecting");
    setSipRegistered(false);
  });

  vobizUA.on("newRTCSession", data => {
    if (data.originator !== "remote") return;
    onIncomingCall(data.session);
  });

  vobizUA.start();
  } catch (err) {
    console.error("[Vobiz] Could not start the SIP stack:", err);
    setStatus(`Could not start the SIP stack — ${err.message}`, "status-error");
    setSipRegistered(false);
  }
}

/**
 * Inbound. Currently unreachable — <Dial><User> into a registered WebRTC
 * endpoint is blocked platform-side (ISSUES.md #1) — but the handler is correct
 * and starts working the day Vobiz fixes its gateway URI.
 */
function onIncomingCall(session) {
  callDirection = "Inbound";
  currentRTCSession = session;

  const callerNumber = (session.remote_identity && session.remote_identity.uri && session.remote_identity.uri.user) || "Unknown";
  lastDialedNumber = callerNumber;

  if (client) client.invoke("popover", "show").catch(() => { /* popover may already be open */ });
  showCallView("Incoming call", callerNumber, "Ringing…");
  searchZendeskUser(callerNumber);
  findCurrentTicketId().then(id => { activeTicketId = id; });

  attachRemoteAudio(session);
  bindSessionLifecycle(session, callerNumber);

  try {
    // pcConfig matters here exactly as much as on an outbound call: without
    // STUN the answer carries host-only candidates and the leg is torn down
    // without connecting, leaving a CDR billed 0s and no explanation.
    session.answer({
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
    });
  } catch (err) {
    // A throw inside this handler used to abort before .answer() ran: the
    // browser silently never picked up, Vobiz rang until it timed out, and the
    // dial result read ring=true with no B leg and no explanation anywhere.
    console.error("[Vobiz] Could not answer the incoming call:", err);
    setStatus(`Could not answer — ${err.name === "NotAllowedError" ? "microphone permission was refused for this frame" : err.message}`, "status-error");
    try { session.terminate(); } catch { /* already gone */ }
    currentRTCSession = null;
  }
}

/**
 * For an INCOMING session JsSIP has not built the RTCPeerConnection yet —
 * session.connection is null until the call is answered. Dereferencing it here
 * throws, and the throw aborts the handler before .answer() runs. Bind through
 * the "peerconnection" event, and only fall back to session.connection when one
 * already exists.
 */
function attachRemoteAudio(session) {
  const audioEl = document.getElementById("vobiz-remote-audio");
  if (!audioEl) return;
  const bindTrack = pc => {
    if (!pc) return;
    pc.addEventListener("track", event => {
      audioEl.srcObject = event.streams[0];
      audioEl.play().catch(err => console.warn("[Vobiz] audio autoplay blocked:", err));
    });
  };
  session.on("peerconnection", e => bindTrack(e.peerconnection));
  bindTrack(session.connection);
}

function bindSessionLifecycle(session, number) {
  session.on("progress", () => setCallState(`Ringing ${number}…`, "call-ringing"));
  session.on("confirmed", () => {
    setCallState("Active call", "call-active");
    document.getElementById("call-timer").style.display = "block";
    startTimer();
  });
  session.on("ended", () => endCall("Call ended"));
  session.on("failed", e => endCall(`Call failed — ${(e && e.cause) || "unknown"}`));
}

// ─── placing a call ──────────────────────────────────────────────────────────

async function onTriggerDialer(event) {
  // Zendesk's click-to-dial relay (background.js) passes the number here.
  const number = event && (event.number || (event.helper && event.helper.getData && event.helper.getData().number));
  if (event && event.ticketId) activeTicketId = event.ticketId;
  if (client) client.invoke("popover", "show").catch(() => { /* already open */ });
  callDirection = "Outbound";
  await placeCall(number);
}

function onDialButtonClick() {
  const input = document.getElementById("dialnumber");
  const number = input && input.value.trim();
  callDirection = "Outbound";
  placeCall(number);
}

/**
 * Place an outbound call with this browser as the A leg.
 *
 * The panel sends the INVITE itself. Vobiz then fetches the answer URL of the
 * application this SIP endpoint is bound to, and the backend replies with
 * <Dial><Number> to reach the customer — the same shape Vobiz's own rtc-demo
 * and WebRTC playground use.
 */
async function placeCall(number) {
  if (!number) return;

  if (!vobizUA || !sipRegistered) {
    setLoginStatus("Not registered yet — wait for the status to read Ready.");
    return;
  }
  if (currentRTCSession) {
    setLoginStatus("Already on a call.");
    return;
  }

  lastDialedNumber = number;
  lastCallRecord = null;
  showCallView("Dialling", number, "Connecting…");
  searchZendeskUser(number);
  activeTicketId = await findCurrentTicketId();

  // Vobiz routes a bare E.164 destination; the registrar is the SIP domain.
  const target = `sip:${String(number).replace(/[^\d+]/g, "")}@${REGISTRAR_HOST}`;

  try {
    const session = vobizUA.call(target, {
      mediaConstraints: { audio: true, video: false },
      // Without STUN the offer carries only host candidates, Vobiz logs
      // "PrivateIP … Detected in SDP", and the browser rejects the early-media
      // answer as an incompatible SDP — the call is cancelled a few hundred ms
      // in with a CDR billed 0s. These are the values Vobiz's own SDK uses.
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
    });
    currentRTCSession = session;
    attachRemoteAudio(session);
    bindSessionLifecycle(session, number);
  } catch (err) {
    console.error("[Vobiz] Could not start the call:", err);
    setCallState(
      err && err.name === "NotAllowedError"
        ? "Microphone permission was refused for this frame"
        : `Could not start the call — ${err.message}`,
      "call-ended",
    );
  }
}

function onHangupButtonClick() {
  const btn = document.getElementById("hangupbtn");
  if (btn && btn.dataset.mode === "close") {
    resetToDialer();
    return;
  }
  // A SIP BYE from this leg is enough: the browser is the A leg, so hanging it
  // up tears the whole call down. There is no REST hangup to make.
  if (currentRTCSession) {
    try { currentRTCSession.terminate(); } catch (err) { console.warn("[Vobiz] hangup failed:", err); }
  } else {
    endCall("Call ended");
  }
}

async function endCall(statusText) {
  stopTimer();
  currentRTCSession = null;
  setCallState(statusText, "call-ended");
  setStatus(agentIdentity ? `Ready — ${agentIdentity.displayName}` : "Ready", "status-ready");

  const btn = document.getElementById("hangupbtn");
  if (btn) {
    btn.textContent = "Close";
    btn.className = "btn btn-secondary";
    btn.dataset.mode = "close";
  }
  document.getElementById("call-log-section").style.display = "block";

  // Vobiz writes the CDR a few seconds after hangup and the recording callback
  // lands later still, so poll briefly rather than expecting either to be ready
  // the instant the session ends.
  pollForCallRecord();
}

async function pollForCallRecord() {
  for (const delay of [3000, 5000, 8000]) {
    await new Promise(r => setTimeout(r, delay));
    try {
      const rec = await backendJson(`/call-record?to=${encodeURIComponent(lastDialedNumber)}`);
      if (rec.found) {
        lastCallRecord = rec;
        renderRecordingPreview(rec);
        if (rec.recordingId) return;
      }
    } catch { /* the panel still works without it */ }
  }
}

function renderRecordingPreview(rec) {
  const box = document.getElementById("recording-preview-box");
  if (!box) return;
  if (rec.recordingUrl) {
    box.innerHTML = `<span>🎙️</span><span><strong>Recording ready</strong> — it will be linked in the ticket note.</span>`;
  } else if (rec.bLegUuid) {
    box.innerHTML = `<span>⏳</span><span>Call connected (${rec.duration || 0}s). The recording is still processing.</span>`;
  } else {
    // An empty DialBLegUUID is the single most useful diagnostic in this stack:
    // it means no B leg was ever created, whatever the UI said.
    box.innerHTML = `<span>⚠️</span><span>No B leg was created — the destination was unreachable, or the caller ID is not owned by this account.</span>`;
  }
}

function resetToDialer() {
  document.getElementById("call-notes").value = "";
  document.getElementById("dialnumber").value = "";
  document.getElementById("call-log-section").style.display = "none";
  const btn = document.getElementById("hangupbtn");
  if (btn) {
    btn.textContent = "Hang Up";
    btn.className = "btn btn-hangup";
    delete btn.dataset.mode;
  }
  lastCallRecord = null;
  resolvedUser = null;
  showView("dialer");
}

// ─── Zendesk write-back ──────────────────────────────────────────────────────

function searchZendeskUser(phoneNumber) {
  resolvedUser = null;
  const infoEl = document.getElementById("contact-info");
  if (infoEl) infoEl.style.display = "none";
  if (!client) return;

  const clean = String(phoneNumber).replace(/[^\d+]/g, "");
  if (!clean) return;

  // ZAF proxies this with the agent's own session, so it respects their
  // permissions — no API token needed and nothing to leak.
  client.request(`/api/v2/search.json?query=${encodeURIComponent(`type:user phone:${clean}`)}`)
    .then(data => {
      if (!data || !data.results || !data.results.length) return;
      resolvedUser = data.results[0];
      document.getElementById("caller-name").textContent = resolvedUser.name;
      document.getElementById("zd-user-name").textContent = resolvedUser.name;
      if (infoEl) infoEl.style.display = "block";
      const btn = document.getElementById("view-profile-btn");
      if (btn) btn.onclick = () => client.invoke("routeTo", "user", resolvedUser.id);
    })
    .catch(err => console.warn("[Vobiz] Zendesk user search failed:", err));
}

/**
 * Which ticket is the agent looking at?
 *
 * A top_bar app has no page context of its own, so this asks every ticket_sidebar
 * instance of this app. That requires the ticket_sidebar location to be
 * installed — without it there is no ticket context and calls log as new tickets.
 */
async function findCurrentTicketId() {
  if (!client) return null;
  try {
    const { instances } = await client.get("instances");
    for (const guid of Object.keys(instances)) {
      if (instances[guid].location !== "ticket_sidebar") continue;
      const data = await client.instance(guid).get("ticket.id");
      if (data && data["ticket.id"]) return data["ticket.id"];
    }
  } catch (err) {
    console.warn("[Vobiz] Could not resolve the active ticket:", err);
  }
  return null;
}

async function onLogButtonClick() {
  const notes = document.getElementById("call-notes").value.trim();
  const customerPhone = document.getElementById("caller-phone").textContent;

  setStatus("Saving call log…", "status-connecting");

  // The backend mints the recording link from its own call ledger. The browser
  // never constructs it, because the previous build built one carrying the
  // account Auth Token as a query parameter — and then wrote it into a ticket
  // comment, where every agent could read it forever.
  try {
    const result = await backendJson("/sync-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subdomain: zendeskSubdomain,
        ticketId: activeTicketId,
        toNumber: customerPhone,
        duration: callDurationSeconds,
        callDirection,
        notes,
        requesterId: resolvedUser ? resolvedUser.id : null,
        callUuid: lastCallRecord ? lastCallRecord.callUuid : null,
      }),
    });
    if (client) client.invoke("notify", `Call logged to ticket #${result.ticketId} (${result.mode}).`);
    resetToDialer();
    return;
  } catch (err) {
    console.warn("[Vobiz] Backend sync failed, falling back to ZAF:", err);
  }

  // Fallback: write through ZAF with the agent's own session. No recording
  // link, because minting one needs the backend.
  const durationText = formatDuration(callDurationSeconds);
  const body = `[Vobiz Call Log]\n` +
    `Date: ${new Date().toLocaleString()}\n` +
    `Direction: ${callDirection}\n` +
    `Customer: ${resolvedUser ? resolvedUser.name : "Unknown"} (${customerPhone})\n` +
    `Duration: ${durationText}\n` +
    `Notes: ${notes || "No notes provided."}`;

  try {
    if (!client) { console.log(body); resetToDialer(); return; }
    if (activeTicketId) {
      await client.request({
        url: `/api/v2/tickets/${activeTicketId}.json`,
        type: "PUT",
        contentType: "application/json",
        data: JSON.stringify({ ticket: { comment: { body, public: false } } }),
      });
      client.invoke("notify", `Call logged to ticket #${activeTicketId}.`);
    } else {
      const res = await client.request({
        url: "/api/v2/tickets.json",
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify({
          ticket: {
            subject: `Call with ${resolvedUser ? resolvedUser.name : customerPhone}`,
            comment: { body, public: false },
            type: "task",
            status: "solved",
            requester_id: resolvedUser ? resolvedUser.id : null,
          },
        }),
      });
      if (res && res.ticket) client.invoke("notify", `Call logged as ticket #${res.ticket.id}.`);
    }
  } catch (err) {
    console.error("[Vobiz] Could not log the call:", err);
    if (client) client.invoke("notify", "Could not save the call log to Zendesk.", "error");
  }
  resetToDialer();
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function setStatus(text, className) {
  const el = document.getElementById("status");
  if (el) { el.textContent = text; el.className = className || ""; }
}

function setLoginStatus(text) {
  const el = document.getElementById("vobiz-login-status");
  if (el) el.textContent = text;
}

function setCallState(text, className) {
  const el = document.getElementById("call-state-text");
  if (el) { el.textContent = text; el.className = className || ""; }
}

function showView(name) {
  for (const [id, wanted] of [["login-view", "login"], ["dialer-view", "dialer"], ["call-view", "call"]]) {
    const el = document.getElementById(id);
    if (el) el.style.display = name === wanted ? "block" : "none";
  }
}

function showCallView(title, number, state) {
  showView("call");
  document.getElementById("caller-name").textContent = title;
  document.getElementById("caller-phone").textContent = number;
  document.getElementById("call-timer").style.display = "none";
  document.getElementById("call-log-section").style.display = "none";
  const box = document.getElementById("recording-preview-box");
  if (box) box.innerHTML = `<span>🎙️</span><span>Recording enabled — the audio link is attached to the ticket note.</span>`;
  const btn = document.getElementById("hangupbtn");
  if (btn) { btn.textContent = "Hang Up"; btn.className = "btn btn-hangup"; delete btn.dataset.mode; }
  setCallState(state, "call-ringing");
}

function renderNumberOptions(numbers, selected) {
  const select = document.getElementById("from-number-select");
  if (!select) return;
  select.innerHTML = "";
  (numbers || []).forEach(n => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    if (n === selected) opt.selected = true;
    select.appendChild(opt);
  });
}

function setSipRegistered(value) {
  sipRegistered = Boolean(value);
  refreshDialState();
}

function refreshDialState() {
  const btn = document.getElementById("dialbtn");
  if (!btn) return;
  // Never gated on the Endpoint API's sip_registered: that field stays "false"
  // even when registration genuinely succeeded, on every endpoint on the
  // account. JsSIP's own "registered" event is the only reliable signal.
  const ready = accountReady && sipRegistered;
  btn.disabled = !ready;
  const hint = document.getElementById("dial-hint");
  if (!hint) return;
  if (ready) hint.textContent = "";
  else if (!accountReady) hint.textContent = "Sign in to enable calling.";
  else hint.textContent = "Not registered — calling is disabled until the panel reconnects.";
}

function startTimer() {
  callDurationSeconds = 0;
  clearInterval(timerInterval);
  const el = document.getElementById("call-timer");
  el.textContent = "00:00";
  timerInterval = setInterval(() => {
    callDurationSeconds++;
    el.textContent = formatDuration(callDurationSeconds);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function formatDuration(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// Dialpad. DTMF only goes out on a confirmed session — JsSIP throws otherwise.
window.pressKey = function (key) {
  const input = document.getElementById("dialnumber");
  if (currentRTCSession && currentRTCSession.isEstablished && currentRTCSession.isEstablished()) {
    try { currentRTCSession.sendDTMF(key); } catch (err) { console.warn("[Vobiz] DTMF failed:", err); }
    return;
  }
  if (input) input.value += key;
};
