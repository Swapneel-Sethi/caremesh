# CareMesh — Catalyst 2026

CareMesh is an elder-first care coordination platform for the Catalyst problem statement: medication management, appointment tracking, adherence, role-based family/caregiver access, proactive reminder workflows, and an AI-generated daily care brief.

## What is implemented

- Passcode-based role access for elder, family, and caregiver users.
- Elder-controlled care-circle permissions.
- Medication scheduling and adherence tracking.
- Doctor appointment management.
- Missed-dose escalation workflow.
- CarePulse timeline and audit events.
- AI Care Brief adapter for Google Vertex AI / Gemini with a deterministic fallback for local development.
- Email reminder adapter using Resend when configured, with a safe in-app outbox fallback.
- Accessibility-first UI: keyboard focus, reduced-motion support, large touch targets, readable contrast, semantic labels.
- Cloud Run-ready container and health endpoint.

## Demo accounts

These are intentionally non-production demo credentials only:

- Elder: `Meera Rao` / `1234`
- Caregiver: `Priya Shah` / `2468`
- Family: `Arjun Rao` / `1357`

## Local run

```bash
npm start
```

Open `http://localhost:8080`.

## Cloud Run

The container listens on `PORT` / `8080` and binds to `0.0.0.0`, matching the Cloud Run container contract.

Set `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and a production `SESSION_SECRET` in the service. When running on Cloud Run with a service account that can access Vertex AI, the AI adapter uses Google OAuth automatically through the metadata server.

For real outbound email, set `RESEND_API_KEY` and `MAIL_FROM`.
