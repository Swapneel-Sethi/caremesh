# CareMesh: Catalyst 2026

CareMesh is an elder first care coordination platform built for the Catalyst problem statement. It brings together medication management, appointment tracking, adherence, role based family and caregiver access, proactive reminder workflows, and an AI generated daily care brief.

## What is implemented

- Role access through passcodes for elder, family, and caregiver users.
- Care circle permissions controlled by the elder.
- Medication scheduling and adherence tracking.
- Doctor appointment management.
- A workflow that escalates missed doses.
- AI voice medication escalation: CarePulse voice check-in with a simulator inside the app, production calls through Twilio, consent, and calling window controls.
- CarePulse timeline and audit events.
- AI Care Brief adapter for Google Vertex AI / Gemini with a deterministic fallback for local development.
- Email reminder adapter using Resend when configured, with a safe outbox fallback inside the app.
- An interface designed for accessibility, with keyboard focus, reduced motion support, large touch targets, readable contrast, and semantic labels.
- A container and health endpoint ready for Cloud Run.

## Demo accounts

These are demo credentials only. They are not for production use:

- Elder: `Meera Rao` / `1234`
- Caregiver: `Priya Shah` / `2468`
- Family: `Arjun Rao` / `1357`

## Local run

```bash
npm start
```

Open `http://localhost:8080`.

## AI Voice Medication Escalation

CarePulse can follow up an unconfirmed medication dose with a short automated voice check-in. The agent asks one care coordination question, whether the scheduled dose was taken, and records the answer. It never gives dosage instructions, medical advice, diagnoses, or dispatches emergency services.

### Workflow

1. CarePulse detects a dose that is still unconfirmed after the missed dose grace window, or a caregiver starts a check-in manually.
2. The voice agent calls the elder and asks: taken, not taken, or needs help (speech or keypad 1/2/3).
3. Outcomes:
   - `TAKEN` → medication marked taken, no caregiver escalation.
   - `NOT_TAKEN` / `HELP` → medication marked missed, caregiver escalation event and alert.
   - `UNCLEAR` → the agent asks once more, then escalates.
   - `NO_ANSWER` / `BUSY` / `FAILED` → up to `CARE_VOICE_MAX_ATTEMPTS` (default 2) call attempts, then escalates.
4. Every step writes to the CarePulse timeline and a `voiceCalls` record. If the provider cannot start a call, CareMesh still sends the existing caregiver email.

The same state machine serves real Twilio calls, automatic CarePulse detection, and the judge simulator.

### Demo mode (no Twilio required)

Leave `CARE_VOICE_ENABLED=false`. The dashboard and simulator work with the demo store held in memory.

1. `npm start`
2. Sign in as caregiver: `2468`
3. Open **Medications** and press **Simulate AI call** on an unconfirmed dose.
4. Choose the elder's response, for example **I did not take it**.

The medication becomes `Missed`, the timeline shows the AI voice escalation, and the outbox contains the caregiver alert. This takes well under 60 seconds and needs no telephony account.

### Real Twilio mode

1. Use a Twilio account with a caller ID that supports voice. Outbound calls to India require a caller ID from outside India; using an Indian number as `TWILIO_FROM_NUMBER` fails with a provider error. The UI surfaces that setup error instead of retrying.
2. Set the environment variables used only by the server:

   | Variable | Purpose |
   | --- | --- |
   | `CARE_VOICE_ENABLED=true` | Enables real outbound calls |
   | `TWILIO_ACCOUNT_SID` | Twilio account SID |
   | `TWILIO_AUTH_TOKEN` | Twilio auth token (also verifies webhook signatures) |
   | `TWILIO_FROM_NUMBER` | Caller ID with voice support in E.164 format |
   | `CARE_VOICE_PUBLIC_ORIGIN` | Public HTTPS origin for webhooks; derived from Vercel forwarded headers when empty |
   | `CARE_VOICE_LANGUAGE` | TwiML voice language, default `en-IN` |
   | `CARE_VOICE_MAX_ATTEMPTS` | Call attempts before escalation, default `2` |
   | `CARE_VOICE_AUTO_ESCALATE` | Send the caregiver alert when the outcome is anything other than taken, default `true` |
   | `CARE_VOICE_PHONE` | Demo/test recipient number in E.164 format; real recipients use their Firestore record |

3. Webhook endpoints are passed on each outbound call, so no manual Twilio console webhook setup is needed:
   - `POST /api/voice/twiml/start`: first TwiML prompt
   - `POST /api/voice/twiml/response`: speech or keypad result and retry
   - `POST /api/voice/status`: call status callback
4. Record consent on the care recipient in Firestore: `allowVoiceCalls: true`, `voicePhone` in E.164, optional `voiceLanguage`, optional `voiceCallWindow` such as `08:00-21:00`. Calling requires explicit consent; no existing or new user is silently enabled.
5. Trigger a check-in from **Medications** as a caregiver, then confirm the timeline event and Twilio call logs.

The deployment must be publicly reachable by Twilio. Vercel Deployment Protection blocks webhook requests on protected previews; use an unprotected preview or a protection bypass setup when testing real calls.

Reference docs: [TwiML Voice](https://www.twilio.com/docs/voice/twiml), [Gather](https://www.twilio.com/docs/voice/twiml/gather), [webhook signature validation](https://www.twilio.com/docs/usage/webhooks/webhooks-security), [India voice guidelines](https://www.twilio.com/docs/voice/guidelines/india).

### Security and deduplication

- Webhooks are verified with the official `twilio.validateRequest` helper against the exact external URL and the raw form body. There is no custom signature scheme.
- Twilio URLs contain only an opaque 24-byte random session id. Sessions expire after 12 minutes and live at top level `voiceSessions/{sessionId}`; recipient and medication ids stay on the server.
- A Firestore transaction atomically claims a session (`active → processing`), so a replayed webhook or a simulator button clicked twice cannot mutate state twice.
- The existing CarePulse reminder key is claimed atomically (`.create()` on the reminder document) before an automatic call, so the same missed dose cannot start multiple calls or duplicate caregiver alerts.
- Phone numbers are masked in API responses and timeline detail. Twilio credentials remain on the server and are never sent to the browser. No calls are recorded.

### Boundaries

- CareMesh records whether the scheduled medication was *confirmed*; it does not verify ingestion.
- CareMesh is a care coordination tool, not a medical device or diagnostic system.
- Intent classification is deterministic and conservative; anything ambiguous escalates to a human caregiver.
- Twilio provider error mapping is best effort; the email escalation remains the fallback.

## Cloud Run

The container listens on `PORT` / `8080` and binds to `0.0.0.0`, matching the Cloud Run container contract.

Set `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and a production `SESSION_SECRET` in the service. When running on Cloud Run with a service account that can access Vertex AI, the AI adapter uses Google OAuth automatically through the metadata server.

For real outbound email, set `RESEND_API_KEY` and `MAIL_FROM`.
