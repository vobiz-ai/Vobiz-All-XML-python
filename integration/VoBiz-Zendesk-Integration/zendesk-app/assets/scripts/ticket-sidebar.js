/** === Vobiz Calling — ticket sidebar ===
 *
 * Two jobs, both small.
 *
 * 1. It gives the top_bar panel its ticket context. A top_bar app has no page
 *    context of its own — client.get("ticket.id") is not available there — so
 *    the panel asks this instance instead. Without this location installed,
 *    calls log as new tickets rather than onto the one the agent is reading.
 *
 * 2. It offers a Call button for the requester's phone. Zendesk's own
 *    click-to-dial event (voice.dialout, relayed by background.js) only fires
 *    on Talk Partner Edition; this path works on every plan.
 */
const client = ZAFClient.init();

let requesterPhone = "";

client.on("app.registered", init);

async function init() {
  try {
    await client.invoke("resize", { width: "100%", height: "140px" });
  } catch { /* non-fatal */ }

  const nameEl = document.getElementById("sidebar-requester");
  const btn = document.getElementById("sidebar-call-btn");
  const hint = document.getElementById("sidebar-hint");

  try {
    const data = await client.get(["ticket.requester.name", "ticket.requester.phone"]);
    const name = data["ticket.requester.name"] || "Requester";
    requesterPhone = (data["ticket.requester.phone"] || "").trim();

    if (requesterPhone) {
      nameEl.textContent = `${name} · ${requesterPhone}`;
      btn.disabled = false;
    } else {
      nameEl.textContent = name;
      hint.textContent = "This requester has no phone number on their profile.";
    }
  } catch (err) {
    console.warn("[Vobiz] Could not read the ticket requester:", err);
    nameEl.textContent = "Could not read the requester.";
  }

  btn.addEventListener("click", onCallClick);
}

async function onCallClick() {
  if (!requesterPhone) return;
  const hint = document.getElementById("sidebar-hint");

  try {
    const ticketData = await client.get("ticket.id");
    const ticketId = ticketData && ticketData["ticket.id"];

    // Hand the number to the top_bar instance, which owns the SIP stack. This
    // is the same event background.js emits, so the panel has one entry point
    // for click-to-dial regardless of which path triggered it.
    const { instances } = await client.get("instances");
    const guid = Object.keys(instances).find(g => instances[g].location === "top_bar");
    if (!guid) {
      hint.textContent = "The Vobiz panel is not open — open it from the top bar first.";
      return;
    }

    const topBar = client.instance(guid);
    await topBar.invoke("popover", "show").catch(() => { /* may already be open */ });
    topBar.trigger("cti.triggerDialer", { number: requesterPhone, ticketId });
    hint.textContent = `Calling ${requesterPhone}…`;
  } catch (err) {
    console.error("[Vobiz] Could not start the call:", err);
    hint.textContent = "Could not reach the Vobiz panel.";
  }
}
