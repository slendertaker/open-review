# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## Commands

```bash
npm run dev            # tsx watch, hot-reload dev server on :3000
npm run start:dev      # run from src/ once, capped heap (no watch)
npm run build          # tsc -> dist/, then copies schema.sql + views/ + public/ into dist/
npm start              # run from dist/ (prod); prestart FAILS if fonts missing from dist -> run build first
npm run typecheck      # tsc --noEmit
npm test               # vitest run (all tests)
npm run test:dot       # vitest run, dot reporter

npx vitest run test/worker/pipeline-guard.test.ts   # single test file
npx vitest run -t "rate limit"                       # single test by name pattern
npx vitest watch test/queue                          # watch a directory
```

Prod runs from `dist/`, not `src/`. `build` is not just `tsc` -- it copies `src/state/schema.sql`, `views/`, and `public/` into `dist/`. If you touch templates, static assets, or the SQL schema, you must rebuild before `npm start` sees them; running the app from stale `dist/` is a common source of "my change did nothing".

## Architecture

Single-process Node service on a 1-core / 2 GB VPS. One SQLite file (`data/open-review.db`, WAL mode) is the entire persistence and queue layer -- no Redis, no second process. Two subsystems share that DB and the same `ConfigStore`: the **HTTP server** (webhook receiver + dashboard) and the **worker** (single-threaded review drain loop). `src/index.ts` wires them together and owns the boot sequence and graceful shutdown.

### Review data flow (the core loop -- protect this above all else)

1. `src/server.ts` `/webhook` -- raw bytes captured by a buffer content-type parser, HMAC-verified **before any JSON parse** (order is security-critical, do not reorder), then filtered (`src/webhook/filter.ts`), deduped by delivery GUID, and enqueued. Always replies 200 immediately.
2. `src/queue/queue.ts` -- persistent SQLite FSM queue (`pending -> running -> done/failed`). Single worker, concurrency = 1. `enqueue` does **latest-wins coalescing**: a new push for a PR with a pending row updates it in place instead of adding a duplicate. `RateLimitError` re-enqueues with backoff instead of failing. `reclaimRunning()` on boot flips orphaned `running` rows back to `pending` (crash recovery).
3. `src/worker/pipeline.ts` `runReview` -- the orchestration spine: resolve GitHub auth (App token or PAT) -> `acquireWorktree` (cached bare clone + ephemeral worktree at head SHA) -> `getDiff` (base...head, minus ignore globs) -> `buildPrompt` -> `provider.invoke` -> `assertProviderSucceeded` (non-zero exit throws **before** anything is posted) -> `parseOutput` -> fingerprint-dedup + min-severity filter -> `postReview`. Worktree cleanup runs in a `finally` on every exit path.
4. `src/poster/post.ts` -- one batched GitHub `createReview` with severity-labeled inline comments + summary; out-of-diff findings routed to the summary; 422 falls back to summary-only. Posting failures are logged-and-dropped so they never disturb worktree cleanup.

Review outcomes are recorded in the append-only `review_runs` table (durable history, drives the dashboard activity feed) -- separate from `job_queue`, which is transient.

### Provider abstraction (`src/provider/`)

`getProvider(name)` returns a `ReviewProvider` (`invoke` + `parseOutput`). `ClaudeProvider` shells out to the `claude` CLI. Codex is meant to drop in behind the same interface without touching webhook/queue/poster. Keep provider-specific details (CLI flags, auth env var, output shape) inside the provider. `parseOutput` must never throw. Claude-specific credential injection uses `invokeResolved` (checked via `instanceof ClaudeProvider`) so the subprocess gets the live stored token, never `process.env`.

### Two-layer read-only sandbox (security invariant -- never weaken without cause)

The review subprocess must stay strictly read-only even against a prompt-injected PR:
- **Layer 1 (`src/provider/claude.ts`):** `--allowedTools` scoped to Read/Glob/Grep + `git` restricted to the worktree; `--disallowedTools` blocks Edit/Write/WebFetch/WebSearch; `--permission-mode dontAsk`; `--bare` is **never** passed (it would ignore the OAuth token). `buildSandboxEnv` builds the child env from scratch (never spreads `process.env`) with exactly one credential -- `GITHUB_TOKEN`, webhook secret, and the App private key never reach the child.
- **Layer 2 (`config/review-settings.json` -> `hooks/enforce-readonly.sh`):** a catch-all `"*"` PreToolUse hook that fail-closed default-denies every tool, with a strict read-only Bash allowlist that rejects shell metacharacters, absolute/home/parent-dir paths, and non-git verbs. Settings live at `config/review-settings.json` (an absolute path passed via `--settings`), deliberately **not** at `.claude/settings.json`, so they never load into interactive sessions.

Prompt-injection defense also lives in `src/worker/prompt.ts`: PR diff, title, and the reviewed repo's own guidelines are wrapped as explicitly untrusted DATA.

### Config, secrets, auth

`ConfigStore` (`src/config/store.ts`) is the seam; `SqliteConfigStore` (`src/config/sqlite-store.ts`) is the live implementation -- **all getters read SQLite per-request/per-job, never snapshot** (so a dashboard change takes effect without restart). Settings are plaintext KV; secrets are AES-256-GCM encrypted at rest (`src/config/crypto.ts`) under a machine key (`data/secret.key` or `OPEN_REVIEW_SECRET_KEY`). On first run, `seedFromEnvIfEmpty` imports env vars into the store. Dashboard is Fastify + Eta server-rendered templates + htmx/Alpine (no build step); password login via argon2 + `@fastify/session` backed by SQLite. **Plugin registration order in `server.ts` is mandatory** (formbody -> cookie -> session -> csrf -> view -> static) -- each depends on the previous.

### Startup safety gates (`src/startup.ts`)

`assertSqliteVersion` (>= 3.35 for `UPDATE...RETURNING`) and `assertClaudeVersion` (>= 2.1.163, CVE-2026-55607 sandbox-escape fix) both run **before** `listen()` -- an unsafe environment never accepts a webhook.

### Conventions worth knowing

- **No em-dashes** in user-facing text (dashboard copy, README, `docs/`, posted PR comments, `src/poster/post.ts`, `src/worker/prompt.ts`). Enforced by `test/deploy/em-dash.test.ts`. Code and code comments are exempt.
- Design decisions carry stable IDs (`D-09`, `QUEU-05`, `T-jr6-01`, etc.) referenced in code comments and in `.planning/`. When touching guarded behavior, trace the ID rather than guessing intent.
- `.planning/` is the GSD workflow state (phases, roadmap, decisions). Per the project's GSD enforcement, route non-trivial edits through a GSD command (`/gsd-quick`, `/gsd-debug`, `/gsd-execute-phase`).
- Deployment surface lives in `install.sh` (curl|bash installer) and `config/*.tmpl` (systemd unit, Caddyfile, env) -- Caddy fronts TLS; systemd `KillMode=control-group` reaps orphaned `claude` subprocesses.