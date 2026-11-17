# Catalyst Submission Checklist

## Round 1: automatic platform code assessment
The codebase is intentionally organized to make these signals explicit:

- Code quality: modular domain services, validation, readable naming, no secrets in source.
- Security: passcodes hashed with scrypt, HttpOnly sessions signed with HMAC, role checks, input validation, security headers.
- Efficiency: AI only on the Care Brief path; core CRUD remains deterministic.
- Testing: unit tests for auth, session integrity, validation, and role authorization.
- Accessibility: semantic labels, visible focus, reduced motion support, readable contrast, large targets.
- Problem alignment: medication management, adherence, appointments, care circle access, reminders.
- Google services: Vertex AI adapter and Firestore REST adapter activate when Google Cloud project configuration is present.

## Submission items
- Public GitHub repository.
- Working Cloud Run deployment URL.
- Brief project description.
- Mandatory LinkedIn post URL, including the organizer tag/template requirements.

## Cloud Run checks before submission
1. `GET /api/health` returns `ok: true`.
2. Public URL loads without authentication errors.
3. Elder login works.
4. Caregiver write path works.
5. Family write path is rejected.
6. Medication state updates persist.
7. Appointments load and can be added.
8. Care brief renders.
9. Reminder workflow responds.
10. No secrets are present in the public repository.

## Important challenge rule
The official Catalyst deck states the Challenge supports up to two scored code assessment submissions, and only the final submitted score is used. A connectivity or technical failure gets a separate retry allowance. Treat the second successful submission as final; do not spend it casually.
