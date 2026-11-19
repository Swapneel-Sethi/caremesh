# CodeDia 2026 — CareMesh + Adaption AI Design Plan

Status: reconnaissance and design plan written before implementation. The shipped CodeDia integration is the CarePulse Escalation Advisor built with the Adaption Responses API and request-scoped function calling (`submit_decision`) on `gemma-4-31b-it`. Stack, agentic memory, Adaptive Data, and AutoScientist were evaluated in this plan but are not implemented in the runtime.
Repository inspected: local clone at `C:\Users\Swapneel\Downloads\caremesh` (remote `https://github.com/Swapneel-Sethi/caremesh.git`, checked-out branch `flare-voice-agent`).
Date: 2026-11-18.

---

## 1. Current CareMesh architecture

CareMesh is a single-process Node.js web application with no frontend build step.

| Layer | Implementation |
| --- | --- |
| Runtime | Node.js 22+ (Docker image), `node:http` server in `server.mjs` |
| Frontend | Static `public/index.html`, `public/app.js`, `public/styles.css`; vanilla JS, hash-based views |
| Backend | One request handler (`createHandler`) with a hand-rolled REST router in `server.mjs` |
| Auth | Synthetic demo passcodes (scrypt) and Firebase Google sign-in; both converted into an HMAC-SHA256 signed session cookie |
| Persistence | Firestore through Firebase Admin when `FIREBASE_*` is configured; otherwise an in-memory demo store |
| Async work | CarePulse reminder engine, callable by an authenticated request or by a secret-protected cron route |
| External services | Firebase Auth/Admin, Firestore, Vertex AI (Gemini), Resend, Twilio (optional, disabled by default) |
| Deployment | Vercel (`vercel.json`, two daily crons) and a Cloud Run-ready Dockerfile |
| Tests | 77 tests using `node:test`, no coverage measurement |

Key structural facts:

- The browser never talks to Firestore or any provider. The Node backend is the only authorization boundary (`firestore.rules` denies all client access).
- Care data is scoped under `careRecipients/{recipientId}`. The recipient id is derived server-side, never from browser input.
- `src/store.mjs` is the only persistence module. It exposes domain snapshot, medication and appointment writes, timeline events, reminders, invitations, and voice records, each with a memory and a Firestore branch.
- `src/reminders.mjs` contains the entire automation policy: reminder windows, dedupe keys, voice-first escalation for missed doses, email fallback.
- `src/voice.mjs` implements one state machine shared by Twilio webhooks and the in-app simulator. `src/voice-intent.mjs` is a deterministic, deliberately narrow classifier (`TAKEN`, `NOT_TAKEN`, `HELP`, `UNCLEAR`).
- `public/app.js` renders every view from one `/api/dashboard` payload. `careBriefCard()` at `public/app.js:505` renders the AI summary; `judgeTourView()` at `public/app.js:598` is an existing judge-facing tour page.

Notable repository hygiene finding: `caremesh/caremesh/` is a stale nested copy of an older project snapshot. It is listed in `.gitignore` (`.gitignore:9`) and is not part of the tracked repository. It must not be treated as source of truth and should not be deleted without explicit approval.

## 2. Existing AI architecture

There is exactly one AI feature in the runtime: the Care Brief.

**Implementation:** `src/google.mjs`.

- `generateCareBrief(snapshot)` (`src/google.mjs:18-34`).
- If `GOOGLE_CLOUD_PROJECT` is empty, it returns `deterministicCareBrief(snapshot)` (`src/google.mjs:43-57`) and makes no network call.
- Otherwise it obtains an access token from the GCE metadata server (`getGoogleAccessToken`, `src/google.mjs:6-16`), then calls:
  `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`.
- Model default: `gemini-2.5-flash`, configured in `src/config.mjs:13`.
- Request body: one user turn containing a fixed instruction plus `JSON.stringify(snapshot)`; `temperature: 0.2`, `maxOutputTokens: 280`.
- Response handling: joins all `candidates[0].content.parts[].text`, trims, and falls back to the deterministic brief if the result is empty.

**Data passed to the model:** `{ profile, medications, appointments, careTeam }`, assembled at `server.mjs:297` (dashboard) and `server.mjs:473` (`POST /api/care-brief`). No events history, no reminder history, no adherence history, no voice outcomes.

**Failure handling:** two different behaviours.
- Dashboard: catches the error and returns `Care Brief fallback\n\n{error.message}` inline (`server.mjs:296-298`). This leaks the provider error string to the client.
- `POST /api/care-brief`: catches and returns a generic `503` (`server.mjs:469-476`).

**Abstraction status:** partial. The Vertex call is isolated in one module with a function-level signature and a deterministic fallback, so the product workflow does not depend on Gemini. However, there is no provider interface, no shared prompt module, and no schema validation of model output. The dashboard route calls `generateCareBrief` directly.

**Implication for Adaption:** the repository is well positioned for a second AI provider, but the integration should introduce a thin adapter contract rather than adding a second ad-hoc call next to the Vertex one.

## 3. CodeDia requirements relevant to Adaption

Verified requirements from the brief:

- Adaption AI usage is mandatory and must be meaningful.
- Other AI tools, frameworks, languages, and libraries are allowed.
- The final project must demonstrate its Adaption integration.
- The feature must be genuinely useful, not a label, a hidden call, a dummy endpoint, or an unused model.
- The original CareMesh project must remain intact and recoverable.
- This is an individual submission.

The judging-relevant question is therefore not "does an Adaption call exist?" but "what does CareMesh do differently because Adaption is present?". The design below answers that with an observable behaviour change in the escalation loop.

## 4. Adaption capabilities that are actually available

Verified against the official documentation on 2026-11-18. Nothing below is assumed from memory.

### 4.1 Hosted inference (Responses API)

- Base URL: `https://api.prod.adaptionlabs.ai/api/v1`.
- Authentication: `Authorization: Bearer $ADAPTION_API_KEY`. Keys are organization-bound, so no `X-Organization-Id` header is required.
- Endpoint: `POST /api/v1/responses`.
- Body fields include `model`, `input`, `instructions`, `temperature`, `max_output_tokens`, `tools`, `max_tool_calls`, `tool_choice`, `store`, `previous_response_id`, `agentic_memory`, `self_improvement`.
- The response object includes `output_text`, `output[]`, `usage`, `status`, and `error`.
- `store` defaults to `false` (unlike OpenAI). Stored responses are retained for 30 days.
- Hosted model IDs documented: `qwen3.5-397b`, `glm-5.2`, `glm-5.3-flash`, `deepseek-v4-flash`, `gemma-4-31b-it`, `gemma-4-26b-a4b-it`, `qwen3.8-27b`, plus two SEA-LION models.
- Streaming is server-sent events.

### 4.2 Inference stacks

- A stack is a saved configuration of model, tools, datasets, and memory.
- Called by passing `model: "stack:<slug>"`.
- Stacks can be created and edited only in the Adaption app, not through the API.
- A stack can only be called by its owner, with a key for the stack's organization, and the stack must be active.
- Stack calls require the Responses API. A chat-completions-style runtime fails with `model_not_found`.
- Request parameters can override stack defaults (`tools`, `agentic_memory`, `file_search` dataset scope).

### 4.3 Tools

- Function tools: JSON-schema functions executed by the calling application. The model returns a `function_call` item; the caller runs it and sends back `function_call_output`.
- Remote MCP servers: Adaption connects and runs the calls; approval can be required.
- Hosted tools: `file_search` over authorized, indexed datasets, with `file_citation` annotations.
- Connectors: services configured in the Adaption app, referenced by `server_label`.
- `web_search` and `code_execution` exist as hosted tools per the API reference.

### 4.4 File search and memory

- `file_search` requires a dataset with a ready retrieval index.
- Agentic memory is scoped per user and per stack, is built in the background after a response completes, and is injected into later instructions.
- Requests that do not name a stack do not use memory.

### 4.5 Adaptive Data

- Converts raw data into a model-ready training dataset through six stages: import, map columns, apply recipes, expand, set brand controls, adapt and evaluate.
- Inputs: CSV, JSON, JSONL, Parquet, PDF, DOCX, PPTX, XLSX, HTML, ZIP, TXT; Hugging Face; Kaggle.
- `column_mapping` requires a prompt column for a real run; completions, chat, and context are optional.
- `estimate: true` returns credit cost and duration without starting a run.
- Also supports augmentation, translation, localization, trajectory extension, dataset combination, and custom-rubric evaluation.

### 4.6 AutoScientist

- Automates data optimization, training (SFT or SFT-to-DPO alignment), evaluation against `target_win_rate`, and hyperparameter adjustment.
- Requires a dataset from an Adaptive Data run, or an already training-ready dataset.
- Produces a downloadable best model artifact.
- Supports base-model listing, run status, cancellation, and hyperparameter recommendation.

### 4.7 MCP server

- Hosted at `https://api.prod.adaptionlabs.ai/api/v1/mcp`, Streamable HTTP, stateless, POST only.
- Tools cover datasets, synthetic dataset generation, and AutoScientist runs.
- This is a development/agent tooling surface, not a runtime dependency for a web product. It is useful for building the training dataset, not for serving CareMesh users.

### 4.8 SDK reality check

- The documented SDK is Python only (`pip install adaption`).
- No JavaScript or TypeScript SDK is documented.
- For this Node.js codebase, the correct integration is direct HTTPS with the built-in `fetch`, matching the existing style in `src/google.mjs` and `src/email.mjs`. No new dependency is required.

## 5. Three candidate CareMesh + Adaption features

### Candidate A — Grounded Care Brief stack

Replace the single Gemini prompt with an Adaption inference stack that has:
- a curated care-coordination reference dataset indexed for `file_search`,
- agentic memory scoped per care recipient,
- a structured output contract for the brief.

The brief would cite the dataset rows it used and remember recipient preferences across sessions. Gemini stays as the second provider; the deterministic brief remains the fallback.

**Pros:** lowest technical risk; replaces an existing AI surface; easy to show side by side with Gemini; citations are visible proof of grounding; memory is a real Adaption differentiator.
**Cons:** closest to "swap the LLM"; a judge could reasonably call it an inference-provider substitution. It does not change any care workflow decision. It also requires putting care content into an Adaption-hosted dataset, which is a privacy decision that needs a synthetic-only boundary for the hackathon.

### Candidate B — CarePulse Escalation Advisor

A CarePulse decision layer for missed doses. Today the policy in `src/reminders.mjs:172-198` is fixed: if voice is configured, start a check-in, otherwise email the caregiver. With Adaption:

- CareMesh calls a stack (`stack:caremesh-carepulse`) with the missed-dose context.
- The stack has function tools that only read scoped CareMesh state: `get_care_snapshot`, `get_recent_events`, `get_recipient_context`.
- The model must return a strict JSON decision from an allowlist: `voice_check_in`, `email_caregiver`, or `hold_and_retry`, plus a short reason and a plain-language handoff line.
- CareMesh validates the decision server-side, executes only the allowed action, records an Adaption decision event in the Timeline, and shows the reason in Continuity.

**Pros:** changes real product behaviour; uses stacks, function tools, and memory together; the audit trail makes the integration visible; degrades cleanly to the current rules; genuinely useful because escalation choice depends on adherence history, time of day, prior response pattern, and caregiver availability, which the current rule ignores.
**Cons:** a model influencing notification behaviour needs hard guardrails; adds latency to the care path; must never produce medical advice; requires a strict output schema and an allowlist; needs a deterministic fallback and a cost cap.

### Candidate C — Adherence Pattern Analyst with Adaptive Data

A scheduled weekly analysis that turns event history into a caregiver digest: recurring unresolved routines, time-of-day patterns, repeated "unclear" voice outcomes, and one recommended coordination change. The digest is generated by an Adaption stack over a dataset built with Adaptive Data from synthetic care-event examples. Optionally, AutoScientist trains a small instruction model on that dataset.

**Pros:** uses Adaption's actual differentiator, the data-adaptation and training pipeline; asynchronous, so latency is acceptable; produces an artifact a judge can inspect (dataset evaluation, training run, model card).
**Cons:** least visible in a short live demo; needs enough historical data to be credible; AutoScientist runs are time- and credit-bound; the documentation does not describe how to serve a downloaded AutoScientist artifact as a runtime stack model, so the runtime path is uncertain.

## 6. Pros and cons summary

| | A. Grounded brief | B. Escalation advisor | C. Pattern analyst |
| --- | --- | --- | --- |
| Uses hosted inference | Yes | Yes | Yes |
| Uses stacks | Yes | Yes | Yes |
| Uses function tools | No | Yes | Optional |
| Uses memory | Yes | Yes | Optional |
| Uses Adaptive Data | Optional | Build-time only | Yes, central |
| Uses AutoScientist | No | No | Optional, uncertain serving |
| Changes product behaviour | No | Yes | Advisory only |
| Demo visibility | High | High | Medium |
| Implementation risk | Low | Medium | High |
| Safety burden | Low | Medium | Low |
| Time to a credible demo | Low | Medium | High |

## 7. Recommended use case

**Candidate B, CarePulse Escalation Advisor**, with Candidate A folded in as the human-readable output.

Reasons:

1. It makes Adaption a functional component, not a summarizer. The escalation path produces a different, auditable action because Adaption is present.
2. It uses three Adaption capabilities together in a way that is hard to dismiss as a wrapper: a stack (saved configuration), function tools (scoped reads of CareMesh state), and agentic memory (recipient-level continuity).
3. It fits the existing product thesis. CareMesh already says "AI first, human when necessary." The current implementation encodes that as a fixed rule. Adaption makes the decision context-aware while the human escalation path stays intact.
4. It preserves Gemini and the deterministic fallback. CareMesh becomes provider-aware rather than provider-locked.
5. It is demonstrable in under a minute through the existing simulator and Timeline.

Explicit non-goals: no diagnosis, no dosage advice, no free-form autonomous action, no removal of the caregiver escalation path, no replacement of Gemini.

## 8. Proposed technical architecture

```
Browser (public/app.js)
   |
   |  same-origin /api/*
   v
Node backend (server.mjs)
   |
   +-- src/care-brief-adapter.mjs   (provider selection + shared contract)
   |        |
   |        +-- src/google.mjs        Vertex AI / Gemini  (unchanged)
   |        +-- src/adaption.mjs      Adaption Responses API
   |        +-- deterministic fallback (unchanged)
   |
   +-- src/carepulse-advisor.mjs    decision contract, allowlist, validation
   |        |
   |        +-- src/adaption.mjs    stack:caremesh-carepulse + function tools
   |
   +-- src/reminders.mjs            executes the validated decision
   |
   +-- src/store.mjs                CareMesh state + Timeline events
```

Design rules:

- One new outbound module (`src/adaption.mjs`) owns base URL, auth header, timeout, retries, error mapping, and response parsing. It has no product logic.
- One new policy module (`src/carepulse-advisor.mjs`) owns the prompt, the tool schemas, the JSON contract, and validation. It is the only place that knows about Adaption-specific request shape.
- The existing Gemini module is not rewritten. It is wrapped by the adapter so both providers satisfy the same function signature.
- Model output is untrusted input. The server validates it against a closed schema and an action allowlist before anything happens.
- Every decision writes a Timeline event with provider, stack, action, latency, and a request id. No key material is ever logged.

### Function tools exposed to the Adaption stack

| Tool | Purpose | Boundary |
| --- | --- | --- |
| `get_care_snapshot` | Current medications, appointments, profile summary | Recipient-scoped, no identifiers beyond display fields |
| `get_recent_events` | Last N CarePulse, medication, and voice events | Read-only, capped at 20 |
| `get_recipient_context` | Time zone, voice consent, voice readiness, notification mode | No phone numbers, no secrets |

Tool execution happens inside CareMesh. Adaption only receives the returned JSON.

### Decision schema

```json
{
  "action": "voice_check_in | email_caregiver | hold_and_retry",
  "reason": "short coordination rationale",
  "handoff": "one plain-language line for the care circle",
  "confidence": 0.0
}
```

Server-side rules:

- Unknown `action` → reject and fall back to the existing rule.
- `voice_check_in` is only executable when `isVoiceReady()` is true and the actor is allowed to start a call.
- `hold_and_retry` is only accepted inside the existing retry window; it cannot suppress the final caregiver escalation.
- `handoff` is truncated, stripped of identifiers, and rendered as text only.
- Any provider failure, timeout, invalid JSON, or schema violation falls back to the current deterministic escalation policy.

## 9. Data flow

Missed-dose path:

1. CarePulse cron or an authenticated reminder run calls `runReminders`.
2. `buildReminderCandidates` produces a `medication-missed` candidate with a stable dedupe key.
3. The reminder key is claimed atomically (existing behaviour), so concurrent runs cannot both act.
4. CareMesh builds a minimized context object: profile summary, the missed medication, adherence counts, last five events, voice readiness, local time.
5. `carepulse-advisor` calls `POST /api/v1/responses` with `model: stack:caremesh-carepulse` and the three function tools.
6. Adaption may call the tools; CareMesh answers each call with scoped JSON.
7. Adaption returns a decision object.
8. CareMesh validates the decision, executes the allowed action, and records:
   - the existing reminder/voice events,
   - one new Timeline event: `Adaption escalation decision` with action, stack, request id, and latency.
9. If any step fails, the existing rule runs unchanged and the Timeline records `Adaption unavailable, deterministic policy used`.

Care brief path:

1. Dashboard or `POST /api/care-brief` asks the adapter for a brief.
2. Adapter picks a provider by configuration (`adaption`, `gemini`, or `deterministic`).
3. The same structured snapshot is passed.
4. The returned text is rendered in the existing `careBriefCard()` with a provider chip.

## 10. Exact files and modules to modify

New files:

| File | Purpose |
| --- | --- |
| `src/adaption.mjs` | Adaption REST client: responses, stack calls, tool-call loop, timeout, error mapping |
| `src/carepulse-advisor.mjs` | Prompt, tool schemas, decision schema, validation, fallback |
| `src/care-brief-adapter.mjs` | Provider selection between Adaption, Gemini, and deterministic output |
| `tests/adaption.test.mjs` | Client tests with a stubbed `fetch`: success, 401, 429, 500, timeout, malformed JSON |
| `tests/carepulse-advisor.test.mjs` | Schema validation, allowlist enforcement, fallback on invalid action, no medical advice in output |
| `docs/CODEDIA-ADAPTION.md` | Judge-facing integration note and demo script (optional, small) |

Modified files:

| File | Change |
| --- | --- |
| `src/config.mjs` | Add Adaption settings and feature flag |
| `src/reminders.mjs` | Replace the fixed missed-dose branch with advisor call, validated action, fallback, and decision event |
| `server.mjs` | Use the brief adapter at both call sites; extend `/api/health` with Adaption status; add no new public mutation route |
| `public/app.js` | Provider chip on the brief; decision reason in Continuity; Adaption event rendering in Timeline |
| `public/styles.css` | Small styles for the provider chip and rationale block |
| `.env.example` | Document Adaption variables |
| `README.md` | Short section describing the Adaption integration and fallback |
| `tests/reminders.test.mjs` | Cover advisor-driven escalation and fallback paths |

Explicitly unchanged: `src/google.mjs` behaviour, all auth and session code, all Firestore rules, all voice webhook security, the deterministic voice classifier, the existing reminder keys, and the existing email adapter.

## 11. Security considerations

- **Key handling:** `ADAPTION_API_KEY` is server-only. It never enters `public/`, never appears in a client bundle, and is never logged. `.env*` is already gitignored; `.env.example` stays empty-valued.
- **Data minimization:** only display fields, medication names, schedule, status, and event titles are sent. No phone numbers, no addresses, no Firebase UIDs, no internal recipient ids.
- **Synthetic data boundary:** the hackathon demo uses the seeded synthetic care circle only. Real patient data must not be sent to any hosted model. This must be stated in the README and in the UI.
- **Prompt injection:** care notes and event titles are user-controlled text. They are serialized as data, never as instructions. Model output is never executed as code or used to build a query.
- **Output trust boundary:** strict JSON schema, closed action allowlist, length caps, identifier stripping, and a deterministic fallback.
- **Notification authority:** the model can choose only among existing CareMesh actions. It cannot create new recipients, change permissions, change medication status, or suppress the final caregiver escalation.
- **Cost and abuse:** per-request timeout, `max_output_tokens` cap, process-level rate limiting already present, and a feature flag that disables Adaption instantly.
- **Retention:** `store: false` for care-content requests. If memory is enabled, document that memory is scoped per user and stack and is managed in the Adaption app.
- **Audit:** record provider, stack, action, latency, and request id. Never record the key, full prompt with identifiers, or raw care notes.
- **Regulatory posture:** CareMesh remains a coordination tool, not a medical device. Adaption output must not introduce diagnostic or prescribing language; a test asserts that the prompt forbids it and that the renderer treats it as plain text.

## 12. Environment variables required

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ADAPTION_API_KEY` | Yes, for live Adaption | empty | Bearer token, server-only |
| `ADAPTION_BASE_URL` | No | `https://api.prod.adaptionlabs.ai/api/v1` | Gateway base URL |
| `ADAPTION_STACK` | Yes, for the advisor | `stack:caremesh-carepulse` | Stack slug for escalation decisions |
| `ADAPTION_MODEL` | No | `qwen3.5-397b` | Model used when no stack is configured |
| `ADAPTION_TIMEOUT_MS` | No | `8000` | Per-request timeout |
| `ADAPTION_MAX_OUTPUT_TOKENS` | No | `400` | Cost and latency cap |
| `ADAPTION_ENABLED` | No | `false` | Feature flag; `false` forces the deterministic path |
| `ADAPTION_DATASET_ID` | No | empty | Only if `file_search` grounding is enabled |

Existing variables are unchanged. When `ADAPTION_ENABLED` is false or the key is missing, the application behaves exactly as it does today.

## 13. Local development approach

1. Create a dedicated worktree or clone and branch (see the setup section at the end).
2. Run `npm install`, `npm test`, `npm run lint` on the untouched baseline and record the result.
3. Create the Adaption stack in the Adaption app: choose a model, enable the three function tools, leave `file_search` off for phase one.
4. Put `ADAPTION_API_KEY` and `ADAPTION_STACK` in a local `.env` that is never committed. The current code reads `process.env` directly; load it in the shell or use the platform's env mechanism.
5. Start with `ADAPTION_ENABLED=false` and confirm every existing flow and test still passes.
6. Enable Adaption, then verify with a single scripted call before wiring the reminder path.
7. Use the existing voice simulator to drive missed-dose scenarios without Twilio.
8. Keep a second terminal with the key unset to demo the fallback path.

No new dependency is required. No build step is added.

## 14. Demo strategy

A 90-second path that follows one care thread:

1. Sign in as the caregiver.
2. Open Overview and point at the current signal and next action.
3. Open Medications, choose an unconfirmed dose, and simulate a "did not take it" response.
4. Open Timeline. Show the new `Adaption escalation decision` event: action chosen, reason, stack, latency.
5. Open Continuity. Show the plain-language handoff and the "why this action" line produced by the stack.
6. Unset `ADAPTION_API_KEY`, rerun the same scenario, and show the deterministic policy take over with a clear "Adaption unavailable" event.
7. Optionally show the Adaption app side: the stack configuration, the memory entry, and the request in the organization's usage view.

The fallback step is deliberate. It proves the integration is a real dependency with a controlled failure mode, not a decorative call.

## 15. How a judge can clearly see that Adaption is meaningfully used

- The escalation action changes because of Adaption, and the change is recorded in the product's own audit trail.
- The Timeline event names the stack and the chosen action; it is not a hidden call.
- The Continuity view explains the action in plain language, tied to the care circle's next step.
- `/api/health` reports `ai: adaption-stack` versus `gemini` versus `deterministic`, so the runtime mode is inspectable.
- The Adaption app shows the stack, its tools, its memory, and the request history, independent of CareMesh's claims.
- The fallback demo shows what happens without Adaption, which makes the delta observable.
- If the Adaptive Data step is completed, the dataset evaluation and any AutoScientist run are separate, inspectable artifacts.

## 16. How to preserve existing CareMesh functionality

- Work on a dedicated branch or worktree; `main` and the current FLARE branches are untouched.
- No existing route is removed or renamed.
- Gemini remains a working provider; `src/google.mjs` keeps its current behaviour.
- The deterministic care brief and the deterministic voice classifier remain the fallback path.
- Adaption is behind a feature flag that defaults to off when configuration is missing.
- Existing tests must pass unchanged before new tests are added.
- Firestore rules, session auth, role gates, recipient isolation, Twilio signature verification, and replay protection are not modified.
- The new code is additive: one client module, one policy module, one adapter, plus wiring.

## 17. Risks and uncertainties to resolve before implementation

1. **Serving a trained model is undocumented.** The docs describe downloading an AutoScientist artifact but do not describe binding that artifact to a runtime stack. Do not promise a trained-model runtime path until Adaption confirms it.
2. **Stack creation is app-only.** The API can call stacks but cannot create or edit them. The setup must be done manually in the Adaption app and documented as a prerequisite.
3. **Model availability varies by key.** `GET /models` must be called with the real key before hard-coding a model id.
4. **Credits and rate limits.** Adaptive Data, AutoScientist, and inference consume credits; Adaptive Data estimates are available, AutoScientist runs are not estimated. Confirm the available balance before planning a training demo.
5. **Latency budget.** Vercel functions are configured with `maxDuration: 30`. A multi-turn tool loop plus the reminder path may be slow. The advisor must have an 8-second timeout and run only for missed doses, not for every reminder.
6. **Memory timing.** Memory is built in the background after a response completes, so a new memory is not available in the same turn. The demo must not imply instant personalization.
7. **Data protection.** The docs do not state data residency or a HIPAA/BAA posture. The hackathon must use synthetic data only, and production use would require a privacy review before any real care data is sent.
8. **Prompt-injection surface.** Free-text instructions and notes exist in the domain. The tool loop must treat all care text as data, and the decision schema must remain closed.
9. **Clinical framing.** The advisor must never produce diagnosis, dosage, or prescribing content. A test should assert the prompt constraint and the renderer's plain-text treatment.
10. **Which branch is the true baseline.** The local checkout is on `flare-voice-agent`, and `README` describes features that may not exist on `main`. Branch from the current HEAD unless you specify otherwise.
11. **Repository hygiene.** `caremesh/caremesh/` is a stale, gitignored nested copy. It must not be copied into the new working tree as if it were source.

---

## Appendix — Step 1 setup commands (not executed)

The agent environment for this session has no shell access, so the working copy was not created. These are the exact commands to run from the existing clone. They preserve the original checkout and history.

Recommended, zero-copy worktree:

```powershell
cd C:\Users\Swapneel\Downloads\caremesh
git status
git worktree add ..\caremesh-codedia-2026 -b codedia-2026
```

Fully independent clone, if isolation is preferred over shared history:

```powershell
cd C:\Users\Swapneel\Downloads
git clone caremesh caremesh-codedia-2026
cd caremesh-codedia-2026
git switch -c codedia-2026
```

After either command:

```powershell
npm install
npm test
npm run lint
```

Do not push the new branch until explicitly approved. Do not force-push. Do not modify `main`.

If `git worktree add` refuses because the target directory exists, choose a new directory name; do not delete the existing one.
