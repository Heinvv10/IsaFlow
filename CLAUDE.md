# IsaFlow — CLAUDE.md

## Project

Next.js 14 + TypeScript accounting SaaS for South African businesses. Multi-tenant (every query scoped by `company_id`). Deployed to `app.isaflow.co.za`. Package manager: **bun**.

**Stack:** Next.js 14 (Pages Router) · TypeScript strict · React 18 · Tailwind · Vitest 4 · Playwright. Auth is GoTrue (Supabase Auth); `withAuth` sets user + company + transaction GUCs.

## Critical Rules (ALL code, ALL agents)

- **Branch first**: Parallel Claude sessions run on this repo — branch isolation is what stops one session's commit sweeping up another's unstaged files. NEVER edit on `master`. First action of any code-editing task is `git checkout -b <name>`.
- **No stubs**: When a deploy/CI gate fails on a missing module, build the real thing. Never commit `return null` / TODO placeholders to satisfy a typecheck.
- **Multi-tenant**: ALWAYS add `company_id` to every DB query. Never return data across tenants.
- **DB**: Postgres on **Supabase** (self-hosted on velo-server). Use `sql` tagged template from `@/lib/neon` (legacy import path — the runtime is pg-backed, not Neon Serverless). NEVER string concatenation.
- **API handlers**: Wrap with `withAuth(withErrorHandler(handler as any))` (re-exported from `@/lib/auth`). The legacy `withCompany` is gone post-GoTrue cutover — `withAuth` provides user + company + tx + GUCs. A route that must also accept a Personal Access Token / OAuth bearer uses `withBearerOrCookieAuth(withScope('<scope>')(withErrorHandler(handler)))` (`@/lib/auth/withBearerOrCookieAuth`, `@/lib/auth/withScope`): same company, tx and GUCs from the token, cookie path unchanged; exemplar `pages/api/accounting/gl-lines-export.ts`.
- **Responses**: Use `apiResponse.success()`, `.badRequest()`, `.notFound()` from `@/lib/apiResponse`.
- **Logging**: Use `log` from `@/lib/logger` — NEVER `console.log`.
- **Error handling**: No empty `catch` blocks.
- **Types**: 100% TypeScript coverage. No `any` except where required by Next.js patterns.
- **File size**: Max 300 lines per file.
- **Dates**: pg returns `Date` objects from timestamp columns — handle both `Date` and `string` shapes.
- **Customer invoices**: Use `COALESCE(ci.client_id, ci.customer_id)` — both columns exist.
- **Nav**: Update `src/components/accounting/accountingNavConfig.ts` for every new page.
- **Migrations**: `IF NOT EXISTS` on all `CREATE TABLE` / `CREATE INDEX`.
- **Migrations**: Use the next unused 3-digit prefix. Never reuse an existing prefix. Use `244b_` style suffix if inserting between existing numbers.
- **Git**: No `--no-verify`, no force-push to `master`, no amending published commits. Stage by explicit path, never `git add -A`. **No `git stash`** (`refs/stash` is shared across every worktree). Commit WIP to your own branch instead. Prefix every Bash call with an explicit `cd` to your worktree. Read committed state with `git show <sha>:<path>`, not from disk; reviewers score a named commit, not a working tree. Full rationale: `docs/agent-workflow.md`.
- **Merges go through the merge queue** (Hein, 2026-10-17): agents NEVER merge into master. Run `mq-isa add <N>` (then `mq-isa status` / `mq-isa log`); the worker (`merge-queue-isaflow.service`) updates the PR from master, waits for both required checks on that exact head, re-runs a cancelled required check (usually a bumped Golden Paths) up to twice per head, merges with the head pinned, and retargets PRs stacked on it. `critical-guard` denies `gh pr merge` and the REST merge here. Branch protection is strict, so this is the only safe order with one runner (R-052). The manual update-branch / `--match-head-commit` procedure is Hein's fallback only. Detail: `docs/agent-workflow.md`.
- **Deploys**: `bash scripts/deploy.sh` takes no arguments, has **no clock or approval gate**, and deploys production immediately, any day, any hour. NEVER run it without Hein's explicit approval for that deploy, and NEVER during 08:00-17:00 SAST Mon-Fri. `SKIP_CI=1` skips the CI gate and is incident-only; it does not skip the migration-parity gate. It applies pending migrations to the **production DB** before switching code (irreversible), then `rsync --delete`s and restarts the service; a failed post-deploy verification auto-runs `scripts/rollback-deploy.sh`, which reverts **code only, never migrations**. `SKIP_VERIFY=1` skips that verification and leaves the deploy unverified: emergencies only, and say so in the deploy report. Manual rollback uses `scripts/rollback-deploy.sh` (`/home/velo/isaflow-rollback`), not `deploy.sh`. Parity-gate behaviour and test procedure: `docs/agent-workflow.md`.

## Modules (`src/modules/`)

| Module | Scope |
|--------|-------|
| `accounting` | Core ledger: AR, AP, banking, GL, reporting, assets, VAT/SARS, payroll, AFS |
| `admin` | Platform admin: companies, users, billing, plans, feature flags |
| `analytics` | Native web tracking + query |
| `auth` | GoTrue MFA + session management |
| `billing` | PAYG Flow wallet, Stitch Express, subscription billing |
| `bureau` | Bureau-mode payroll |
| `onboarding` | Per-entity onboarding rules, transactional company setup (`complete-setup`), VLM normalisers, tenant provisioning |

## Commands

- `bun run ci` is the full gate (`scripts/ci/run-ci.sh`); required before any PR.
- `bun run db:migrate` applies pending migrations; `bun run dev` serves on :3200.
- Node `>=20.12.0` (Vitest 4/Rolldown needs `styleText`); use `.nvmrc`.

## Testing

- Unit tests: Vitest in `tests/unit/services/`
- E2E: Playwright in `tests/e2e/`
- TDD enforced: tests FIRST, implementation second
- **CI gate**: `bun run ci` runs every gate in `scripts/ci/run-ci.sh` (type-check, lint, the text guards, unit + component tests, migration-naming, the integration suites, production build). **Required before any PR.** GitHub's `quality` job runs the same `bun run ci` (R-052), so add a gate to `run-ci.sh` only — never list gates in `.github/workflows/ci.yml`; the `workflow-runs-ci` gate refuses any change to that job's shape. The `integration` step (`scripts/ci/integration/run.sh`) runs every `tests/integration/**/*.int.test.ts` **on GitHub only** (`GITHUB_ACTIONS=true`); a local `bun run ci` (and so the pre-push hook) prints one `[skip] integration: NOT RUN` line instead, unless you opt in with `CI_INTEGRATION=1 bun run ci`. It `initdb`s throwaway PostgreSQL 16 clusters as the current user (needs `postgresql-16` + `postgresql-16-pgvector`; no docker, no dev database, no secret), loads the committed schema baseline `scripts/ci/integration/baseline.sql.gz` (schema-only dump of isaflow_dev, gzipped so the text censuses do not read it as a writer; refresh with `refresh-baseline.sh`, see its header) plus the branch's newer migrations, routes each suite to `isaflow_schema_fixture` or `isaflow_test` by the guard it calls, and runs 6 shards one file at a time. It ignores `DATABASE_URL`, and it applies the branch's new migrations as a non-superuser `postgres`, as production's deploy does. A suite that cannot run there (live GoTrue, dev's tenants) skips and must say why in a `ci-integration-skip:` comment; the step prints each one and fails on a suite that skips everything without one. Inside the step (`CI_INTEGRATION_GATE=1`, `tests/helpers/integrationGate.ts`) the wall-clock bounds in `w2-28-system-role-round9/12` and `r035-pr5-perf` skip and their correctness checks still run. The GitHub job's `timeout-minutes` is 120 for it (a shard is cut at 30 min). Both checks are required on an up-to-date head (see the merge rule above), so a red check blocks the merge — read why it failed before re-running.

## Module docs (sibling `.claude.md` files)

Module-level rules live in `.claude.md` files next to each module and API-route group — 54 of them, covering all of `src/modules/*` and every API route group under `pages/api/accounting/*`. `CLAUDE.md` and every `.claude.md` are canonical; generate their `AGENTS.md` mirrors with `bun run agent-docs:generate`, and verify drift with `bun run agent-docs:check`. Codex/Cursor/Copilot walk the tree and compose the sibling `AGENTS.md` mirrors with this root file. When adding a new module with ≥4 files, add a sibling `.claude.md` (purpose / caller contract / main signatures / business rules / recent changes).
