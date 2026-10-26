# Budgets programme — shared contract (all phase specs and goal files obey this)

Parent plan: `docs/plans/2026-10-26-budgets-next-level.md`. Base: `origin/master` (migration head 946).

## Rulings (Hein, 2026-10-26)

- R1 Versions (original | reforecast | scenario; draft → approved → locked) and nullable CC1/CC2/BU keys on every budget amount. Company totals are computed roll-ups, never stored.
- R2 MVP user = one finance user. Budget-holder workspaces are P5.
- R3 Plan every phase; build P0–P3 (MVP) first.
- R4 Validate on **ISAFlow Demo** in prod (after-hours, Hein-approved deploys) and on dev.

## Product decisions (made — build them, do not re-ask)

1. Approve and Lock: roles owner + admin. Unlock: owner only, mandatory reason, audited.
2. Approved-but-unlocked versions stay editable by the finance user; every write audited. Locked = immutable, enforced by a DB trigger (app_user cannot bypass).
3. Existing budgets convert to one "Original" version per company + fiscal_year, status `approved`, `is_primary = true`, amounts unchanged (count + sum parity check fails the migration on mismatch).
4. Within one version, an account is budgeted at exactly ONE grain: company-level (all dims NULL) OR a single chosen dimension set. Enforced in the DB, not just the UI. Prevents double counting in roll-ups.
5. Spread/uplift rounding: default R1; options R100, R1000; residue lands on the last month.
6. Prod validation writes budgets ONLY into the ISAFlow Demo company, via the UI, after an approved deploy.

Deferred to phase-start decision gates (pre-filled defaults, Hein answers yes/override when that phase starts):
7. (P4) Headcount driver = active payroll employees per month + planned hires entered in the budget tool; read-only on payroll.
8. (P5) Budget check on supplier-invoice / PO approval: per-company setting off | warn | block; default warn; override needs a reason.
9. (P5) Overspend alerts: in-app to owner/admin first; email digest off until Hein enables.
10. (P6) Cash timing from actual debtor/creditor days; VAT/PAYE on SARS due dates; not client-visible until Hein reviews on Demo.

## Product decisions, round 2 (Hein accepted defaults, 2026-10-26 — build them, do not re-ask)

11. Owner-only unlock is enforced in the app layer; the DB audits every unlock. Sufficient for MVP.
12. A change of year end after versions exist re-homes the affected versions inside the year-end-change flow (no silently orphaned months).
13. Owner and admin may delete an approved (unlocked) version; locked versions cannot be deleted.
14. One dimension per account grain in a version (no CC1 + BU combined grain).
15. Viewer roles may open Budget vs Actual (read-only).
16. Projected FY uses actuals up to the last complete month, budget thereafter.
17. YTD runs to the end of the current month (whole months on both sides).

## Product decisions, round 3 (Hein, 2026-10-26, after P0 review — build them, do not re-ask)

18. **Budgets live on leaf (posting) accounts only; a header shows the roll-up.** A header (any account another account,
    active or not, names as `parent_account_id`) never holds its own budget in the grid: its row is the read-only
    Σ of its sub-accounts. Top-down entry is a header row action, **"Spread across sub-accounts"** (evenly, or in
    proportion to PY actuals), which writes the sub-accounts' cells; the header then shows their sum. The server
    refuses a NEW budget on a header or inactive account (400 `BudgetInputError`); an account that already holds
    amounts in the version stays editable. Existing header budgets (9 of 47 budgeted accounts on isaflow_dev,
    2026-10-26) are **never migrated silently**: the grid flags each one ("This header has its own R X budget —
    move it to a sub-account or spread it") with both actions. Reason: a header budget sits beside its children's
    and double-counts in every section total; budgeting where you post is the Xero/QBO/Sage norm. Owner: P2.
19. **MCP `budget_variance` drops `totals`; net profit is `sections.net_profit`.** P0 (#875) briefly shipped `totals`
    as net profit; a field whose meaning changes silently is worse than one that disappears, so it is removed in a
    P0 follow-up PR and the description points at `sections`. Owner: P0 follow-up.

## Canonical names (P1 owns them; every other phase uses exactly these)

- Table `budget_versions`: `id uuid pk`, `company_id uuid not null`, `fiscal_year integer not null` (same label semantics as `accounting_budgets.fiscal_year`, resolved via `gl/fiscalYearRegistry`), `name text not null`, `kind text check in ('original','reforecast','scenario')`, `status text check in ('draft','approved','locked')`, `based_on_version_id uuid null`, `is_primary boolean not null default false` (partial unique: one primary per company + fiscal_year), `approved_by/approved_at`, `locked_by/locked_at`, `created_by/created_at`, `updated_at`. Forced RLS like `budget_month_amounts`.
- `budget_month_amounts` += `version_id uuid not null` (FK budget_versions), `cc1_id`, `cc2_id`, `bu_id` (nullable; cc1/cc2 → `cost_centres`, bu → business units table — verify names on master). New unique key `(company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month) NULLS NOT DISTINCT` (CI = PG16, prod Supabase = PG15; verify prod supports it, else COALESCE-sentinel unique index).
- Journal-line dimension columns for actuals: `gl_journal_lines.cc1_id`, `cc2_id`, `bu_id` (mig 285).
- Service module: `src/modules/accounting/services/budgets/` (new home; existing `core/budgetService.ts` and `reports/budget*` move or re-export there — P1 decides and documents in a sibling `.claude.md`).
- Readers use the **primary** version unless a `version_id` is passed.
- Audit: entity `'budget'` in the existing audit log (filter already exists in `pages/accounting/audit-log.tsx`).

## Repo law (from CLAUDE.md — every goal file restates the relevant parts)

Branch first from `origin/master`, own worktree, `cd` explicitly each Bash call. company_id on every query; `sql` tagged template from `@/lib/neon`; `withAuth(withErrorHandler(...))`; `apiResponse`; `log` not console; no empty catch; ≤300 lines/file; TDD; migrations `IF NOT EXISTS`, next free 3-digit prefix (re-check at commit time — prefix races), never edit an applied migration; nav config updated for new pages; `.claude.md` per new module ≥4 files + `bun run agent-docs:generate`. Gate = `bun run ci` (integration step runs on GitHub; locally `CI_INTEGRATION=1 bun run ci`). Stage explicit paths, no `git stash`, no `--no-verify`, no force-push. Merges ONLY via `mq-isa add <PR>`. Never touch the prod DB directly; dev DB is `isaflow_dev`. UI changes need browser proof (dark AND light, 1280px and 390px). Money in statements via `formatStatementFigure`/`formatPct`; elsewhere `formatMoney`. Fav/unfav colour only via `src/components/accounting/charts/ibcs.ts` `varianceColor`. Every tooltip through `escapeHtml.ts`.

## Cross-phase rulings (consistency review, 2026-10-26 — every spec and goal obeys these)

**Variance sign.** Every human-facing surface (BvA screen, its CSV/XLSX, the statement Budget column, packs,
the grid's Δ vs PY, the heatmap, the bridge's ledger-signed `display`) prints `Var R = actual − budget` (the
movement; IBCS ΔBU). Good or bad news is a separate `favourable` boolean (revenue/income: movement ≥ 0; expense:
movement ≤ 0; NP and other profit totals: ≥ 0), coloured only via `varianceColor`. `Var % = movement / |budget| × 100`,
`null` ("—") when the budget is 0 or absent. Reason: `statementRows/comparators.ts` (header, exception 1) fixes every
StatementGrid comparator to the movement sign; a favourably signed Budget column beside the movement-signed prior-period
column would contradict itself, and P3 moves BvA onto that grid. P0's row model keeps its existing favourably signed
`variance` (used by MCP, `bulletOption`/`BudgetBulletRow` and the section invariant) and adds `movement`. MCP
`budget_variance` keeps `variance` favourably signed (backward compatible) and also carries `movement` and `favourable`;
its description states both.

**One owner per piece of work** (later phases reference, never redo):

| Work | Owner | Later phases |
|---|---|---|
| D1–D14; row-model fields `account_id`, `budgeted`, `variance_pct: number \| null`, `favourable`, `movement`, `movement_pct`; Revenue/Expense/NP sections; D7 comparator fix; MCP zero-budget rows, `sections`, corrected description; `totals` dropped for `sections.net_profit` (decision 19, P0 follow-up PR) | P0 | P3 verifies D7 is fixed; never re-fixes it |
| Schema, lock/grain/transition triggers, version services, the version-lifecycle routes `pages/api/accounting/budget-versions/**` (list, create, get, delete, copy, primary, status), primary-version readers | P1 | P2/P4/P5 call them; never rebuild them (missing = precondition failure). P4 adds only `budget-versions/[id]/reforecast.ts` |
| Grid, `pages/api/accounting/budget-grid/**`, `budgets/gridSave.ts` (the only batch writer for the grid), wizard seed (cross-FY copy + uplift, PY actuals), Excel round-trip, versions-bar UI over P1's routes, copy-based "New reforecast"; header roll-up rows, "Spread across sub-accounts", new-header/inactive refusal in `gridSave.ts` and `upsertBudget`, legacy header-budget flag (decision 18) | P2 | P4 hooks `recomputeDependents` into `gridSave.ts`; P5 adds holder mode |
| Tracking engine (bands, projection, version + dimension filters), **the one actuals SQL** `budgets/tracking/trackingActualRead.ts` (P3 PR-C makes `getBudgetVariance` a facade and retires P0's `reports/budgetWindowActuals.ts`), BvA on StatementGrid, CSV/XLSX export (retires P0's `budgetVsActualCsv.ts`, `BudgetVsActualTable.tsx` and the two old BvA routes), comparator version/dims, board-pack Budget column, management-pack `comparison_mode` + `budget_variance`/`income_vs_budget` sections, MCP `version_id`/`cc1_id`/`cc2_id`/`bu_id` | P3 | P4/P5/P6 read actuals only through `trackingActualRead.ts` |
| PY actuals by month × dimension | P2 `budgets/priorActuals.ts` and P3 `trackingActualRead.ts` | One SQL in the end: if P3 PR-A is on master first, P2 PR-B builds `priorActuals.ts` on `trackingActualRead.ts`; if P2 PR-B is first, P3 **PR-B** (not the greenfield PR-A) makes `priorActuals.ts` delegate. Both parity tests stay |
| Drivers, headcount, "New reforecast from actuals", rolling forecast | P4 | — |
| Budget check, alerts, `user_notifications` + bell, variance commentary (notes print inside P3's management-pack `budget_variance` section and a popover on P3's BvA), budget holders | P5 | — |
| Balance-sheet/cash three-way, assumption overrides | P6 | — |

**Migration prefixes.** Every migration takes the next free 3-digit prefix **at commit time** (re-check
`git ls-tree --name-only origin/master scripts/migrations/sql/` and open PRs' files). No goal hardcodes a prefix.
P1's spec writes `947` (free on 2026-10-26); if it is taken, rename the file and every `947` string inside it.

**Preconditions** are checked on `origin/master` by file or migration grep, never by PR search:
- P0, P1: none (they run in parallel; both touch `budgetWindowService.ts`, so whichever merges second rebases).
- P2: `src/modules/accounting/services/budgets/budgetVersionStatus.ts`, `pages/api/accounting/budget-versions/[id]/status.ts`, `pages/api/accounting/budget-versions/[id]/index.ts` exist and `git grep -q budget_month_amounts_one_grain origin/master -- scripts/migrations/sql` succeeds. P2 PR-D also needs P0: `src/components/accounting/budgets/useBudgetAccounts.ts`.
- P3: P0 (`src/modules/accounting/services/reports/budgetVsActualSections.ts`) and P1 (`src/modules/accounting/services/budgets/budgetVersionScope.ts`).
- P4: P1–P3: `budgets/budgetVersionScope.ts`, `budgets/gridSave.ts`, `budgets/tracking/trackingActualRead.ts`.
- P5: P4's checks for P1–P3, plus `src/components/accounting/budgets/tracking/useBudgetTracking.ts` (P3 PR-B) and `tests/unit/services/afs/managementPackComparisonMode.test.ts` (P3 PR-D).
- P6: P4's checks plus `src/modules/accounting/services/budgets/drivers/driverEngine.ts` and `git grep -q budget_driver_lines origin/master -- scripts/migrations/sql`.

**Golden specs and prod verify.** `scripts/verify-deploy.sh` runs `bun run test:e2e:golden` (`playwright-golden.config.ts`)
against **prod ISAFlow Demo** after every deploy, and a red run auto-rolls the code back. A spec is dev-only only if its
file name is in that config's `testIgnore` regex (applied under `GOLDEN_SKIP_A11Y=1`, which verify-deploy sets; the
name is historical). Rules:
- A budgets spec that runs in prod writes **only** its own non-primary versions named `GP-<runId>` (kind `scenario`
  or `reforecast`). It never sets primary, never locks, never writes the primary version, company settings or GL.
  Before its first write it prechecks the data it needs and the session role (owner/admin, required to delete an
  approved version) and `test.skip`s with a reason if either is missing. It sweeps stale unlocked non-primary `GP-%`
  versions at start (idempotent after a crashed run) and deletes its own in `afterAll`/`finally`, by the ids it
  created, asserting non-primary + `GP-` name first. Audit rows its writes leave stay (accepted).
- P2 and P4 specs follow that rule. P3 (asserts seeded figures), P5 (flips the check policy, approves bills = GL
  postings) and P6 (feature flag; writes assumptions) are **dev-only**: add the file to the `testIgnore` regex.
- File letter: next free golden letter at commit time (`a`–`u` used on 2026-10-26).

**Not gates.** Goal files list these as "never do" rules, not stops: changing the auth helpers, payroll code, the
audit_log action CHECK, other phases' behaviour, or scope beyond the spec (refuse and note in the handoff); installing
timers or enabling email/flags (Hein's act, listed in the handoff); review spirals (scope back to the spec, note it in
the PR body). Decisions 7–10 are phase-start decision gates (one question, at the start).

## Human gates (Hein's trust boundary — goal files STOP here, nowhere else)

- Any schema migration: stop for Hein's explicit OK before it is merged (P1 especially).
- PRs that modify existing production code paths (not greenfield): Hein reads the diff before `mq-isa add`. Greenfield-only PRs with all gates green + blind `/review` + security review may be queued without him.
- Production deploy (`bash scripts/deploy.sh`): never run by the goal session; hand Hein the after-hours request.
- Outbound email/notifications to real people; anything touching non-Demo company data.

## Goal-file format

Path: `.claude/handoffs/2026-10-26-budgets-P<n>-<slug>-goal.md`. Header with run command; §1 Mission; §2 What exists — do NOT redo (with verified paths); §2a Product decisions already made; §3+ features with what "real" means, schema/API/UI/tests, `[agent decides]` vs `[Confirmation Gate]`; Success criteria (real-PG test mutation-verified + Playwright acceptance with screenshot + evidence); Confirmation gates. Every path in the file must exist on `origin/master` (`git ls-files | grep -F`) or be explicitly marked NEW.
