# Testing this in Zendesk

Six steps. Steps 1–3 are one-time; after that testing is `npm start` + `zcli apps:server`.

Nothing is currently running and `backend/.env` is empty — the old build took
credentials from the browser on every call, which is exactly what was removed,
so the backend needs its own config for the first time.

---

## 1. Create the SIP endpoint and fill in `.env`

```bash
cd backend
npm install

VOBIZ_AUTH_ID=MA_xxxxxxxx VOBIZ_AUTH_TOKEN=xxxxxxxx node bootstrap.js
```

Use the account that actually works — the one with balance that owns the DID.
`bootstrap.js` checks the account owns a number, creates the SIP endpoint,
**reads the stored username back** (Vobiz rewrites the one you submit), and
prints the exact `.env` lines to paste in.

If it finds the old `zendeskagent1187694299…` endpoint it will offer to reuse
it. **Rotate instead** — that password was committed to git in `agents.json`:

```bash
VOBIZ_AUTH_ID=… VOBIZ_AUTH_TOKEN=… node bootstrap.js --new
```

## 2. Expose the backend over public HTTPS

Vobiz has to reach `/answer`, `/dial-status` and `/recording-ready`.

```bash
cloudflared tunnel --url http://localhost:8092
```

Put the resulting `https://…` into `PUBLIC_BASE` in `.env`.

> If you are running several Vobiz backends behind one ngrok domain, use
> `../vobiz-calling-backend/router.js` — it already maps `/zh/*` here, and
> `PUBLIC_BASE` becomes `https://<domain>/zh`. Two ngrok tunnels on one domain
> get pooled and round-robined, so webhooks land correctly about half the time.

## 3. Start the backend and prove the answer URL is alive

```bash
npm start     # :8092
```

**Do this before touching any UI.** A dead answer URL produces the exact symptom
people blame on registration — the customer answers, hears ringback, then "the
agent could not be reached":

```bash
curl -s -X POST "$PUBLIC_BASE/answer" \
  -d "From=sip:x@registrar.vobiz.ai&To=91XXXXXXXXXX&RouteType=sip"
```

You must get back `<Response>` containing `<Dial …><Number>`. Anything else —
an ngrok interstitial, a 404 page, a tunnel error — and every call will die.

Also check `curl -s localhost:8092/health` shows your account, caller ID, SIP
user and `publicBase`.

## 4. Run the app

```bash
cd ../zendesk-app
zcli apps:server .
```

zcli 2.0.0 is already installed. `apps:server` needs **no login** — it just
prompts for the settings on each run. (`apps:validate` and `apps:package` *do*
need `zcli login`; you only need those at packaging time, not to test.)

Answer the prompts:

| Setting | Value |
|---|---|
| `backend_url` | your tunnel URL from step 2 |
| `agent_id` | anything, e.g. `test-agent` |
| `registrar_url` | press enter for the default |

It serves on `http://localhost:4567`.

## 5. Open Zendesk

```
https://<subdomain>.zendesk.com/agent/dashboard?zcli_apps=true
```

Two browser things that fail **silently** if you skip them:

- **Allow insecure content.** Zendesk is HTTPS and zcli serves plain HTTP. Lock
  icon → Site settings → Insecure content → **Allow**, then reload. Without it
  the panel never loads and there is no error.
- **Allow the microphone** when prompted. Denied, calls ring and connect to
  silence.
- Keep `?zcli_apps=true` on the URL through every navigation.

## 6. Make a call

1. Click the Vobiz icon in the top bar.
2. Sign in with the Vobiz Auth ID and Auth Token. On success the panel
   automatically binds your SIP endpoint to a Vobiz application pointing at
   `$PUBLIC_BASE/answer` — watch the browser console for
   `endpoint … bound to app …`.
3. **Wait for the status to read `Ready`.** The Call button stays disabled until
   both the account session and the SIP registration are up. That is deliberate.
4. Type a real number and hit Call. Your phone rings; answer it.
5. Hang up, type a note, **Save Call Log**. Open the ticket — the note should be
   there with duration and a recording link.

Also test the sidebar path: open a ticket whose requester has a phone number and
click **Call requester** in the Vobiz sidebar.

---

## Reading the result

The backend log is the honest account of what happened:

```
WEBHOOK POST /answer {"From":"sip:zendeskagent…","To":"91XXXXXXXXXX","RouteType":"sip"}
  -> browser is the A leg, dialling out to 91XXXXXXXXXX as +91…
DIAL RESULT status=completed ring=true cause=NORMAL_CLEARING bleg=abc-123 dur=42
RECORDING READY call=… id=… reason=…
```

**`DialBLegUUID` is the single most useful field in this stack.** Present means
it connected. Empty means no B leg was ever created, whatever the panel showed.

| What you see | What it means |
|---|---|
| No `WEBHOOK /answer` line at all | The endpoint is not bound to the application, or `PUBLIC_BASE` is wrong. Sign out and back in to re-run `/setup` |
| `bleg=(none…)` | Destination unreachable, or the caller ID is not owned by this account |
| Panel stuck on "Connecting…" | Backend unreachable — check `backend_url` and that insecure content is allowed |
| `Registration failed` | Wrong `VOBIZ_SIP_USER` — you probably used the username you submitted, not the one Vobiz stored |
| No CDR at all in Vobiz | `422 Session Interval Too Small` — a session-timer problem |
| CDR billed `0s` | SDP/ICE — check the browser console for the STUN candidates |
| `OPTIONS 204` with no request after it | CORS preflight failed — a header is missing from `Access-Control-Allow-Headers` |

Ignore the Endpoint API's `sip_registered` entirely. It reads `"false"` even
when registration genuinely succeeded, on every endpoint on the account.

## What will not work

**Inbound PSTN → browser.** `<Dial><User>` into a registered WebRTC endpoint is
blocked platform-side (`ISSUES.md` #1). The customer will hear ringback then
"the agent could not be reached", and nothing will ring in the panel. The code
path is correct and starts working the day Vobiz fixes its gateway URI — do not
spend time debugging it.
