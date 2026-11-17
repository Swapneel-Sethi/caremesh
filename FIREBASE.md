# Firebase foundation

CareMesh uses Firebase for **Authentication** and **Firestore** only. Vercel remains the
application host; Firebase Hosting is intentionally not configured.

## Project

| Item | Value |
| --- | --- |
| Firebase project | `caremesh-flare-2026` (number `1065697968576`) |
| Web app | `CareMesh Web`: `1:1065697968576:web:2e10a3c95a2192bb994825` |
| Auth providers | Google sign-in only (`google.com`) |
| Firestore database | `(default)`, Native/Standard edition |
| Firestore region | `asia-south1` (Mumbai) |
| Billing | Spark plan, billing disabled |
| Hosting | Not configured; Vercel hosts the app |

The Web SDK values that are safe for the browser live in `public/firebase-config.json`. A Firebase web
API key identifies the project; it is not an admin credential or a secret. No service
account key, Admin SDK credential, OAuth client secret, or server token is stored in
this repository.

`public/firebase-config.json` is loaded by `public/app.js` when the Google login button
is clicked. The current passcode demo login, signed sessions, `store.mjs`, reminder
engine, and email engine are unchanged.

## Authentication model

- The real sign-in method is **Continue with Google**.
- The existing synthetic demo passcode login stays a separate demo path.
- A Google user cannot choose a CareMesh role from the browser.
- On first sign-in the backend creates `users/{uid}` with `role: "pending"`.
- New Google accounts never receive `elder` or `caregiver` automatically.
- Access to a care recipient is granted only through explicit care team membership
  managed by that recipient's owner (or an authorized caregiver).
- The backend verifies the Firebase ID token, resolves membership, and then issues the
  existing signed CareMesh session. Firestore is never the browser's authorization
  boundary.

### Why the default role is `pending`

`family` is a real access level in CareMesh. Defaulting a new Google identity to
`family` would imply access to a care recipient before any relationship is verified.
`pending` grants no recipient access at all; an owner must explicitly link the account
to a recipient and assign a role. This is the safest default and never escalates
privileges.

### Auth flow

1. User clicks **Continue with Google** on the login page.
2. Browser loads Firebase Web SDK from `gstatic.com` (lazy, dynamic import).
3. `signInWithPopup` with Google provider opens consent screen.
4. On success, browser gets Firebase ID token, immediately signs out of Firebase.
5. Browser POSTs ID token to `/api/auth/firebase-login`.
6. Backend verifies token with Admin SDK (revocation check enabled).
7. Backend provisions/updates `users/{uid}` in Firestore:
   - New user: `role: "pending"`, `status: "pending"`
   - Existing user: only `email`, `displayName`, `lastSignInAt` updated; `role`/`status` preserved
8. Backend issues signed CareMesh session cookie (HttpOnly, Secure in prod, SameSite=Lax, 8h TTL).
9. Browser receives session, loads dashboard.
10. If `role: "pending"`, dashboard returns `{ pending: true, user }` and shows pending screen.
11. Pending users get 403 for all care data routes; `/api/me` and logout remain available.

### Authorized domains

The project authorizes:
- `caremesh-flare-2026.firebaseapp.com`
- `caremesh-flare-2026.web.app`
- `localhost`
- `127.0.0.1`
- `caremesh-one.vercel.app` (production)
- `caremesh-git-flare-v2-foraipurposes7-6330s-projects.vercel.app` (flare-v2 preview)

Configure in Firebase Authentication → Settings → Authorized domains.

### CSP additions for Firebase Auth

`Content-Security-Policy` on API responses includes:
- `script-src 'self' https://www.gstatic.com https://apis.google.com`
- `connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://www.googleapis.com`

Static files retain the base CSP without Firebase origins.

## Target Firestore data model

The model is organized around each care recipient rather than a global collection layout.
It supports multiple care recipients.

```text
users/{uid}

careRecipients/{recipientId}
  medications/{medicationId}
  appointments/{appointmentId}
  careTeam/{memberId}        # memberId = Firebase uid of a member
  events/{eventId}
  reminders/{reminderId}
  outbox/{messageId}
  invitations/{invitationId}
  voiceCalls/{callId}        # completed voice check-in attempts

voiceSessions/{sessionId}    # server only, opaque, expiring
```

### `users/{uid}`

Account profile owned by the server: `uid`, `email`, `displayName`, `role` (`pending` by
default), `status`, `createdAt`, `updatedAt`, `lastSignInAt`. Clients never write this
document.

### `careRecipients/{recipientId}`

`displayName`, `preferredName`, `timezone`, `status`, `ownerUid`, `createdAt`,
`updatedAt`. `ownerUid` is the explicit owner account. Ownership is data, not a
claim supplied by the client.

Voice consent lives on the same document and must be granted explicitly:

- `allowVoiceCalls`: must be `true` before any outbound call.
- `voicePhone`: E.164 number, kept on the server only.
- `voiceLanguage`: optional TwiML language, defaults to `CARE_VOICE_LANGUAGE`.
- `voiceCallWindow`: optional local calling window in `HH:MM-HH:MM` format.

The seeded demo recipient deliberately has `allowVoiceCalls: false` and no phone;
the judge simulator does not call anyone.

### `careRecipients/{recipientId}/careTeam/{memberId}`

`uid`, `role` (`elder` | `caregiver` | `family`), `status` (`invited` | `active` |
`revoked`), `permissions`, `addedBy`, `addedAt`. This is the authorization record the
backend checks for each recipient on every request.

### Subcollections

- `medications`: `name`, `dose`, `schedule`, `status`, `nextDue`, audit fields.
- `appointments`: `title`, `provider`, `at`, `location`, `status`, audit fields.
- `events`: audit and timeline records that are only appended, with `actorUid`, `type`, `at`, `summary`,
  and bounded metadata.
- `reminders`: reminder `key`, channel, due time, delivery status, and dedupe fields.
- `outbox`: queued/sent messages with provider id, status, timestamps, and error state.
- `voiceCalls`: `sessionId`, `callSid`, `provider` (`twilio` | `simulator`), `attempt`,
  `outcome`, `reason`, timestamps. No phone numbers are stored here.

### `voiceSessions/{sessionId}`

Top level because inbound Twilio webhooks only know an opaque session id, not which
recipient it belongs to. Fields: `recipientId`, `medicationId`, `medicationName`,
`medicationSchedule`, `status`, `attempt`, `callSid`, `language`, `toMasked`,
`createdAt`, `expiresAt`. The session id is 24 random bytes; sessions expire after
12 minutes and are claimed transactionally (`active → processing`) so replays cannot
mutate state twice. Clients have no read or write access.

Every read and write is scoped by `recipientId` and authorized on the server against
`ownerUid` / `careTeam`. A `recipientId` supplied by the browser is treated as a request
parameter, never as proof of access.

## Security rules

`firestore.rules` denies all client SDK reads and writes:

```text
match /{document=**} {
  allow read, write: if false;
}
```

Why: CareMesh is server mediated (browser to CareMesh backend, then Firebase Admin SDK, then
Firestore). The backend is the only writer and the only authorization boundary. The
Admin SDK bypasses client rules. There is no `allow read, write: if true` and no broad
"any authenticated user" access.

## Invitation flow

Pending Google accounts gain care recipient access through explicit invitations:

1. Elder or caregiver creates invitation: `POST /api/invitations` with `{ invitedUid, role, expiresAt }`
2. Invitation stored in `careRecipients/{recipientId}/invitations/{invitationId}` with `status: "pending"` and `expiresAt`
3. Invited user accepts: `POST /api/invitations/{invitationId}/accept` (must match `invitedUid`)
4. On acceptance: care team membership created in `careRecipients/{recipientId}/careTeam/{uid}` with `status: "active"` and assigned role
5. Invitation can be revoked: `POST /api/invitations/{invitationId}/revoke` (elder/caregiver only)

Invitation constraints:
- No one can assign themselves a privileged role (an inviter cannot invite themselves as elder or caregiver)
- Invitations expire (default 7 days)
- Duplicate invitations safely handled (each has unique ID)
- Acceptance verifies the invited Google identity matches `invitedUid`
- Membership creation is idempotent
- Only elder/authorized owner can create or revoke invitations

## IDOR prevention

Every care data endpoint verifies authenticated user + membership + role + recipient ownership:

- `checkRecipientAccess(user, recipientId)` confirms the user has an active care team membership for the recipient
- A `recipientId` supplied by the browser is treated as a request parameter, never as proof of access
- Family role is read only for all mutations
- Pending users receive no care recipient data (403 on all care data routes)

## Indexes

No indexes are created. There are no application Firestore queries yet, and
`firestore.indexes.json` is intentionally empty. Any future index must name the exact
query that requires it; speculative indexes are not added.

## Regional note

`asia-south1` (Mumbai) was available and selected because the primary user and
development region is India. Vercel Functions currently run in the project's default
region; if latency to Firestore becomes relevant, run the function in the same region
(for example Mumbai) through the Vercel project settings, which is outside the scope of this task.

## What is intentionally not configured

- Firebase Hosting (Vercel stays the host)
- Cloud Functions
- Cloud Storage
- Realtime Database
- Billing / Blaze plan
- Firestore data migration (there is no real data)

## Admin SDK configuration

Required environment variables (set in Vercel project settings, never in repo):

```
FIREBASE_PROJECT_ID=caremesh-flare-2026
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@caremesh-flare-2026.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

`FIREBASE_PRIVATE_KEY` must contain literal newlines (`\n` in shell, actual newlines in Vercel dashboard). The backend handles escaped `\n` from environment.

If any variable is missing, Firebase login returns 503 while demo login continues to work.

## Transitional session

The custom HMAC signed session cookie remains the session mechanism. Firebase session
cookies are not used. This avoids a migration and keeps the existing auth gates intact.
