# Open issues

Everything blocked, degraded or deliberately unbuilt in the Vobiz × Zendesk
integration.

> **This repository is public.** Every account identifier, endpoint username,
> phone number, backend hostname, call UUID and credential here is deliberately
> a placeholder. Please keep it that way — one of the issues below is a backend
> that used to serve SIP passwords to anyone who knew its URL.

Last reviewed: **17 September 2026**, after a verified end-to-end test on a live account.

| # | Issue | Severity | Owner | Blocks? |
|---|---|---|---|---|
| [1](#issue-1--inbound-routing-into-a-webrtc-endpoint--was-blocked-observed-working-17-sep) | Inbound routing into a WebRTC endpoint | ~~P0~~ → **watch** | Vobiz platform | **No — observed working 17 Sep** |
| [2](#issue-2--the-backend-is-single-account-and-trusts-anyone-with-the-credentials) | Backend is single-account and has no per-agent identity | **P0** for production | Us | **Yes for launch** |
| [3](#issue-3--a-per-customer-backend-url-is-not-a-marketplace-shape) | A per-customer `backend_url` is not a Marketplace shape | **P1** | Product | **Yes for Marketplace** |
| [4](#issue-4--click-to-dial-needs-talk-partner-edition) | Click-to-dial needs Talk Partner Edition | P2 | Zendesk plan | No — sidebar path works |
| [5](#issue-5--screenshots-for-the-listing-do-not-exist-yet) | Listing screenshots do not exist | P2 | Us | Yes for Marketplace |

**Fixed in the 17 Sep rewrite:** the dead `<Dial><User>` architecture · the three
missing JsSIP settings · `<Dial>` with no `action` · no `Event=Hangup` guard ·
SIP passwords served unauthenticated · the account Auth Token written into
ticket comments · `Access-Control-Allow-Origin: *` · a hardcoded dead tunnel
fallback · the wrong top-bar icon filename.

---

## Issue #1 — Inbound routing into a WebRTC endpoint — was blocked, observed working 17 Sep

| | |
|---|---|
| **Severity** | ~~P0~~ → **watch**. Verified working once; not yet trusted |
| **Component** | The Vobiz platform |
| **Status** | **Inbound connected end to end on 17 Sep 2026**, contradicting 14 days of prior evidence |

### What was wrong

`<Dial><User>` to a registered WebRTC endpoint never reached the browser.
`vobiz-outboundsip` built a gateway URI it could not itself parse and dropped
the INVITE:

```
ERROR: tr_eval_uri(): invalid uri
[<username>@prod-voice-ap-south-1-webrtc-3.vobiz.ai:7032;…;contact=sip:…;transport=ws;]
INVITE|blocking gw: …
```

**510 blocked INVITEs in 14 days**, across accounts, including
`user_agent=vobiz-webrtc-sdk 1.0.3` — Vobiz's own SDK. The customer answered,
heard ringback, then "the agent could not be reached".

### What happened on 17 Sep

A real PSTN call to `+91XXXXXXXXXX` reached the panel and connected. From the
Vobiz CDRs, not from the UI:

```
A leg  <A-leg>   +91XXXXXXXXXX -> +91XXXXXXXXXX   inbound    bill 13s   Normal Hangup
B leg  <B-leg>   +91XXXXXXXXXX -> sip:zendeskagent<suffix>…@registrar.vobiz.ai
                   answer_time 08:50:05   bill_duration 12s   Normal Hangup
```

The B leg was created, **answered**, and billed 12 seconds. That is the whole
thing that used to be impossible.

### Why — not established

Two candidates, and the evidence does not separate them:

1. **Vobiz fixed the platform bug.** The last confirmed failure was 16 Sep; this
   worked on the 17th. A one-day gap makes this entirely plausible.
2. **The space-free `user_agent`.** JsSIP's default is `JsSIP 3.10.1`, and Vobiz
   interpolates the registration's User-Agent unescaped into that gateway URI,
   so the space makes it unparseable. The old Zendesk build never set
   `user_agent`; this one sets `VobizZendeskCalling/2.0.0`.

Against (2): the Freshdesk app also sets a space-free User-Agent
(`VobizFreshdeskCalling/1.0.0`) and still recorded inbound as blocked on 16 Sep.
So the space alone does not explain it, and its ISSUES.md concluded the URI was
malformed regardless.

**Do not write either cause down as fact.** What is established is that inbound
connected with this configuration on this date.

### What to do

- Re-test inbound before promising it to anyone. One success is not a fix.
- Ask Vobiz directly whether something shipped on 16–17 Sep in `vobiz-outboundsip`.
- Check whether `tr_eval_uri(): invalid uri` is still appearing in Datadog at all.
- Re-test the Freshdesk app's inbound path — if it works now too, that is strong
  evidence for (1), and its ISSUES.md #1 needs the same revision.

## Issue #2 — The backend is single-account and trusts anyone with the credentials

| | |
|---|---|
| **Severity** | **P0** before production |
| **Status** | Open. Much better than it was, still not right |

The 17 Sep rewrite closed the worst of it: SIP passwords are behind a session,
recording URLs are HMAC-signed and short-lived, the account Auth Token never
reaches the browser, and CORS is scoped to Zendesk origins.

What remains:

- **The backend is bound to one Vobiz account** through `.env`. Every agent who
  signs in shares the same SIP endpoint, so two agents on the same install would
  register as the same endpoint and race for calls. Real multi-agent use needs
  an endpoint per agent and a real identity store.
- **`agentId` is still self-asserted.** It picks a label, not an identity. The
  session token is what actually authorises, which is correct, but any agent who
  knows the account's Auth ID and Token can mint one.
- **SIP passwords are long-lived.** They should be short-lived credentials minted
  per session.
- **Auth tokens are compared in plaintext and held in memory.** Store hashed,
  never log them, and put sessions somewhere that survives a restart.

The `backend-contract.md` security checklist in
[`../Vobiz-Freshdesk-Calling/docs/backend-contract.md`](../Vobiz-Freshdesk-Calling/docs/backend-contract.md)
applies here unchanged.

---

## Issue #3 — A per-customer `backend_url` is not a Marketplace shape

| | |
|---|---|
| **Severity** | **P1** — blocks a public listing, not a private install |
| **Owner** | Product, not engineering |

A Marketplace app cannot reasonably ask every customer to deploy and host a Node
service. Either Vobiz hosts one multi-tenant backend at a stable domain and the
`backend_url` setting disappears, or this lists as an **integration app**
(`marketingOnly: true`) that is discoverable but not installable.

See [`MARKETPLACE.md`](MARKETPLACE.md#the-decision-that-comes-before-any-of-this).
This is the first decision to make, because it changes what the backend has to be.

---

## Issue #4 — Click-to-dial needs Talk Partner Edition

| | |
|---|---|
| **Severity** | P2 — there is a working path on every plan |

Zendesk's `voice.dialout` event, which fires when an agent clicks a phone number
anywhere in Support, is a **Talk Partner Edition** feature. On other plans
`background.js` is simply never called and clicking a number does nothing.

Mitigated: the ticket sidebar offers a **Call requester** button that reads
`ticket.requester.phone` and triggers the same `cti.triggerDialer` event the
background relay does. Both paths converge on one entry point in the panel.

Still worth knowing: the sidebar button only reads the *requester's* phone. A
number written in the ticket body is not clickable without Talk Partner Edition.

---

## Issue #5 — Screenshots for the listing do not exist yet

| | |
|---|---|
| **Severity** | P2 — blocks submission, trivial once the app runs live |

Marketplace requires three screenshots at **1024×768**, full bleed, no padding:
`assets/screenshot-0.png` through `-2.png`. These have to be genuine captures of
the working panel — the dialer, an active call, and a call logged onto a ticket.
Logos are generated reproducibly by `zendesk-app/tools/make-brand-assets.py`;
screenshots cannot be, and should not be faked.
