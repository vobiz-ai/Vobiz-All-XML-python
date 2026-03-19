# Vobiz AI Voice Agent — Full XML Pipeline

A production-grade AI voice agent that handles real phone calls using Vobiz telephony, Deepgram STT, OpenAI GPT-4o-mini, and OpenAI TTS. Supports a full Vobiz XML test pipeline, LLM function calling for live call transfers, SIP trunk integration, and one-click Render deployment.

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Features](#2-features)
3. [Project Structure](#3-project-structure)
4. [XML Test Pipeline](#4-xml-test-pipeline)
5. [LLM Function Calling](#5-llm-function-calling)
6. [SIP Trunk Integration](#6-sip-trunk-integration)
7. [Webhook Reference](#7-webhook-reference)
8. [WebSocket Event Protocol](#8-websocket-event-protocol)
9. [Audio Engineering](#9-audio-engineering)
10. [Setup & Installation](#10-setup--installation)
11. [Running Locally](#11-running-locally)
12. [Deploying to Render](#12-deploying-to-render)
13. [Environment Variables](#13-environment-variables)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Architecture

```
Caller (Phone)
  <--PSTN--> Vobiz Cloud
    <--HTTP/WSS--> server.py  (FastAPI — port 8000)
      |                |
      |                +--> /answer, /sip, /test-*, /transfer-*
      |                     /trunk-webhook (SIP events)
      |
      <--WebSocket proxy--> agent.py  (port 8001)
            |
            |--> Deepgram Nova-2  (real-time STT)
            |--> OpenAI GPT-4o-mini  (LLM + function calling)
            |--> OpenAI TTS-1  (speech synthesis)
            |--> Vobiz Call Transfer API  (live transfer / hangup)
```

**Local dev:** ngrok tunnel is created automatically — no manual setup needed.
**Production (Render/AWS):** `RENDER_EXTERNAL_URL` is used directly — ngrok is skipped.

---

## 2. Features

- **Bidirectional audio streaming** — mu-law 8kHz WebSocket stream with barge-in support
- **Real-time STT** — Deepgram Nova-2 via raw WebSocket, no SDK overhead
- **LLM reasoning** — GPT-4o-mini with OpenAI function calling
- **Live call transfer** — agent says "transferring you" and calls the Vobiz Transfer API mid-conversation
- **Graceful hangup** — agent detects goodbye and terminates the call via API
- **Full XML test pipeline** — IVR menu that demos every Vobiz XML element (Speak, Play, Record, Dial, Stream, Wait, Gather, Hangup, Redirect)
- **SIP trunk endpoints** — `/sip` origination URI and `/trunk-webhook` for CallInitiated/Hangup events
- **Render-ready** — `render.yaml` + `Procfile` included, auto-reads `RENDER_EXTERNAL_URL`
- **Dual-mode** — `SERVER_MODE=stream` for AI agent, `SERVER_MODE=test` for XML test pipeline

---

## 3. Project Structure

```
├── server.py          # FastAPI HTTP server — webhooks, ngrok tunnel, WS proxy
├── agent.py           # WebSocket AI agent — STT/LLM/TTS pipeline + function calling
├── make_call.py       # CLI to trigger outbound calls via Vobiz REST API
├── requirements.txt   # Pinned Python dependencies
├── Procfile           # Render/Heroku start command
├── render.yaml        # Render service configuration
├── .env.example       # All environment variables documented
└── .gitignore
```

| File | Role | Lines |
|---|---|---|
| `server.py` | Orchestration — HTTP webhooks, tunnel, WS proxy, all XML endpoints | ~900 |
| `agent.py` | Intelligence — audio pipeline, LLM, TTS, function calling | ~550 |
| `make_call.py` | Connectivity — Vobiz REST API caller, auto-detect ngrok URL | ~170 |

---

## 4. XML Test Pipeline

Set `SERVER_MODE=test` to activate the IVR test menu. Calling your number plays:

```
"Welcome to the Vobiz XML test suite.
 Press 1 to test Speak.     Press 2 to test Play.
 Press 3 to test Record.    Press 4 to test Dial transfer.
 Press 5 to test AI Stream. Press 6 to test Wait.
 Press 9 to repeat.         Press 0 to hang up."
```

Each option exercises a specific Vobiz XML element:

| Key | Endpoint | XML Elements Used |
|---|---|---|
| 1 | `/test-speak` | `<Speak>` (WOMAN/MAN, en-US/en-GB), `<Redirect>` |
| 2 | `/test-play` | `<Play>` (remote MP3), `<Speak>`, `<Redirect>` |
| 3 | `/test-record` | `<Record>` (15s, beep, star to stop), callback reads duration |
| 4 | `/test-dial` | `<Dial>`, `<Number>`, callerId, action URL |
| 5 | `/test-stream` | `<Stream>` bidirectional (full AI conversation) |
| 6 | `/test-wait` | `<Wait>` (3s basic + silence detection) |
| 0 | `/test-hangup` | `<Speak>`, `<Hangup reason="rejected">` |
| Menu | `/answer` + `/menu-choice` | `<Gather>` DTMF, `<Redirect>` |

Jump directly to any test from CLI:
```bash
python make_call.py --test-endpoint test-speak
python make_call.py --test-endpoint test-record
```

---

## 5. LLM Function Calling

The AI agent has two tools it can invoke mid-conversation:

### `transfer_call`
Triggered when the caller says something like *"transfer me to +91 89398 94913"*.

**Flow:**
1. GPT detects intent → calls `transfer_call(phone_number="+918939894913")`
2. Agent plays announcement via TTS: *"Transferring your call now. Please hold."*
3. Agent POSTs to Vobiz Transfer API: `POST /Account/{id}/Call/{uuid}/`
4. Vobiz interrupts the Stream and fetches `/transfer-to-number?number=+918939894913`
5. That endpoint returns `<Dial><Number>+918939894913</Number></Dial>` XML
6. Caller is connected to the target number

### `end_call`
Triggered when the caller says *"goodbye"*, *"bye"*, *"I'm done"*, etc.

**Flow:**
1. GPT detects farewell → calls `end_call(goodbye_message="Goodbye! Have a great day!")`
2. Agent plays goodbye via TTS
3. Agent calls Vobiz Transfer API pointing to `/agent-hangup`
4. Vobiz fetches that endpoint and gets `<Hangup/>` XML

---

## 6. SIP Trunk Integration

### Inbound URI — `/sip`
Configure in **Vobiz Console → SIP → Inbound Trunks → Inbound URI**:
```
https://your-app.onrender.com/sip
```
When a call arrives on the SIP trunk, Vobiz POSTs here and gets back XML (AI Stream or IVR menu depending on `SERVER_MODE`).

### Trunk Webhook — `/trunk-webhook`
Configure in **Vobiz Console → SIP → Outbound Trunks → Webhook URL**:
```
https://your-app.onrender.com/trunk-webhook
```

Receives JSON events:

**`CallInitiated`** — fires on every outbound attempt:
```json
{
  "Event": "CallInitiated",
  "CallUUID": "uuid",
  "From": "+917971542961",
  "To": "+918939894913",
  "Allowed": true,
  "Reason": ""
}
```

**`Hangup`** — fires when call ends with full CDR:
```json
{
  "Event": "Hangup",
  "Duration": 125,
  "Billsec": 120,
  "Cost": 0.75,
  "Currency": "INR",
  "MOS": 4.2,
  "Jitter": 12
}
```

---

## 7. Webhook Reference

| Method | Endpoint | Trigger | Returns |
|---|---|---|---|
| POST | `/answer` | Call connects (stream mode) | `<Stream>` XML |
| POST | `/answer` | Call connects (test mode) | `<Gather>` IVR menu XML |
| POST | `/sip` | Inbound SIP trunk call | `<Stream>` or IVR XML |
| POST | `/hangup` | Call ends | `200 OK` |
| POST | `/stream-status` | Stream lifecycle events | `200 OK` |
| POST | `/trunk-webhook` | SIP trunk events (JSON) | `{"status":"received"}` |
| POST | `/menu-choice` | DTMF digit from Gather | `<Redirect>` XML |
| POST | `/test-speak` | Test 1 | `<Speak>` XML |
| POST | `/test-play` | Test 2 | `<Play>` XML |
| POST | `/test-record` | Test 3 | `<Record>` XML |
| POST | `/test-record-callback` | Recording done | `<Speak>` + duration |
| POST | `/test-dial` | Test 4 | `<Dial>` XML |
| POST | `/test-dial-status` | Dial completed | `<Speak>` + status |
| POST | `/test-stream` | Test 5 | `<Stream>` XML |
| POST | `/test-wait` | Test 6 | `<Wait>` XML |
| POST | `/test-hangup` | Test 0 | `<Hangup>` XML |
| POST | `/transfer-to-number` | Agent-triggered transfer | `<Dial>` XML |
| POST | `/transfer-complete` | Transfer ended | `<Hangup>` or menu |
| POST | `/agent-hangup` | Agent-triggered hangup | `<Hangup>` XML |
| GET | `/health` | Health check / auto-discover | JSON |
| WS | `/ws` | Vobiz audio stream proxy | Bidirectional proxy |

---

## 8. WebSocket Event Protocol

### Events FROM Vobiz to Agent

```json
{ "event": "start",       "streamId": "s-123", "callId": "c-456" }
{ "event": "media",       "media": { "payload": "<base64-mulaw>", "track": "inbound" } }
{ "event": "playedStream","name": "response-3" }
{ "event": "clearedAudio","streamId": "s-123" }
{ "event": "stop",        "streamId": "s-123" }
```

### Commands FROM Agent to Vobiz

```json
{ "event": "playAudio",  "media": { "contentType": "audio/x-mulaw", "sampleRate": 8000, "payload": "<base64>" } }
{ "event": "clearAudio", "streamId": "s-123" }
{ "event": "checkpoint", "streamId": "s-123", "name": "response-3" }
```

---

## 9. Audio Engineering

### Pipeline: OpenAI TTS → Vobiz

```
OpenAI TTS-1 (PCM 16-bit, 24kHz)
  → resample_linear(24000 → 8000)    3:1 ratio, linear interpolation
  → pcm16_to_mulaw()                 logarithmic 16-bit → 8-bit compression
  → chunk into 160-byte frames       20ms @ 8kHz mono
  → base64 encode
  → playAudio WebSocket event → Vobiz → Caller
```

Vobiz uses **G.711 mu-law (PCMU)** — the global telephony standard. Mu-law uses a logarithmic scale that prioritizes the amplitude range of human speech, halving bandwidth vs linear 16-bit PCM while maintaining perceptual quality on voice calls.

---

## 10. Setup & Installation

**Prerequisites:** Python 3.9+, ngrok (local dev only), API keys for Deepgram and OpenAI, Vobiz account.

```bash
git clone git@github.com:Piyush-sahoo/Vobiz-Call-All-XML.git
cd Vobiz-Call-All-XML

python -m venv venv
source venv/bin/activate       # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# Fill in your API keys in .env
```

---

## 11. Running Locally

```bash
source venv/bin/activate
python server.py
```

The startup banner shows your ngrok URL:
```
============================================================
  Vobiz Voice Agent Server
   Mode:       STREAM
   Public URL: https://xxxx.ngrok-free.app
   Answer URL: https://xxxx.ngrok-free.app/answer
   SIP URI:    https://xxxx.ngrok-free.app/sip
============================================================
```

**Make an outbound call:**
```bash
python make_call.py                              # calls TO_NUMBER from .env
python make_call.py --to +919876543210           # specific number
python make_call.py --test-endpoint test-speak   # jump to specific test
```

**Kill stale processes if ports are busy:**
```bash
pkill -9 ngrok
lsof -ti:8000,8001 | xargs kill -9
```

---

## 12. Deploying to Render

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect `vobiz-ai/Vobiz-All-XML` (or personal repo)
3. Render auto-detects `render.yaml` — click **Apply**
4. Add secret env vars in the Render dashboard (see table below)
5. Click **Deploy** — ~2 minutes

After deploy, set in **Vobiz Console → Applications → Answer URL:**
```
https://vobiz-voice-agent.onrender.com/answer
```

Set in **Vobiz Console → SIP → Inbound Trunks → Inbound URI:**
```
https://vobiz-voice-agent.onrender.com/sip
```

> Render free tier sleeps after 15 min inactivity. Upgrade to $7/month Starter for always-on.

---

## 13. Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | — | OpenAI key (LLM + TTS) |
| `DEEPGRAM_API_KEY` | Yes | — | Deepgram key (STT) |
| `VOBIZ_AUTH_ID` | Yes | — | Vobiz account ID |
| `VOBIZ_AUTH_TOKEN` | Yes | — | Vobiz auth token |
| `FROM_NUMBER` | Yes | — | Your Vobiz DID number (E.164) |
| `TO_NUMBER` | Yes | — | Default destination number |
| `SERVER_MODE` | No | `stream` | `stream` = AI agent, `test` = XML pipeline |
| `PUBLIC_URL` | No | — | Production HTTPS URL (skips ngrok) |
| `AGENT_SYSTEM_PROMPT` | No | built-in | Agent personality |
| `OPENAI_TTS_VOICE` | No | `alloy` | alloy / echo / fable / onyx / nova / shimmer |
| `DIAL_TEST_NUMBER` | No | — | Transfer target for Dial test |
| `TEST_AUDIO_URL` | No | Google beep | MP3/WAV URL for Play test |
| `HTTP_PORT` | No | `8000` | HTTP port (Render injects `PORT` automatically) |
| `AGENT_WS_PORT` | No | `8001` | Internal WebSocket agent port |
| `NGROK_AUTH_TOKEN` | No | — | ngrok token (reads from system config automatically) |

---

## 14. Troubleshooting

| Problem | Fix |
|---|---|
| `Address already in use` | `pkill -9 ngrok && lsof -ti:8000,8001 \| xargs kill -9` |
| `ngrok ERR_NGROK_334` | `pkill -9 ngrok && sleep 1 && python server.py` |
| Agent crashes on startup | Check all required env vars are set in `.env` |
| Dial test `ORIGINATOR_CANCEL` | Verify `FROM_NUMBER` is a DID owned by your Vobiz account and balance is sufficient |
| Transfer not working | Check server logs for `Executing tool: transfer_call` — verify `VOBIZ_AUTH_ID`/`TOKEN` are set |
| Slow AI responses (~2-3s) | Reduce `asyncio.sleep(1.2)` in `agent.py` to `0.8` for faster response |
| Can't hear AI | Verify Answer URL in Vobiz console matches your current ngrok URL |

---

## License

MIT License. Built on [Vobiz](https://vobiz.ai) telephony infrastructure.
