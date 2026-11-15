# CareMesh Architecture

## Runtime

```text
Browser
  │
  ▼
Node HTTP application
  ├── Auth + signed session cookies
  ├── REST-style API routes
  ├── Care domain services
  ├── Google Gemini adapter
  ├── Reminder/email adapter
  └── Data repository
       ├── Firestore REST when GOOGLE_CLOUD_PROJECT is configured
       └── Demo in-memory store for local development
```

## Security

- Passcodes are stored as scrypt hashes with per-user salts.
- Session identity is in an HttpOnly, SameSite cookie signed with HMAC-SHA256.
- Authorization checks run server-side for each protected write.
- No secrets are shipped to the browser.
- Demo data is synthetic and not real medical information.
- Request payloads are validated before persistence.
- Mutations create audit events.
- Reminder dispatch uses a server-side provider adapter.

## Scalability

The domain layer is kept independent from the persistence layer. The local store is only a development fallback; Cloud Run can use Firestore as the shared state layer, allowing stateless app instances. AI inference is isolated behind a provider adapter so the application does not couple product workflows to one model call.
