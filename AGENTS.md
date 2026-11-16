# AGENTS.md — CareMesh

CareMesh is being prepared for FLARE 2026.

## Branch policy

- `flare-v2` is the active feature branch for FLARE work.
- Never modify `main` (the default branch) directly for FLARE changes.
- Do not force-push. Do not rewrite published history.

## Safety and secrets

- Never commit secrets: `.env`, `.env.*`, API keys, tokens, cookies, credentials, or private keys.
- Never print, expose, rotate, or change production secrets or Vercel environment variables as part of routine work.
- Keep synthetic demo data clearly separate from real medical data. Never add real patient or clinical data.

## Preserve existing behavior

- Preserve the existing role-based authorization model (elder, caregiver, family).
- Preserve signed-session authentication.
- Preserve audit/timeline behavior.
- Preserve reminder and email functionality.
- Avoid unnecessary rewrites of stable existing functionality.

## Product and clinical claims

- Do not add unsafe or clinically misleading claims.
- CareMesh is a coordination tool, not a medical device or diagnostic system.
- Keep product behavior aligned with the architecture/product-lead instructions.

## Verification

- Run verification after meaningful changes: `npm test`, `npm run lint`, and a local smoke check of the affected flow.
- Do not deploy to production unless explicitly instructed.
