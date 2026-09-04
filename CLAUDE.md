# IsaFlow — CLAUDE.md

*Last reviewed: 2026-09-04. When a rule here is contradicted by reality — a command
changes, a gate moves, the user corrects you — fix this file in the same commit as the
code. A stale rule is worse than a missing one.*

## Project

Next.js 14 + TypeScript accounting SaaS for South African businesses. Multi-tenant (every query scoped by `company_id`). Deployed to `app.isaflow.co.za`. Package manager: **bun**.

**Stack:** Next.js 14 (Pages Router) · TypeScript strict · React 18 · Tailwind · Vitest 4 · Playwright. Auth is GoTrue (Supabase Auth); `withAuth` sets user + company + transaction GUCs.

## Runtime

- Node.js `>=20.12.0` is required for local tooling and tests. Vitest 4/Rolldown imports `node:util` `styleText`, which is unavailable in Node 20.11.x and older.
- Bun `>=1.3.0` is required. This repo pins `packageManager` to `bun@1.3.2`.
- Use `.nvmrc` before installing dependencies: `nvm use` (or install `20.12.0` first), then `bun install`.
- **This repo has no `ci:quick`, no `typecheck`, and no npm scripts.** Ignore any inherited instruction naming them; the real commands are under [Commands](#commands).

## How to work here

This is a double-entry ledger holding real client money. The failure that costs most is
not a missing feature — it's a confident wrong number. These four rules outrank
everything below them.

- **Think before coding.** State your assumptions out loud before you act on them. If the
  request has two readings, present both and ask — don't pick one silently. If a simpler
  approach exists, say so. If the evidence contradicts the user, say so in one sentence
  with the evidence. Being agreeable and wrong is the expensive failure mode; if something
  is unclear, stop and name exactly what is confusing.
- **Simplicity first.** Write the minimum code that solves the stated problem. No
  abstractions for single-use code, no configurability nobody asked for, no error handling
  for scenarios that cannot occur. If you wrote 200 lines and 50 would do, rewrite it.
- **Surgical changes.** Every changed line must trace to the request. Don't reformat, don't
  rename, don't "improve" adjacent code or comments, and match the surrounding style even
  where you'd write it differently. Clean up imports and variables *your* change orphaned;
  pre-existing dead code gets *mentioned*, not deleted.
- **Goal-driven execution.** Turn the task into something checkable before you start
  ("add validation" → "these three invalid inputs return 400; here's the test"). For
  multi-step work, write the plan with a `verify:` command per step, then loop until each
  one actually passes.

## Verification (evidence, not inspection)

- Run the verification command **in the current message**, before you claim anything works.
- **"Should work", "looks good", "this should be fine" are not completion signals.** Paste
  the passing output, the diff, or the log line.
- Per change class: logic → `bun run test:unit` · types → `bun run type-check` ·
  style → `bun run lint` · anything shipping → `bun run ci`.
- **UI changes require loading the page in a browser.** Reading the JSX is not proof; a
  page that compiles can still 500 on data.
- SQL and money paths: run the query against `isaflow_dev` and read the rows. A migration
  that "should be idempotent" is unverified until re-run.

## Critical Rules (ALL code, ALL agents)

- **Branch first**: Parallel Claude sessions run on this repo — branch isolation is what stops one session's commit sweeping up another's unstaged files. NEVER edit on `master`. First action of any code-editing task is `git checkout -b <name>`.
- **No stubs**: When a deploy/CI gate fails on a missing module, build the real thing. Never commit `return null` / TODO placeholders to satisfy a typecheck.
- **Multi-tenant**: ALWAYS add `company_id` to every DB query. Never return data across tenants.
- **DB**: Postgres on **Supabase** (self-hosted on velo-server). Use `sql` tagged template from `@/lib/neon` (legacy import path — the runtime is pg-backed, not Neon Serverless). NEVER string concatenation.
- **API handlers**: Wrap with `withAuth(withErrorHandler(handler as any))` (re-exported from `@/lib/auth`). The legacy `withCompany` is gone post-GoTrue cutover — `withAuth` provides user + company + tx + GUCs.
- **Responses**: Use `apiResponse.success()`, `.badRequest()`, `.notFound()` from `@/lib/apiResponse`.
- **Logging**: Use `log` from `@/lib/logger` — NEVER `console.log`.
- **Error handling**: No empty `catch` blocks.
- **Types**: 100% TypeScript coverage. No `any` except where required by Next.js patterns.
- **File size**: Max 300 lines per file.
- **Dates**: pg returns `Date` objects from timestamp columns — handle both `Date` and `string` shapes.
- **Customer invoices**: Use `COALESCE(ci.client_id, ci.customer_id)` — both columns exist.
- **Nav**: Update `src/components/accounting/accountingNavConfig.ts` for every new page.
- **Migrations**: `IF NOT EXISTS` on all `CREATE TABLE` / `CREATE INDEX`.
- **Migrations**: Use the next unused 3-digit prefix, re-checked against `master` immediately before you name the file — a PR merging first steals your number. Never reuse a prefix; use `244b_` style to insert between existing ones. **Never edit an applied migration**, not even a comment: the checksum conflicts.

## Git

- No `--no-verify`, no force-push to `master`, no amending published commits.
- **Stage by explicit path — never `git add -A`.** Parallel sessions leave untracked files in the tree and `-A` sweeps them into your commit.
- **No `git stash`** — not `push`, `pop`, `list`-then-`apply`, none of it. `refs/stash` is shared across every worktree, and `stash push -- <path>` creates NO entry when that path is already clean, so a paired bare `pop` silently takes whatever another session left at `stash@{0}`. Commit to your own branch instead: a WIP commit is cheap, reversible, and scoped to your worktree.
- **Prefix every Bash call with an explicit `cd` to your worktree.** A drifted cwd turns a worktree-local mistake into a cross-session one. `git worktree list` currently shows 14.
- **Read committed state with `git show <sha>:<path>`, never from disk.** An author can commit and resume editing between your first command and your next, so a clean `git status` is a fact about one instant, not a state that holds for a round — checking it once at the start of a review proves nothing about the reads that follow. Reviewers especially: score a named commit, and if you need the working tree, say so in the finding.
- Verify a PR's head commit before merging it (`gh pr view <n> --json commits`) — a peer force-push can replace what you reviewed.

## Deploys — read before running anything

`bash scripts/deploy.sh` **deploys straight to production the moment you run it.**

- **It takes no arguments.** There is no `--dry-run` and no `--force`; passing them is
  silently ignored and the real deploy proceeds. There is no business-hours check in the
  script — the "don't deploy 08:00–17:00 SAST Mon–Fri without Hein's explicit approval"
  rule is enforced by *you*, not by code.
- **Never run it without Hein's explicit approval for that specific deploy.**
- It runs `bun run ci` first (bypassable only via `SKIP_CI=1` — an incident-only escape
  hatch, never for code that fails the gate), then builds, then applies migrations against
  the **production** DB, then rsyncs and restarts the service.
- It builds from the **current working tree**, so deploy only from a clean worktree — a
  dirty tree ships a peer's half-finished migration.
- Rollback: `bash scripts/rollback-deploy.sh` (code only — migrations are not reverted).

## Repo layout

```
src/
├── modules/      # Domain modules (see table below)
├── lib/          # Shared utilities (neon, logger, apiResponse, auth)
└── components/   # Shared UI (AppLayout, accountingNavConfig)
pages/
├── api/          # API routes (Next.js Pages API)
└── accounting/   # UI pages
scripts/migrations/sql/   # Numbered SQL migrations
tests/{unit,e2e}/         # Vitest unit + Playwright E2E
```

## Modules (`src/modules/`)

| Module | Scope |
|--------|-------|
| `accounting` | Core ledger: AR, AP, banking, GL, reporting, assets, VAT/SARS, payroll, AFS |
| `admin` | Platform admin: companies, users, billing, plans, feature flags |
| `analytics` | Native web tracking + query |
| `auth` | GoTrue MFA + session management |
| `billing` | PAYG Flow wallet, Stitch Express, subscription billing |
| `bureau` | Bureau-mode payroll |
| `onboarding` | SA address + CIPC reg-number normalisers (pure) |

## Key Paths

| What | Where |
|------|-------|
| DB client | `src/lib/neon.ts` |
| API response helpers | `src/lib/apiResponse.ts` |
| Logger | `src/lib/logger.ts` |
| Auth middleware | `src/lib/auth/index.ts` (re-exports `withAuth`, `withRole`, `withUserAuth`) |
| Services | `src/modules/accounting/services/` |
| API routes | `pages/api/accounting/` |
| UI pages | `pages/accounting/` |
| Migrations | `scripts/migrations/sql/` |
| Nav config | `src/components/accounting/accountingNavConfig.ts` |
| Unit tests | `tests/unit/` |
| E2E tests | `tests/e2e/` |

## Commands

```bash
bun run dev          # Start dev server on :3200
bun run build        # Production build
bun run lint         # ESLint over src + pages (reports unused disable directives)
bun run type-check   # tsc --noEmit
bun run test:unit    # Runtime check + duplicate-route check + Vitest
bun run ci           # Full CI gate (scripts/ci/run-ci.sh)
bun run db:migrate   # Apply pending Supabase migrations
bash scripts/deploy.sh  # Deploy to PRODUCTION — see Deploys above first
```

## Testing

- Unit tests: Vitest in `tests/unit/services/`
- E2E: Playwright in `tests/e2e/`
- TDD enforced: tests FIRST, implementation second. A test that only asserts on source
  text is a linter, not a test — mutate the production code and watch it go red.
- **CI gate**: `bun run ci` (`scripts/ci/run-ci.sh`) runs, in order: type-check, lint,
  agent-docs, security-guards, user-id-casts, is-active-filters, self-defining-universe,
  findings-numbering, migration-rls, unit-tests, migration-naming, integration-tests,
  build. **Required before any PR.**
- **Two steps skip silently**: `integration-tests` is skipped without `DATABASE_URL`, and
  `build` is skipped under `CI_SKIP_BUILD=1`. A green run that skipped them has not
  proven what you think it proved — read the `[skip]` lines in the output.

## Module docs (sibling `.claude.md` files)

Module-level rules live in `.claude.md` files next to each module and API-route group — **56** of them (23 under `src/modules/*`, 32 under `pages/api/accounting/*`), enumerable with `find src pages -name .claude.md`.

**Which file gets a fact:** anything that binds every session (money invariants, tenancy, git, deploys) belongs here. Anything true only inside one module — its table names, its caller contract, its local gotchas — belongs in that module's `.claude.md` and must not be duplicated here. When adding a module with ≥4 files, add a sibling `.claude.md` (purpose / caller contract / main signatures / business rules / recent changes / `Last updated:` date).

`CLAUDE.md` and every `.claude.md` are canonical; their `AGENTS.md` mirrors are generated. Regenerate with `bun run agent-docs:generate`, verify drift with `bun run agent-docs:check` (also a CI step). Codex/Cursor/Copilot walk the tree and compose the sibling `AGENTS.md` mirrors with this root file.

## Tooling available

- `/superpowers` — git worktrees, TDD, parallel agents, systematic debugging
- `/code-review`, `/review-pr` — multi-agent review. **The agent that wrote the code does not review it.**
- `/frontend-design` — distinctive UI components (avoid generic AI aesthetics)
- `/skill-creator`, `/revise-claude-md` — author skills; update this file after sessions
- `context7` MCP — live library docs (Next.js, React, …)
- `codegraph` MCP — symbol/caller/callee graph over this repo; cheaper than grep sweeps
- `playwriter` / `chrome-devtools` MCP — browser proof for UI changes
