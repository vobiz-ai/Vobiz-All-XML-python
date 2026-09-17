# Vobiz Calling for Zendesk

A WebRTC softphone in the Zendesk top bar. Agents dial from the panel or from a
ticket, talk in the browser, and the call is written back to the ticket with its
duration and a signed link to the recording.

**Verified end to end on 17 September 2026** against account `MA_XXXXXXXX` and
`<subdomain>.zendesk.com`: outbound calls connected and billed (34s and 15s),
recordings delivered, and — unexpectedly — **inbound PSTN → browser connected
too**, 12 seconds billed on the B leg. Inbound had been blocked platform-side for
the previous two weeks; see [`ISSUES.md`](ISSUES.md) #1 before relying on it.

**The browser is the A leg.** This is the one architectural fact everything else
follows from — see [Why the architecture changed](#why-the-architecture-changed).

Read [`../README.md`](../README.md) first if you have not. It is the playbook for
every Vobiz integration and it explains the six platform behaviours that will
otherwise cost you a day each.

---

## What is here

| Path | What it is |
|---|---|
| `zendesk-app/` | The ZAF v2 app — top bar softphone, ticket sidebar, background relay |
| `backend/` | The calling backend. Holds the Vobiz credentials, answers Vobiz webhooks, writes to Zendesk |
| `MARKETPLACE.md` | The Marketplace submission checklist and what is still outstanding |
| `ISSUES.md` | What is blocked, degraded or deliberately unbuilt |
| `PRD.md` | Competitor analysis and product plan (Exotel/Zendesk CTI vs Vobiz) |

---

## Why the architecture changed

The previous build did the intuitive thing: the backend called the Vobiz REST
API to dial the customer, then bridged the agent's browser in with
`<Dial><User>`. **That cannot work.** Routing *into* a registered WebRTC endpoint
is broken platform-side — Vobiz constructs a gateway URI it cannot itself parse
and drops its own INVITE:

```
ERROR: tr_eval_uri(): invalid uri [user@…-webrtc-3.vobiz.ai:7032;…;contact=sip:…]
INVITE|blocking gw: …
```

510 occurrences in 14 days, across multiple accounts, including Vobiz's own SDK.
The customer answers, hears ringback, then "the agent could not be reached".

So the panel now **sends the INVITE itself** and the backend answers with
`<Dial><Number>`:

```
browser ──SIP INVITE──▶ Vobiz ──answer URL──▶ backend /answer
                                                   │
                                            <Dial><Number> ──▶ customer
```

This is what Vobiz's own `rtc-demo` and WebRTC playground do, and it is verified
working.

**Inbound** uses `<Dial><User>`, which is the only way to reach a registered
endpoint and which was blocked platform-side through 16 Sep. It connected on
17 Sep — CDR-confirmed, B leg answered and billed. Whether Vobiz shipped a fix
or something in this configuration avoids the bug is **not established**; treat
inbound as working-but-unproven and re-test before promising it.

---

## Setup

### 1. Prove the account first

Before writing or debugging anything, place a call with
[rtc-demo.vobiz.ai](https://rtc-demo.vobiz.ai/). If that fails, nothing here
will work, and you will spend the day debugging the wrong layer.

### 2. Create the SIP endpoint

```bash
curl -X POST "https://api.vobiz.ai/api/v1/Account/$AUTH_ID/Endpoint/" \
  -H "X-Auth-ID: $AUTH_ID" -H "X-Auth-Token: $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"zendeskagent","password":"<choose one>","alias":"Zendesk Agent"}'
```

> **Vobiz rewrites the username you submit.** Send `zendeskagent` and the stored
> username comes back as something like `zendeskagent1187694299145202883643`.
> **Read the stored `username` out of the response** — that is what must be
> registered and what `VOBIZ_SIP_USER` must contain.

### 3. Configure and run the backend

```bash
cd backend
npm install
cp .env.example .env     # then fill it in
npm start                # listens on :8092
```

Vobiz must reach the backend over **public HTTPS**. Point a tunnel at it and set
`PUBLIC_BASE` to that URL:

```bash
cloudflared tunnel --url http://localhost:8092
```

If you are sharing one ngrok domain across several backends, put
[`../vobiz-calling-backend/router.js`](../vobiz-calling-backend/router.js) in
front — it already routes `/zh/*` here. Two ngrok tunnels on one domain get
*pooled* and round-robined, so webhooks land on the right server about half the
time.

**Check the answer URL is alive before touching any UI.** A dead answer URL
produces the exact symptom people blame on registration:

```bash
curl -s -X POST "$PUBLIC_BASE/answer" \
  -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
# must return <Response>…<Dial>…<Number>  — anything else and the call dies
```

### 4. Bind the endpoint to an application

With the panel signed in, `POST /setup` creates a Vobiz application pointing at
`$PUBLIC_BASE/answer` and binds the SIP endpoint to it:

```bash
curl -X POST "$PUBLIC_BASE/setup" -H "Authorization: Bearer <session token>"
```

> The docs say the binding field is `application`. It is **silently ignored**
> and still returns `202 "changed"`. The field that works is **`app_id`**.

### 5. Run the app

```bash
cd zendesk-app
npm install -g @zendesk/zcli
zcli apps:server
```

Then open Zendesk with `?zcli_apps=true`:

```
https://<subdomain>.zendesk.com/agent/dashboard?zcli_apps=true
```

Zendesk is HTTPS and zcli serves plain HTTP, so **allow insecure content** for
the site (lock icon → Site settings → Insecure content → Allow) or the panel
never loads, silently.

Set the app settings when prompted: **Backend URL** to your tunnel URL,
**Agent identity** to whatever you want this installation called.

### 6. Make a call

Signing in automatically binds the SIP endpoint to a Vobiz application pointing
at `$PUBLIC_BASE/answer`. That binding is not optional: when the browser dials,
Vobiz fetches the answer URL of the application the **endpoint** is bound to.
Unbound, there is no answer URL, no `<Dial>`, and the call dies silently.

Open the panel from the top bar, sign in with the Vobiz Auth ID and Auth Token,
and **wait for the status to read `Ready`**. The Call button stays disabled until
both the account session and the SIP registration are up — that is deliberate,
because dialling with SIP down rings the customer into silence.

---

## Debugging

**Watch `DialBLegUUID`.** Present means the call connected; empty means no B leg
was ever created, whatever the panel says. The backend logs it on every call:

```
DIAL RESULT status=failed ring=true cause=NO_ANSWER bleg=(none — B leg never originated)
  ⚠  failed with no B leg — the destination was unreachable, or the callerId is not owned by this account.
```

The fastest triage, from `../README.md`:

| Symptom | Cause |
|---|---|
| No CDR at all | `422 Session Interval Too Small` — a session-timer problem |
| CDR billed `0s`, empty `DialBLegUUID` | SDP or routing — usually missing STUN |
| Panel reads Ready, calls die instantly | Check the answer URL is alive |
| `OPTIONS 204` with no request after it | A CORS preflight failed — a header is missing from `Access-Control-Allow-Headers` |

Vobiz's Datadog services are the ground truth: `vobiz-registrar` for
registration and routing, `vobiz-outboundsip` for gateway selection and
`blocking gw`, `vobiz-media-server` for the XML you actually returned. The single
most valuable field is `variable_endpoint_disposition`.

**Never gate anything on the Endpoint API's `sip_registered`.** It stays
`"false"` even when registration genuinely succeeded, on every endpoint on the
account. Use JsSIP's `registered` event, which is what this app does.

---

## Security

The Vobiz Auth Token is an account-level API credential. The app holds none: the
agent's credentials are POSTed to the backend once at sign-in, exchanged for an
opaque session token kept in `sessionStorage`, and never stored in the browser.

Recording playback URLs are HMAC-signed with a short expiry. They carry no
account credentials, which matters because these links get written into ticket
comments where every agent can read them indefinitely.

Before production, the items in [`ISSUES.md`](ISSUES.md#issue-2) still need
doing — principally that this backend is bound to a single account and trusts
any agent who knows that account's credentials.
