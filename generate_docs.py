"""
generate_docs.py — Compile a single DOCS.md from all Vobiz XML Python examples
================================================================================
Run from the repo root:
    python generate_docs.py

Outputs:
    DOCS.md  — full compiled documentation for all examples
"""

import os

ROOT = os.path.dirname(os.path.abspath(__file__))

EXAMPLES = [
    {
        "id": "01",
        "name": "IVR Menu",
        "repo": "Vobiz-IVR-XML-Python",
        "folder": "01_ivr_menu",
        "tagline": "Multi-level Interactive Voice Response menu with dynamic config and call analytics",
        "use_case": "Company main phone line — route callers to Sales, Support, Billing or an Operator via keypad input. Transfer numbers are updated at runtime via API with no restart needed.",
        "flow": """\
```
/answer  →  Main Menu
              1 → Sales
              │     1 → Products & pricing (spoken)
              │     2 → Request a demo → Hangup
              │     3 → Connect to sales rep → <Dial>
              │     9 → Back to main menu
              2 → Technical Support
              │     1 → API issues → raise ticket option
              │     2 → Call quality → <Dial>
              │     3 → Account access (spoken)
              │     9 → Back
              3 → Billing
              │     1 → Balance info (spoken)
              │     2 → Payment issues → <Dial>
              │     3 → Invoice / GST info (spoken)
              │     9 → Back
              4 → Account Management
              │     1 → Upgrade plan → <Dial>
              │     2 → Update details (spoken)
              │     3 → Cancel → double confirm
              │     9 → Back
              0 → Operator → <Dial>
              9 → Repeat menu
```""",
        "vobiz_webhooks": [
            ("POST", "/answer", "Main IVR menu (set as Answer URL in Vobiz)"),
            ("POST", "/ivr-main-choice", "Routes digit 1-4/0/9 to sub-menu"),
            ("POST", "/ivr-sales", "Sales sub-menu"),
            ("POST", "/ivr-sales-choice", "Routes sales choice"),
            ("POST", "/ivr-support", "Support sub-menu"),
            ("POST", "/ivr-support-choice", "Routes support choice"),
            ("POST", "/ivr-support-ticket", "Raises high priority ticket"),
            ("POST", "/ivr-billing", "Billing sub-menu"),
            ("POST", "/ivr-billing-choice", "Routes billing choice"),
            ("POST", "/ivr-account", "Account management sub-menu"),
            ("POST", "/ivr-account-choice", "Routes account choice"),
            ("POST", "/ivr-account-cancel-confirm", "Double confirms cancellation"),
            ("POST", "/ivr-operator", "Direct transfer to operator"),
            ("POST", "/dial-complete", "Callback after any <Dial> ends"),
            ("POST", "/hangup", "Call ended webhook"),
        ],
        "app_api": [
            ("GET", "/config", "View current department config"),
            (
                "PUT",
                "/config/department/{dept}",
                "Update transfer number / enable-disable",
            ),
            ("GET", "/call-logs", "Full call history"),
            ("GET", "/call-logs/analytics", "Which menu options are pressed most"),
        ],
        "xml_elements": [
            "<Gather inputType=dtmf>",
            "<Speak>",
            "<Redirect>",
            "<Dial><Number>",
            "<Hangup>",
        ],
        "env_vars": [
            ("VOBIZ_AUTH_ID", "Yes", "Vobiz account auth ID"),
            ("VOBIZ_AUTH_TOKEN", "Yes", "Vobiz account auth token"),
            ("FROM_NUMBER", "Yes", "Your Vobiz DID (caller ID for transfers)"),
            ("HTTP_PORT", "No", "Server port (default: 8000)"),
            ("PUBLIC_URL", "No", "Production URL — skips ngrok if set"),
            ("NGROK_AUTH_TOKEN", "No", "ngrok auth token for local dev"),
        ],
        "files": [
            "server.py",
            "menu_config.py",
            "requirements.txt",
            ".env.example",
            "README.md",
        ],
    },
    {
        "id": "02",
        "name": "Voicemail",
        "repo": "Vobiz-Voicemail-XML-Python",
        "folder": "02_voicemail",
        "tagline": "Caller leaves a voice message — recording is saved, retrievable via admin API",
        "use_case": "Business voicemail system. Caller hears a greeting, records a message (up to 60s), presses * to stop. The recording MP3 URL is saved and exposed via a REST API for your admin dashboard.",
        "flow": """\
```
/answer
  └── Greeting: "Please leave a message after the beep. Press * when done."
        └── <Record maxLength=60 finishOnKey=* playBeep=true>
              ├── action     → /voicemail-done  (fires immediately on stop)
              │     └── Saves to VoicemailStore → "Thank you for your message." → Hangup
              └── callbackUrl → /voicemail-file  (fires when MP3 is ready to download)
                    └── Updates record_url in store
```""",
        "vobiz_webhooks": [
            ("POST", "/answer", "Greeting + start recording (set as Answer URL)"),
            (
                "POST",
                "/voicemail-done",
                "Action URL — fires immediately when recording ends",
            ),
            ("POST", "/voicemail-file", "Callback — fires when MP3 file is ready"),
            ("POST", "/hangup", "Call ended webhook"),
        ],
        "app_api": [
            ("GET", "/voicemails", "List all voicemails, newest first"),
            ("GET", "/voicemails/stats", "Total / unread count"),
            ("GET", "/voicemails/{id}", "Single voicemail + MP3 URL"),
            ("PATCH", "/voicemails/{id}/read", "Mark as read"),
            ("DELETE", "/voicemails/{id}", "Delete a voicemail"),
        ],
        "xml_elements": [
            "<Speak>",
            "<Record maxLength action callbackUrl finishOnKey playBeep>",
            "<Hangup>",
        ],
        "env_vars": [
            ("HTTP_PORT", "No", "Server port (default: 8000)"),
            ("PUBLIC_URL", "No", "Production URL — skips ngrok if set"),
            ("NGROK_AUTH_TOKEN", "No", "ngrok auth token for local dev"),
        ],
        "files": [
            "server.py",
            "voicemail_store.py",
            "requirements.txt",
            ".env.example",
            "README.md",
        ],
    },
    {
        "id": "03",
        "name": "OTP Call",
        "repo": "Vobiz-OTP-call-XML-Python",
        "folder": "03_otp_call",
        "tagline": "Generate a 6-digit OTP, call the user, read it digit by digit, verify on your backend",
        "use_case": "Phone-based two-factor authentication. Your app calls POST /send-otp with a phone number. The server generates an OTP, triggers an outbound Vobiz call, and reads the code aloud one digit at a time with 1-second pauses. Your app then calls POST /verify-otp to check what the user typed.",
        "flow": """\
```
Your App
  └── POST /send-otp {"phone": "+91XXXXXXXXXX"}
        └── OTPStore.generate()  → 6-digit OTP, 5-min TTL
        └── Trigger Vobiz outbound call
              └── /answer?phone=%2B91XXXXXXXXXX
                    └── "Your one-time password is:"
                        <Speak>6</Speak> <Wait 1s/>
                        <Speak>1</Speak> <Wait 1s/>  ... (one per digit)
                        "I repeat..." → same again
                        Gather: "Press 1 to hear again"

Your App
  └── POST /verify-otp {"phone": "+91...", "otp": "610389"}
        └── Returns {"verified": true} or {"verified": false, "reason": "..."}
```""",
        "vobiz_webhooks": [
            ("POST", "/answer", "Reads OTP digit by digit (set as Answer URL)"),
            ("POST", "/otp-choice", "Handles press 1 to repeat"),
            ("POST", "/hangup", "Marks OTP as delivered, cleanup"),
        ],
        "app_api": [
            ("POST", "/send-otp", "Generate OTP + trigger outbound call"),
            ("POST", "/verify-otp", "Verify OTP entered by user"),
            ("GET", "/otp-status/{phone}", "Check delivery status"),
        ],
        "xml_elements": [
            "<Speak> (one per digit)",
            "<Wait length=1/>",
            "<Gather inputType=dtmf>",
            "<Hangup>",
        ],
        "env_vars": [
            ("VOBIZ_AUTH_ID", "Yes", "Vobiz account auth ID"),
            ("VOBIZ_AUTH_TOKEN", "Yes", "Vobiz account auth token"),
            ("FROM_NUMBER", "Yes", "Your Vobiz DID (outbound caller ID)"),
            ("HTTP_PORT", "No", "Server port (default: 8000)"),
            ("PUBLIC_URL", "No", "Production URL — skips ngrok if set"),
            ("NGROK_AUTH_TOKEN", "No", "ngrok auth token for local dev"),
        ],
        "files": [
            "server.py",
            "otp_store.py",
            "requirements.txt",
            ".env.example",
            "README.md",
        ],
        "notes": """\
**OTP Store config** (in `otp_store.py`):
| Setting | Default | Description |
|---------|---------|-------------|
| `OTP_LENGTH` | `6` | Number of digits |
| `OTP_EXPIRY_MINS` | `5` | TTL in minutes |
| `MAX_ATTEMPTS` | `3` | Max wrong verify attempts before lockout |

**Verify response reasons:** `verified` · `not_found` · `expired` · `already_used` · `max_attempts` · `invalid`

**Production swap:** Replace `OTPStore` dict with Redis using TTL keys — one key per phone, auto-expire.""",
    },
    {
        "id": "04",
        "name": "Appointment Reminder",
        "repo": "Vobiz-Appointment-reminder-XML-Python",
        "folder": "04_appointment_reminder",
        "tagline": "Outbound reminder call with confirm / reschedule / cancel — outcomes stored per appointment",
        "use_case": "CRM or booking system triggers reminder calls before appointments. The callee presses 1 to confirm, 2 to request reschedule, or 3 to cancel (with a double-confirm step). All outcomes are stored and queryable via API.",
        "flow": """\
```
Your CRM
  └── POST /appointments {"phone":"+91...", "name":"John", "date":"Apr 5", "time":"3 PM"}
        └── AppointmentStore.create() → status: pending
        └── Trigger Vobiz outbound call → status: calling
              └── /answer
                    "Hello John! Reminder: appointment on Apr 5 at 3 PM."
                    Gather: 1=Confirm  2=Reschedule  3=Cancel  9=Repeat
                      ├── 1 → "Confirmed. See you soon!" → Hangup  (status: confirmed)
                      ├── 2 → "Please call us to reschedule." → Hangup (status: reschedule_requested)
                      ├── 3 → "Are you sure?" → Gather 1=Yes/2=No
                      │         ├── 1 → "Cancelled." → Hangup  (status: cancelled)
                      │         └── 2 → Back to reminder
                      └── (no input) → Hangup  (status: no_answer)
```""",
        "vobiz_webhooks": [
            ("POST", "/answer", "Reads reminder, collects DTMF (set as Answer URL)"),
            ("POST", "/appt-choice", "Routes 1=confirm / 2=reschedule / 3=cancel"),
            ("POST", "/appt-cancel-confirm", "Double confirms cancellation"),
            ("POST", "/hangup", "Marks no_answer if no digit was pressed"),
        ],
        "app_api": [
            ("POST", "/appointments", "Schedule a single reminder call"),
            ("POST", "/appointments/bulk", "Schedule multiple at once (JSON array)"),
            ("GET", "/appointments", "List all with outcomes (?status= to filter)"),
            ("GET", "/appointments/{id}", "Single appointment status"),
            ("PATCH", "/appointments/{id}/cancel", "Cancel before call is made"),
            ("GET", "/appointments/stats", "Outcome breakdown by status"),
        ],
        "xml_elements": [
            "<Speak>",
            "<Gather inputType=dtmf numDigits=1>",
            "<Redirect>",
            "<Hangup>",
        ],
        "env_vars": [
            ("VOBIZ_AUTH_ID", "Yes", "Vobiz account auth ID"),
            ("VOBIZ_AUTH_TOKEN", "Yes", "Vobiz account auth token"),
            ("FROM_NUMBER", "Yes", "Your Vobiz DID"),
            ("HTTP_PORT", "No", "Server port (default: 8000)"),
            ("PUBLIC_URL", "No", "Production URL — skips ngrok if set"),
            ("NGROK_AUTH_TOKEN", "No", "ngrok auth token for local dev"),
        ],
        "files": [
            "server.py",
            "appointment_store.py",
            "requirements.txt",
            ".env.example",
            "README.md",
        ],
        "notes": """\
**Status lifecycle:**
```
pending → calling → confirmed
                  → reschedule_requested
                  → cancelled
                  → no_answer
pending → aborted  (cancelled via API before call is made)
```""",
    },
    {
        "id": "05",
        "name": "Call Survey",
        "repo": "Vobiz-Call-Survey-XML-Python",
        "folder": "05_survey",
        "tagline": "Outbound 3-question DTMF survey with results API and CSV export",
        "use_case": "Post-service feedback collection. Your app triggers a survey call. The caller answers 3 questions via keypad. Results are stored, queryable via API, and exportable as CSV for analytics platforms.",
        "flow": """\
```
Your App
  └── POST /surveys/trigger {"phone": "+91XXXXXXXXXX"}
        └── Trigger Vobiz outbound call
              └── /answer → "Quick 3-question survey..."
                    └── Q1: "Rate our service 1-5"
                          └── Q2: "Recommend us? 1=Yes 2=No"
                                └── Q3: "Overall experience? 1=Excellent 2=Good 3=Needs improvement"
                                      └── /survey-done → saved to SurveyStore → "Thank you!"

Your App
  └── GET /surveys/summary
        → {"avg_service_rating": 4.2, "recommend_rate_pct": 78.0, "total_responses": 156}
  └── GET /surveys/export.csv  → download all responses
```""",
        "vobiz_webhooks": [
            ("POST", "/answer", "Survey intro (set as Answer URL)"),
            ("POST", "/survey-q1", "Q1: rate service 1-5"),
            ("POST", "/survey-q1-result", "Saves Q1 → routes to Q2"),
            ("POST", "/survey-q2", "Q2: recommend yes/no"),
            ("POST", "/survey-q2-result", "Saves Q2 → routes to Q3"),
            ("POST", "/survey-q3", "Q3: overall experience"),
            ("POST", "/survey-q3-result", "Saves Q3 → routes to done"),
            ("POST", "/survey-done", "Finalizes survey, logs full result"),
            ("POST", "/hangup", "Cleanup"),
        ],
        "app_api": [
            ("POST", "/surveys/trigger", "Trigger a survey call"),
            ("GET", "/surveys/results", "List all completed responses"),
            ("GET", "/surveys/results/{id}", "Single response detail"),
            ("GET", "/surveys/export.csv", "Download all results as CSV"),
            ("GET", "/surveys/summary", "Aggregated stats"),
        ],
        "xml_elements": [
            "<Speak>",
            "<Gather inputType=dtmf numDigits=1 executionTimeout=10>",
            "<Redirect>",
            "<Hangup>",
        ],
        "env_vars": [
            ("VOBIZ_AUTH_ID", "Yes", "Vobiz account auth ID"),
            ("VOBIZ_AUTH_TOKEN", "Yes", "Vobiz account auth token"),
            ("FROM_NUMBER", "Yes", "Your Vobiz DID"),
            ("HTTP_PORT", "No", "Server port (default: 8000)"),
            ("PUBLIC_URL", "No", "Production URL — skips ngrok if set"),
            ("NGROK_AUTH_TOKEN", "No", "ngrok auth token for local dev"),
        ],
        "files": [
            "server.py",
            "survey_store.py",
            "requirements.txt",
            ".env.example",
            "README.md",
        ],
        "notes": """\
**Questions:**
| # | Question | Input |
|---|----------|-------|
| Q1 | Rate our service | `1`=very poor · `2`=poor · `3`=average · `4`=good · `5`=excellent |
| Q2 | Would you recommend us? | `1`=yes · `2`=no |
| Q3 | Overall experience | `1`=excellent · `2`=good · `3`=needs improvement |

Unanswered questions are skipped gracefully via `executionTimeout` fallback.""",
    },
    {
        "id": "06",
        "name": "Call Queue",
        "repo": "Vobiz-Call-Queue-XML-Python",
        "folder": "06_call_queue",
        "tagline": "Hold music queue with round-robin agent dispatch, retry cycles and voicemail fallback",
        "use_case": "Support call queue. Callers are placed on hold while the server tries available agents in round-robin order. After configurable retry cycles, falls back to voicemail. Agents register themselves via API.",
        "flow": """\
```
Agent App
  └── POST /agents {"number": "+91...", "name": "Raj"}  ← agent comes online

Caller → Vobiz → /answer
  └── "All agents busy. Please hold."
        └── Hold cycle 1
              ├── Play hold music + Wait 20s
              └── Dial next agent (round-robin from QueueStore)
                    ├── Agent answers → connected → /dial-complete → Hangup
                    └── No answer    → Hold cycle 2
                          ├── Play hold music + Wait 20s
                          └── Dial next agent
                                └── (after MAX_WAIT_CYCLES)
                                      └── "Please leave a message." → <Record> → Hangup

Supervisor
  └── GET /queue/status  → {callers_waiting: 3, agents_available: 2}
  └── GET /queue/metrics → {avg_wait_secs: 45, abandonment_rate_pct: 12.5}
```""",
        "vobiz_webhooks": [
            ("POST", "/answer", "Greeting + join queue (set as Answer URL)"),
            ("POST", "/queue-hold", "Play hold music + wait per cycle"),
            ("POST", "/queue-try-agent", "Dial next available agent (round-robin)"),
            (
                "POST",
                "/dial-complete",
                "Agent answered or no-answer — retry or fallback",
            ),
            ("POST", "/queue-voicemail", "Fallback after MAX_WAIT_CYCLES exhausted"),
            ("POST", "/voicemail-done", "Recording saved"),
            ("POST", "/hangup", "Cleanup + abandoned tracking"),
        ],
        "app_api": [
            ("POST", "/agents", "Register agent as available {number, name}"),
            ("DELETE", "/agents/{number}", "Take agent offline"),
            ("GET", "/agents", "List available agents"),
            ("GET", "/queue/status", "Callers waiting + agents available"),
            (
                "GET",
                "/queue/metrics",
                "Avg wait, connected, abandoned, abandonment rate",
            ),
        ],
        "xml_elements": [
            "<Speak>",
            "<Play loop=1>",
            "<Wait length silence>",
            "<Dial><Number>",
            "<Record>",
            "<Redirect>",
            "<Hangup>",
        ],
        "env_vars": [
            ("FROM_NUMBER", "Yes", "Your Vobiz DID"),
            (
                "AGENT_NUMBER",
                "Yes",
                "Default agent number (fallback if no agents registered)",
            ),
            ("HOLD_MUSIC_URL", "No", "URL to MP3/OGG hold music"),
            (
                "MAX_WAIT_CYCLES",
                "No",
                "Max hold attempts before voicemail (default: 3)",
            ),
            ("HOLD_WAIT_SECS", "No", "Seconds of hold per cycle (default: 20)"),
            ("HTTP_PORT", "No", "Server port (default: 8000)"),
            ("PUBLIC_URL", "No", "Production URL — skips ngrok if set"),
            ("NGROK_AUTH_TOKEN", "No", "ngrok auth token for local dev"),
        ],
        "files": [
            "server.py",
            "queue_store.py",
            "requirements.txt",
            ".env.example",
            "README.md",
        ],
    },
    {
        "id": "07",
        "name": "Language Selection",
        "repo": "Vobiz-Language-Selection-XML-Python",
        "folder": "07_language_selection",
        "tagline": "Bilingual IVR with caller language preference memory — repeat callers skip the menu",
        "use_case": "Multi-language customer service. New callers select English or Hindi. Their choice is stored against their phone number. On the next call, the menu is skipped and they go directly to their language. Analytics show language distribution across all callers.",
        "flow": """\
```
New Caller → /answer
  └── PreferenceStore.get(from_number) = None  → show language menu
        "For English press 1. Hindi ke liye 2 dabaein."
          ├── 1 → PreferenceStore.save(phone, "en") → English Menu
          │         1 → Product info (en-US TTS)
          │         2 → Connect to English agent → <Dial>
          │         0 → Back to language selection
          └── 2 → PreferenceStore.save(phone, "hi") → Hindi Menu
                    1 → Product info (hi-IN TTS)
                    2 → Connect to Hindi agent → <Dial>
                    0 → Back

Repeat Caller → /answer
  └── PreferenceStore.get(from_number) = "en"  → skip menu → English Menu directly
```""",
        "vobiz_webhooks": [
            ("POST", "/answer", "Checks preference — skips menu for known callers"),
            ("POST", "/lang-choice", "Saves language choice + routes to sub-menu"),
            ("POST", "/english-menu", "English sub-menu"),
            ("POST", "/english-choice", "Routes English choices"),
            ("POST", "/hindi-menu", "Hindi sub-menu"),
            ("POST", "/hindi-choice", "Routes Hindi choices"),
            ("POST", "/dial-complete", "Shared callback after any Dial"),
            ("POST", "/hangup", "Call ended webhook"),
        ],
        "app_api": [
            ("GET", "/preferences", "List all stored caller language preferences"),
            (
                "GET",
                "/preferences/analytics",
                "Language distribution across all callers",
            ),
            (
                "GET",
                "/preferences/{phone}",
                "Get stored language for a specific caller",
            ),
            (
                "DELETE",
                "/preferences/{phone}",
                "Reset preference — caller sees menu again",
            ),
        ],
        "xml_elements": [
            "<Speak language=en-US>",
            "<Speak language=hi-IN>",
            "<Gather inputType=dtmf>",
            "<Redirect>",
            "<Dial><Number>",
            "<Hangup>",
        ],
        "env_vars": [
            ("FROM_NUMBER", "Yes", "Your Vobiz DID"),
            ("AGENT_NUMBER", "Yes", "Number to transfer to for agent calls"),
            ("HTTP_PORT", "No", "Server port (default: 8000)"),
            ("PUBLIC_URL", "No", "Production URL — skips ngrok if set"),
            ("NGROK_AUTH_TOKEN", "No", "ngrok auth token for local dev"),
        ],
        "files": [
            "server.py",
            "preference_store.py",
            "requirements.txt",
            ".env.example",
            "README.md",
        ],
        "notes": """\
**Supported Languages:**
| Code | Label | TTS Code |
|------|-------|----------|
| `en` | English | `en-US` |
| `hi` | Hindi | `hi-IN` |

To add a new language (e.g. Tamil), create `/tamil-menu` and `/tamil-choice` routes using `<Speak language="ta-IN">`.""",
    },
    {
        "id": "08",
        "name": "Number Capture",
        "repo": "Vobiz-Number-Capture-XML-Python",
        "folder": "08_number_capture",
        "tagline": "Collect a caller's phone number via keypad (DTMF + # terminator) with validation and duplicate detection",
        "use_case": "Lead capture or contact registration. The caller enters a 10-digit number followed by #, hears it read back, and confirms. Captured numbers are stored with duplicate detection and exportable as CSV for CRM import.",
        "flow": """\
```
Caller → /answer
  └── "Enter your 10-digit number followed by #. You have 15 seconds."
        └── <Gather finishOnKey="#" timeout="15">
              ├── Invalid / empty → "Not a valid number. Try again." → /answer
              └── Valid (10 digits) → Read back: "You entered: 9, 8, 7, 6..."
                    └── Gather: 1=Confirm  2=Re-enter  3=Cancel
                          ├── 1 → LeadStore.save() → "Number registered!" → Hangup
                          ├── 2 → Back to /answer
                          └── 3 → "Cancelled." → Hangup

Your App
  └── GET /leads/export.csv   → CRM import
  └── GET /leads/analytics    → {total: 234, unique: 198, duplicates: 36, today: 12}
```""",
        "vobiz_webhooks": [
            ("POST", "/answer", "Prompts for number + # (set as Answer URL)"),
            ("POST", "/number-received", "Validates + reads back digit by digit"),
            ("POST", "/number-confirm", "1=confirm / 2=re-enter / 3=cancel"),
            ("POST", "/number-received-repeat", "Re-reads number on invalid key press"),
            ("POST", "/hangup", "Cleanup"),
        ],
        "app_api": [
            ("GET", "/leads", "List all captured numbers"),
            ("GET", "/leads/export.csv", "Download as CSV"),
            ("GET", "/leads/analytics", "Total, unique, duplicates, today count"),
            ("GET", "/leads/{id}", "Single lead detail"),
            ("DELETE", "/leads/{id}", "Remove a lead"),
        ],
        "xml_elements": [
            "<Speak>",
            "<Gather inputType=dtmf finishOnKey=# timeout=15>",
            "<Redirect>",
            "<Hangup>",
        ],
        "env_vars": [
            ("HTTP_PORT", "No", "Server port (default: 8000)"),
            ("PUBLIC_URL", "No", "Production URL — skips ngrok if set"),
            ("NGROK_AUTH_TOKEN", "No", "ngrok auth token for local dev"),
        ],
        "files": [
            "server.py",
            "lead_store.py",
            "requirements.txt",
            ".env.example",
            "README.md",
        ],
        "notes": """\
**Validation** (edit `_is_valid()` in `server.py` to change):
```python
def _is_valid(number: str) -> bool:
    return bool(re.fullmatch(r"\\d{10}", number))   # 10-digit Indian mobile
```

**Duplicate detection:** Re-submitted numbers are saved with `is_duplicate: true` — they are not rejected, just flagged.""",
    },
]


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def toc_anchor(name: str) -> str:
    """Convert display name to GitHub markdown anchor."""
    return (
        name.lower()
        .replace(" ", "-")
        .replace("/", "")
        .replace("(", "")
        .replace(")", "")
    )


def build_table(headers: list, rows: list) -> str:
    lines = ["| " + " | ".join(headers) + " |"]
    lines.append("| " + " | ".join(["---"] * len(headers)) + " |")
    for row in rows:
        lines.append("| " + " | ".join(str(c) for c in row) + " |")
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# Build DOCS.md
# ─────────────────────────────────────────────────────────────────────────────


def generate_docs() -> str:
    lines = []

    # ── Header ────────────────────────────────────────────────────────────────
    lines.append("# Vobiz XML Python Examples — Documentation\n")
    lines.append(
        "> Auto-generated by `generate_docs.py`. Run `python generate_docs.py` to regenerate.\n"
    )
    lines.append("---\n")

    # ── Overview ──────────────────────────────────────────────────────────────
    lines.append("## Overview\n")
    lines.append(
        "A collection of real-world Vobiz XML call flow examples built with Python and FastAPI. "
        "Each example is a standalone server with:\n"
    )
    lines.append("- **Vobiz webhook layer** — XML responses that control the call flow")
    lines.append(
        "- **Admin / trigger REST API** — your app calls these to start calls or read results"
    )
    lines.append(
        "- **In-memory store** — clean interface, easy to swap to Redis or a database in production"
    )
    lines.append(
        "- **`.env.example`**, **`requirements.txt`**, **`README.md`** per example\n"
    )

    # ── Quick start ───────────────────────────────────────────────────────────
    lines.append("## Quick Start\n")
    lines.append("```bash")
    lines.append("# 1. Clone the example repo you want")
    lines.append("git clone git@github.com:Piyush-sahoo/<repo-name>.git")
    lines.append("cd <repo-name>\n")
    lines.append("# 2. Create .env")
    lines.append("cp .env.example .env")
    lines.append("# fill in VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, FROM_NUMBER etc.\n")
    lines.append("# 3. Install dependencies")
    lines.append("pip install -r requirements.txt\n")
    lines.append("# 4. Run")
    lines.append("python server.py")
    lines.append(
        "# Server prints Answer URL and Hangup URL on startup — paste into Vobiz console"
    )
    lines.append("```\n")

    # ── Table of contents ─────────────────────────────────────────────────────
    lines.append("## Table of Contents\n")
    for ex in EXAMPLES:
        anchor = toc_anchor(ex["name"])
        lines.append(f"- [{ex['id']}. {ex['name']}](#{anchor})")
    lines.append("")

    # ── All examples summary table ────────────────────────────────────────────
    lines.append("## Examples at a Glance\n")
    rows = []
    for ex in EXAMPLES:
        rows.append(
            [
                f"**{ex['id']}**",
                f"[{ex['name']}](https://github.com/vobiz-ai/{ex['repo']})",
                ex["tagline"],
            ]
        )
    lines.append(build_table(["#", "Example", "What it does"], rows))
    lines.append("")

    # ── Per-example sections ──────────────────────────────────────────────────
    lines.append("---\n")
    for ex in EXAMPLES:
        lines.append(f"## {ex['name']}\n")
        lines.append(f"> {ex['tagline']}\n")

        # Repos
        lines.append("**Repos:**")
        lines.append(
            f"- Work:     [vobiz-ai/{ex['repo']}](https://github.com/vobiz-ai/{ex['repo']})"
        )
        lines.append(
            f"- Personal: [Piyush-sahoo/{ex['repo']}](https://github.com/Piyush-sahoo/{ex['repo']})\n"
        )

        # Use case
        lines.append("### Use Case\n")
        lines.append(ex["use_case"] + "\n")

        # Flow
        lines.append("### Call Flow\n")
        lines.append(ex["flow"] + "\n")

        # Files
        lines.append("### Files\n")
        for f in ex["files"]:
            lines.append(f"- `{f}`")
        lines.append("")

        # Vobiz webhooks
        lines.append("### Vobiz Webhooks\n")
        lines.append(
            build_table(
                ["Method", "Path", "Description"],
                [(m, f"`{p}`", d) for m, p, d in ex["vobiz_webhooks"]],
            )
        )
        lines.append("")

        # App API
        if ex.get("app_api"):
            lines.append("### Your App API\n")
            lines.append(
                build_table(
                    ["Method", "Path", "Description"],
                    [(m, f"`{p}`", d) for m, p, d in ex["app_api"]],
                )
            )
            lines.append("")

        # XML elements
        lines.append("### XML Elements Used\n")
        lines.append(", ".join(f"`{x}`" for x in ex["xml_elements"]) + "\n")

        # Env vars
        lines.append("### Environment Variables\n")
        lines.append(
            build_table(["Variable", "Required", "Description"], ex["env_vars"])
        )
        lines.append("")

        # Setup
        lines.append("### Setup\n")
        lines.append("```bash")
        lines.append(f"git clone git@github.com:Piyush-sahoo/{ex['repo']}.git")
        lines.append(f"cd {ex['repo']}")
        lines.append("cp .env.example .env")
        lines.append("pip install -r requirements.txt")
        lines.append("python server.py")
        lines.append("```\n")

        # Notes
        if ex.get("notes"):
            lines.append("### Notes\n")
            lines.append(ex["notes"] + "\n")

        lines.append("---\n")

    # ── Common architecture ───────────────────────────────────────────────────
    lines.append("## Common Architecture\n")
    lines.append("Every example follows the same 3-layer pattern:\n")
    lines.append("```")
    lines.append("┌─────────────────────────────────┐")
    lines.append("│         Your App / CRM           │  calls trigger + result APIs")
    lines.append("│  POST /send-otp                  │")
    lines.append("│  GET  /surveys/summary           │")
    lines.append("└──────────────┬──────────────────┘")
    lines.append("               │")
    lines.append("┌──────────────▼──────────────────┐")
    lines.append(
        "│         server.py                │  FastAPI — both layers in one process"
    )
    lines.append("│  ┌─────────────────────────┐     │")
    lines.append("│  │   Trigger / Admin API   │     │  ← your app calls these")
    lines.append("│  └─────────────────────────┘     │")
    lines.append("│  ┌─────────────────────────┐     │")
    lines.append("│  │   Vobiz XML Webhooks    │     │  ← Vobiz calls these")
    lines.append("│  │   /answer  /hangup ...  │     │")
    lines.append("│  └─────────────────────────┘     │")
    lines.append("└──────────────┬──────────────────┘")
    lines.append("               │")
    lines.append("┌──────────────▼──────────────────┐")
    lines.append("│       *_store.py                 │  In-memory store")
    lines.append(
        "│   swap to Redis / Postgres       │  — same interface, just change the class"
    )
    lines.append("└─────────────────────────────────┘")
    lines.append("```\n")

    # ── Production notes ──────────────────────────────────────────────────────
    lines.append("## Production Notes\n")
    lines.append("| Concern | Local Dev | Production |")
    lines.append("|---------|-----------|------------|")
    lines.append(
        "| Public URL | ngrok (auto-start) | Set `PUBLIC_URL=https://your-server:8000` |"
    )
    lines.append(
        "| Storage | In-memory dict | Replace `*_store.py` with Redis / Postgres |"
    )
    lines.append(
        "| Server | `uvicorn` single process | `uvicorn --workers 4` + Redis for shared state |"
    )
    lines.append(
        "| Secrets | `.env` file | Env vars injected at runtime (no `.env` file) |"
    )
    lines.append("| Deployment | `python server.py` | Docker + `docker-compose.yml` |")
    lines.append("")

    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# Write output
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    output_path = os.path.join(ROOT, "DOCS.md")
    content = generate_docs()
    with open(output_path, "w") as f:
        f.write(content)
    print(f"Generated: {output_path}")
    print(f"Lines:     {content.count(chr(10))}")
    print(f"Size:      {len(content):,} bytes")
