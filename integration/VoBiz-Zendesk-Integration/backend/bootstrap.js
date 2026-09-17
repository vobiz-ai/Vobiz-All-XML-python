#!/usr/bin/env node
/**
 * One-time setup for the Zendesk calling backend.
 *
 * Creates (or finds) the SIP endpoint the panel registers as, and prints the
 * lines to paste into .env.
 *
 * This exists because of one undocumented behaviour: POST /Endpoint/ REWRITES
 * the username you submit. Send "zendeskagent" and the stored username comes
 * back as "zendeskagent1187694299145202883643". Registering the name you chose
 * fails, and the failure looks like bad credentials. This script always reads
 * the stored username back and reports THAT.
 *
 * Usage:
 *   VOBIZ_AUTH_ID=MA_xxx VOBIZ_AUTH_TOKEN=xxx node bootstrap.js
 *   VOBIZ_AUTH_ID=MA_xxx VOBIZ_AUTH_TOKEN=xxx node bootstrap.js --new
 *
 * --new forces a fresh endpoint instead of reusing an existing "zendesk*" one.
 * Use it to rotate away from the password that was committed in agents.json.
 */
const crypto = require("node:crypto");

const AUTH_ID = process.env.VOBIZ_AUTH_ID;
const AUTH_TOKEN = process.env.VOBIZ_AUTH_TOKEN;
const FORCE_NEW = process.argv.includes("--new");

if (!AUTH_ID || !AUTH_TOKEN) {
  console.error("Set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN in the environment first.\n");
  console.error("  VOBIZ_AUTH_ID=MA_xxxx VOBIZ_AUTH_TOKEN=xxxx node bootstrap.js");
  process.exit(1);
}

const API = `https://api.vobiz.ai/api/v1/Account/${AUTH_ID}`;
const headers = { "X-Auth-ID": AUTH_ID, "X-Auth-Token": AUTH_TOKEN, Accept: "application/json" };

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, body: parsed };
}

(async () => {
  // ── 1. the account must own a number to use as caller ID ──────────────────
  // Lowercase /numbers. /Number/ returns a bare 401 that reads exactly like a
  // credentials problem and is not one.
  const nums = await api("GET", "/numbers?per_page=25");
  if (nums.status >= 400) {
    console.error(`\n✖ Could not read account numbers (HTTP ${nums.status}).`);
    console.error("  Check the Auth ID and Auth Token — accounts are not interchangeable.");
    console.error(`  ${JSON.stringify(nums.body).slice(0, 300)}`);
    process.exit(1);
  }
  const numbers = (nums.body.objects || nums.body.items || []).map(n => n.e164 || n.number).filter(Boolean);
  if (!numbers.length) {
    console.error("\n✖ This account owns no phone numbers. Vobiz refuses a `from` number the account does not own,");
    console.error("  so there is nothing usable as a caller ID. Buy or attach a number first.");
    process.exit(1);
  }
  console.log(`\n✓ Account ${AUTH_ID} owns ${numbers.length} number(s): ${numbers.join(", ")}`);

  // ── 2. find or create the SIP endpoint ────────────────────────────────────
  const eps = await api("GET", "/Endpoint/?limit=100");
  const existing = ((eps.body && eps.body.objects) || []).filter(e => /zendesk/i.test(e.username || e.alias || ""));

  if (existing.length && !FORCE_NEW) {
    console.log(`\n✓ Found ${existing.length} existing Zendesk endpoint(s):`);
    existing.forEach(e => console.log(`    ${e.username}   (alias: ${e.alias || "-"})`));
    console.log("\n  Reusing the first one. Its password is NOT retrievable from the API —");
    console.log("  use the password you set when it was created.");
    console.log("\n  ⚠  The password for zendeskagent1187694299145202883643 was committed to");
    console.log("     git in agents.json. If that is this endpoint, re-run with --new to rotate:");
    console.log("       node bootstrap.js --new\n");
    printEnv(existing[0].username, "<the password you set>", numbers[0]);
    return;
  }

  const password = `Vz${crypto.randomBytes(9).toString("base64url")}!`;
  const submitted = `zendeskagent${Date.now().toString(36)}`;
  console.log(`\n→ Creating SIP endpoint, submitting username "${submitted}"…`);

  const created = await api("POST", "/Endpoint/", {
    username: submitted, password, alias: "Zendesk Calling Agent",
  });
  if (created.status >= 400) {
    console.error(`\n✖ Endpoint creation failed (HTTP ${created.status}): ${JSON.stringify(created.body).slice(0, 300)}`);
    process.exit(1);
  }

  // Read the STORED username back. This is the whole point of the script.
  const endpointId = created.body.endpoint_id || created.body.id;
  const readBack = await api("GET", `/Endpoint/${encodeURIComponent(endpointId)}/`);
  const stored = (readBack.body && readBack.body.username) || created.body.username;

  console.log(`\n✓ Endpoint created.`);
  if (stored !== submitted) {
    console.log(`  ⚠  Vobiz REWROTE the username, as it always does:`);
    console.log(`       submitted: ${submitted}`);
    console.log(`       stored:    ${stored}   <-- register THIS one`);
  }
  printEnv(stored, password, numbers[0]);
})().catch(err => {
  console.error("\n✖ bootstrap failed:", err.message);
  process.exit(1);
});

function printEnv(sipUser, sipPassword, fromNumber) {
  console.log("\n" + "─".repeat(70));
  console.log("Paste these into backend/.env :\n");
  console.log(`VOBIZ_AUTH_ID=${AUTH_ID}`);
  // Deliberately not echoed: this output often gets pasted into a chat, a
  // ticket or a terminal recording. You already have the token — you just
  // passed it in.
  console.log(`VOBIZ_AUTH_TOKEN=${AUTH_TOKEN.slice(0, 4)}…  <-- the token you ran this with, in full`);
  console.log(`VOBIZ_FROM_NUMBER=${fromNumber}`);
  console.log(`VOBIZ_SIP_USER=${sipUser}`);
  console.log(`VOBIZ_SIP_PASSWORD=${sipPassword}`);
  console.log(`SIGNING_SECRET=${crypto.randomBytes(32).toString("hex")}`);
  console.log(`PUBLIC_BASE=   <-- your tunnel URL, filled in at step 3`);
  console.log("─".repeat(70));
  console.log("\nNext: start a tunnel, set PUBLIC_BASE, then `npm start`.\n");
}
