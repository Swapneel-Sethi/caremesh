# Firebase foundation

CareMesh uses Firebase for **Authentication** and **Firestore** only. Vercel remains the
application host; Firebase Hosting is intentionally not configured.

## Project

| Item | Value |
| --- | --- |
| Firebase project | `caremesh-flare-2026` (number `1065697968576`) |
| Web app | `CareMesh Web` — `1:1065697968576:web:2e10a3c95a2192bb994825` |
| Auth providers | Google sign-in only (`google.com`) |
| Firestore database | `(default)`, Native/Standard edition |
| Firestore region | `asia-south1` (Mumbai) |
| Billing | Spark plan, billing disabled |
| Hosting | Not configured — Vercel hosts the app |

The browser-safe Web SDK values live in `public/firebase-config.json`. A Firebase web
API key identifies the project; it is not an admin credential or a secret. No service
account key, Admin SDK credential, OAuth client secret, or server token is stored in
this repository.

`public/firebase-config.json` is not imported by `public/app.js` yet. The current
passcode demo login, signed sessions, `store.mjs`, reminder engine, and email engine are
unchanged.

## Authentication model

- The real sign-in method is **Continue with Google**.
- The existing synthetic demo passcode login stays a separate demo path.
- A Google user cannot choose a CareMesh role from the browser.
- On first sign-in the backend creates `users/{uid}` with `role: "pending"`.
- New Google accounts never receive `elder` or `caregiver` automatically.
- Access to a care recipient is granted only through explicit care-team membership
  managed by that recipient's owner (or an authorized caregiver).
- The backend verifies the Firebase ID token, resolves membership, and then issues the
  existing signed CareMesh session. Firestore is never the browser's authorization
  boundary.

### Why the default role is `pending`

`family` is a real access level in CareMesh. Defaulting a brand-new Google identity to
`family` would imply access to a care recipient before any relationship is verified.
`pending` grants no recipient access at all; an owner must explicitly link the account
to a recipient and assign a role. This is the safest default and never escalates
privileges.

### Authorized domains

The project currently authorizes `caremesh-flare-2026.firebaseapp.com` and
`caremesh-flare-2026.web.app`. Before wiring the browser client, add the origins that
will actually run sign-in (for example `localhost` for development and the Vercel
deployment origin) in Firebase Authentication → Settings → Authorized domains.

## Target Firestore data model

The model is care-recipient first, not a global collection layout. It supports multiple
care recipients.

```text
users/{uid}

careRecipients/{recipientId}
  medications/{medicationId}
  appointments/{appointmentId}
  careTeam/{memberId}        # memberId = Firebase uid of a member
  events/{eventId}
  reminders/{reminderId}
  outbox/{messageId}
```

### `users/{uid}`

Server-owned account profile: `uid`, `email`, `displayName`, `role` (`pending` by
default), `status`, `createdAt`, `updatedAt`, `lastSignInAt`. Clients never write this
document.

### `careRecipients/{recipientId}`

`displayName`, `preferredName`, `timezone`, `status`, `ownerUid`, `createdAt`,
`updatedAt`. `ownerUid` is the explicit owner account. Ownership is data, not a
client-supplied claim.

### `careRecipients/{recipientId}/careTeam/{memberId}`

`uid`, `role` (`elder` | `caregiver` | `family`), `status` (`invited` | `active` |
`revoked`), `permissions`, `addedBy`, `addedAt`. This is the per-recipient
authorization record the backend checks on every request.

### Subcollections

- `medications`: `name`, `dose`, `schedule`, `status`, `nextDue`, audit fields.
- `appointments`: `title`, `provider`, `at`, `location`, `status`, audit fields.
- `events`: append-only audit/timeline records with `actorUid`, `type`, `at`, `summary`,
  and bounded metadata.
- `reminders`: reminder `key`, channel, due time, delivery status, and dedupe fields.
- `outbox`: queued/sent messages with provider id, status, timestamps, and error state.

Every read and write is scoped by `recipientId` and authorized server-side against
`ownerUid` / `careTeam`. A `recipientId` supplied by the browser is treated as a request
parameter, never as proof of access.

## Security rules

`firestore.rules` denies all client SDK reads and writes:

```text
match /{document=**} {
  allow read, write: if false;
}
```

Why: CareMesh is server-mediated (`Browser -> CareMesh backend -> Firebase Admin SDK ->
Firestore`). The backend is the only writer and the only authorization boundary. The
Admin SDK bypasses client rules. There is no `allow read, write: if true` and no broad
"any authenticated user" access.

## Indexes

No indexes are created. There are no application Firestore queries yet, and
`firestore.indexes.json` is intentionally empty. Any future index must name the exact
query that requires it; speculative indexes are not added.

## Regional note

`asia-south1` (Mumbai) was available and selected because the primary user and
development region is India. Vercel Functions currently run in the project's default
region; if latency to Firestore becomes relevant, co-locate the function region
(for example Mumbai) through the Vercel project settings — out of scope for this task.

## What is intentionally not configured

- Firebase Hosting (Vercel stays the host)
- Cloud Functions
- Cloud Storage
- Realtime Database
- Billing / Blaze plan
- Firestore data migration (there is no real data)
