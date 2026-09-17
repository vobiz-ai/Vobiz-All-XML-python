# Vobiz WebRTC integration playbook

Everything learned building browser calling into a helpdesk, written so the next
integration — Zoom, Zendesk, HubSpot, Pipedrive — does not repeat the same
two-day debug. Verified end to end on 16 September 2026: outbound calls from a
Freshdesk ticket page, two-way audio in the browser, both legs billed.

Read **[The six things that will waste your day](#the-six-things-that-will-waste-your-day)**
first. Everything else is detail.

---

## What is in here

| Folder | What it is |
|---|---|
| `Vobiz-Freshdesk-Calling/` | The Freshdesk CTI panel. The working reference integration |
| `vobiz-calling-backend/` | The calling backend — local Node server, path router, and a stateless Vercel build |
| `Vobiz-RTC-demo/` | Vobiz's official starter kit. Known-good, uses `vobiz-webrtc-sdk` |
| `webrtc-playground-nextjs/` | Vobiz's Next.js playground. The richest reference — recording, transfer, SIP headers |
| `VoBiz-Zendesk-Integration/` | The Zendesk CTI app. Rebuilt on the browser-A-leg architecture, 17 Sep — the second working reference |
| `VoBiz-HubSpot-Integration/`, `VoBiz-Pipedrive-Integration/` | Earlier integrations. **Both still use the dead `<Dial><User>` design from §1** |

When something does not work, **diff against `webrtc-playground-nextjs`**. It is
in production, it handles both call directions, and its comments record failures
that are otherwise invisible.

---

## The six things that will waste your day

### 1. The browser must be the A leg

The intuitive design is: your backend dials the customer over the REST API, then
bridges the agent's browser in with `<Dial><User>`. **Do not build this.**
Routing *into* a registered WebRTC endpoint is broken on the platform — Vobiz
constructs a gateway URI it cannot parse and drops its own INVITE:

```
ERROR: tr_eval_uri(): invalid uri [user@…-webrtc-3.vobiz.ai:7032;…;contact=sip:…@…]
INVITE|blocking gw: …
```

510 occurrences in 14 days, across multiple accounts, **including Vobiz's own
SDK**. The caller hears ringback and nothing else.

Instead, have the browser **send the INVITE itself**, and answer with
`<Dial><Number>`:

```
browser ──SIP INVITE──▶ Vobiz ──answer URL──▶ your backend
                                                 │
                                          <Dial><Number>  ──▶ PSTN
```

This is what `rtc-demo` and the playground do. It works.

**Consequence:** inbound (PSTN → browser) needs `<Dial><User>`, which is the
only way to reach a registered endpoint and which this bug blocked.

**Update, 17 Sep 2026:** inbound connected end to end from the Zendesk panel —
B leg answered, 12s billed, confirmed in the CDR, not just the UI. That is one
success against 510 prior failures, and the cause is not established. Re-test
before relying on it; see `VoBiz-Zendesk-Integration/ISSUES.md` #1.

### 2. Three undocumented client settings

Raw JsSIP against Vobiz does not work out of the box. All three of these are
what `vobiz-webrtc-sdk` sets internally — they are the supported configuration,
not hacks.

```js
new JsSIP.UA({
  sockets: [new JsSIP.WebSocketInterface("wss://registrar.vobiz.ai:5063/")],
  uri: `sip:${username}@registrar.vobiz.ai`,
  password,
  register: true,
  session_timers: false,                 // (a)
  user_agent: "YourApp/1.0.0",           // (c) — no space
});

ua.call(`sip:${e164}@registrar.vobiz.ai`, {
  mediaConstraints: { audio: true, video: false },
  pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },  // (b)
  sessionTimersExpires: 300,
});
```

| | Missing setting | Symptom | How to recognise it |
|---|---|---|---|
| a | `session_timers: false` | `422 Session Interval Too Small` | JsSIP reports the useless cause **"SIP Failure Code"**, and **no CDR exists at all** |
| b | `pcConfig.iceServers` | host-only ICE candidates | **"Incompatible SDP"**, call cancelled ~220 ms in; CDR exists but billed `0s`; Vobiz logs `PrivateIP … Detected in SDP` |
| c | space-free `user_agent` | Vobiz interpolates it unescaped into a URI | JsSIP's default is `JsSIP 3.10.1` |

**The fastest triage:** no CDR at all → 422, a session-timer problem. CDR billed
`0s` with an empty `DialBLegUUID` → SDP or routing.

### 3. `<Dial>` always needs `callerId`

This one cost most of a day, twice, in two different repositories.

Omit `callerId` and Vobiz derives it from the A leg. On an **inbound** call the A
leg is the *caller's* number — which your account does not own — so B-leg
creation is refused outright. The failure is silent and total:

```
no B-leg CDR · no INVITE to the browser · <Dial> just times out
caller hears your voicemail fallback · nothing at all in the softphone
```

Which looks exactly like "the platform won't route to WebRTC endpoints", and is
not. Add `callerId` and the B leg appears and the browser rings.

Use the **number that was dialled**, normalised to E.164 — inbound `To` arrives
as `07971442523`, `917971442523` or `+917971442523` and only the last is usable:

```js
const e164 = raw.startsWith("+") ? raw
  : raw.startsWith("0") && raw.length === 11 ? `+91${raw.slice(1)}`
  : `+${raw.replace(/\D/g, "")}`;
```

Keep the inbound `<Dial>` minimal — this exact shape is known to reach a browser:

```xml
<Dial callerId="+91XXXXXXXXXX"><User>sip:user@registrar.vobiz.ai</User></Dial>
```

In particular `redirect="false"` with no `action` is meaningless: `redirect` only
controls whether XML returned by `action` is executed, so with no `action` it
says nothing.

### 4. Outbound `<Dial>` needs `action` and `redirect="false"`

Without them Vobiz re-fetches the answer URL when `<Dial>` ends and **re-executes
the whole document**, so one call dials repeatedly.

```xml
<Dial callerId="+91XXXXXXXXXX" timeout="30" timeLimit="14400"
      action="https://you.example.com/dial-status" method="POST" redirect="false">
  <Number>91XXXXXXXXXX</Number>
</Dial>
```

Log `DialStatus`, `DialHangupCause` and especially **`DialBLegUUID`** at that
action URL. An empty `DialBLegUUID` means no B leg was ever created — the single
most useful diagnostic in this whole stack.

Also: an `Event=Hangup` request to your answer URL is **not** a request for
instructions. Return an empty `<Response></Response>`; returning `<Dial>`
originates a fresh leg after the call ended.

And `<Record>` must be a **sibling before** `<Dial>`, never nested inside it —
FreeSWITCH rejects the nested form and the caller hears a bogus "Busy".

### 5. Do not trust `sip_registered`

The Endpoint API's `sip_registered` stays `"false"` even when registration
genuinely succeeded. Proven on a fresh endpoint with both stock `jssip` and
`vobiz-jssip` (the fork inside Vobiz's own SDK) — identical results. Every
endpoint on the account reads `"false"`, including the one behind Vobiz's working
public demo. The docs promise it flips. It does not.

**Never gate a Call button on anything derived from it.** Use JsSIP's
`registered` event.

### 6. Check the answer URL is alive before anything else

A dead answer URL produces the *exact* symptom people blame on registration:
customer answers, hears ringback, then "the agent could not be reached". Vobiz
fetched a 404 page instead of XML, so there was no `<Dial>`.

```bash
curl -s -X POST "$ANSWER_URL" -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
# must return <Response><Dial>…  — anything else and the call dies
```

Stale ngrok URLs on Vobiz applications are the usual cause.

---

## Vobiz REST API gotchas

| Thing | Reality |
|---|---|
| Auth | `X-Auth-ID` **and** `X-Auth-Token` headers. Basic auth also works |
| Phone numbers | lowercase `/numbers`. `/Number/` returns a bare `401 Unauthorised` that reads like a credentials problem |
| `POST /Endpoint/` | **Rewrites the username you submit.** Send `fdagent76d74b40`, get `fdagent76d74b899861229925987574740`. Always read the stored `username` back |
| `POST /Endpoint/{id}/` | The docs say `application`; that field is **silently ignored** and still returns `202 "changed"`. The working field is **`app_id`** |
| Accounts | Not interchangeable. An account rejects a `from` number it does not own — check auth *and* DID ownership before debugging code |

Endpoints, applications and numbers all need to line up: the endpoint is bound to
an **application**, and that application's `answer_url` is what Vobiz fetches when
the browser dials.

---

## Debugging with Datadog

Vobiz's platform logs are the ground truth, and they are far more informative
than anything the client sees.

| Service | What it tells you |
|---|---|
| `vobiz-registrar` | REGISTER auth, INVITE arrival, routing decisions, SIP response codes |
| `vobiz-outboundsip` | Gateway selection — and `blocking gw` / `tr_eval_uri(): invalid uri` |
| `vobiz-media-server` | Answer-URL fetches, the XML you returned, full FreeSWITCH channel vars including both SDPs |

```
# did the registration land?
<sip-username>

# follow one INVITE end to end — the SIP Call-ID is the join key
<sip-call-id>

# everything about one call, including SDP
<call-uuid>
```

The single most valuable field is `variable_endpoint_disposition`: `ANSWER` means
it connected, `EARLY MEDIA` followed by `ORIGINATOR_CANCEL` means the browser
rejected the SDP.

---

## Freshworks FDK specifics

Only relevant for Freshdesk/Freshservice, but they cost hours.

```bash
nvm use 24.11.1                                   # FDK 10.1.9 needs it
npm run dev     # fdk run --skip-coverage --skip-validation lint
npm run pack    # tools/pack.sh, not a bare fdk pack
```

- **`--skip-validation lint`** — FDK lints vendored dependencies. JsSIP's 901
  `var`s are 989 errors, and `fdk run` refuses to start because of them.
- **`--skip-coverage`** — instrumenting the 281 KB JsSIP bundle hangs the tab
  with "Page Unresponsive".
- **`fdk pack`** also demands *simulation* coverage from a real browser session.
  That is a Marketplace gate; custom apps do not need it.
- **Packaging workaround:** FDK does not lint **inline** `<script>`. `tools/pack.sh`
  builds a copy with the bundle inlined into `index.html` and packs that.
- **First run** asks for host context at `/system_settings` — organisation domain
  and account URL. Until that is filled in, installation parameters are stored
  under an `undefined` product scope and **the app sees an empty config**. This
  cannot be seeded programmatically; FDK writes it to `.fdk/store.sqlite` through
  the browser flow only.
- **`?dev=true`** must stay on the URL through every navigation.
- Freshdesk is HTTPS and FDK serves plain HTTP, so **allow insecure content** for
  the site or the panel never loads, silently.
- Only **one CTI app** at a time, and Freshcaller cannot be enabled alongside it.

---

## Tunnels and hosting

Vobiz must reach your answer URL over public HTTPS.

**ngrok free** has two traps:
- The **browser interstitial** returns an HTML warning page to anything with a
  browser User-Agent. Send `ngrok-skip-browser-warning` on every request from the
  panel — **and list it in `Access-Control-Allow-Headers`**, or the CORS preflight
  fails and the real request is never sent. An `OPTIONS 204` with no `GET` after
  it is exactly this.
  Server-to-server webhooks from Vobiz are unaffected.
- **One static domain.** Pointing two tunnels at it makes ngrok *pool* them and
  round-robin, so webhooks reach the right server about half the time. If you
  need several backends behind one domain, put a path router in front —
  `vobiz-calling-backend/router.js` does exactly that.

**Vercel** avoids both, but the backend must be **stateless** — serverless
functions do not share memory, so no session `Map`. Also turn off **Deployment
Protection**, or Vobiz's webhooks get a 302 to a login page.

---

## Build order for a new integration

1. **Prove the account first.** Place a call with `rtc-demo` or
   [rtc-demo.vobiz.ai](https://rtc-demo.vobiz.ai/). If that fails, nothing you
   write will work.
2. **Create the endpoint and application over the API**, read back the real
   username, and bind with `app_id`.
3. **Stand up the answer URL** and curl it with `From=sip:…&RouteType=sip`
   before wiring any UI.
4. **Register from the browser**, gate the Call button on JsSIP's `registered`
   event — never on `sip_registered`.
5. **Dial out from the browser** with the three settings from §2.
6. **Watch `DialBLegUUID`.** Present means it connected; empty means it did not,
   whatever the UI says.

Security, before any of this goes near production: the backend holds the account
Auth Token and must never expose it, `agentId` is not proof of identity, SIP
passwords should be short-lived, recording URLs should be signed with an expiry,
and CORS should be scoped to the real origin. The full checklist is in
`Vobiz-Freshdesk-Calling/docs/backend-contract.md`.
