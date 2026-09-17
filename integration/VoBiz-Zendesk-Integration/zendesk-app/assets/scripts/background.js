/** === Vobiz Calling — background relay ===
 *
 * Zendesk emits `voice.dialout` when an agent clicks a phone number anywhere in
 * Support. This forwards it to the top_bar panel, which owns the SIP stack.
 *
 * `voice.dialout` only fires on Talk Partner Edition. On other plans this
 * listener is simply never called, which is why the ticket sidebar also offers
 * a Call button — the two paths converge on the same `cti.triggerDialer` event.
 */
const client = ZAFClient.init();

async function getTopBarClient() {
  const { instances } = await client.get("instances");
  const guid = Object.keys(instances).find(g => instances[g].location === "top_bar");
  return guid ? client.instance(guid) : null;
}

client.on("voice.dialout", async event => {
  const number = event && event.number;
  if (!number) return;
  console.log("[Vobiz] click-to-dial:", number);

  try {
    const topBar = await getTopBarClient();
    if (!topBar) {
      console.warn("[Vobiz] No top_bar instance found — is preloadPane still set in the manifest?");
      return;
    }
    // Open the panel first so the agent sees the call start. A rejected popover
    // (already open) must not stop the dial from being triggered.
    await topBar.invoke("popover", "show").catch(() => {});
    topBar.trigger("cti.triggerDialer", {
      number,
      userId: event.userId,
      ticketId: event.ticketId,
    });
  } catch (err) {
    console.error("[Vobiz] Could not relay the click-to-dial event:", err);
  }
});

console.log("[Vobiz] background relay ready");
