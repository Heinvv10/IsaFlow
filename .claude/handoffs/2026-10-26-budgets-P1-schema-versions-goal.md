# /goal: Budgets P1, schema for versions and dimensions, lock trigger, grain constraint, primary-version readers (run autonomously until DONE)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/IsaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-26-budgets-P1-schema-versions-goal.md to completion. Work autonomously through Census → Schema tests (red) → Migration → Readers → Version services/API → Guards/docs → Review → Fix loops. Do not stop to ask, except at a Confirmation Gate (§9) or a genuine external blocker. Loop until every Success Criterion (§8) is proven with evidence, then open the PR, STOP for Hein's migration OK and diff read (§9), queue it with mq-isa only after he gives it, write a handoff and stop.`

## 1. Mission

Give budgets versions (Original / Reforecast / Scenario; Draft → Approved → Locked) and nullable CC1 / CC2 / BU keys on every amount. Enforce the lock and the one-grain rule **in the database**. Convert today's budgets into an approved primary "Original" per company and year with loud parity. Do all of this without changing a single figure any existing screen, export, MCP tool or pack shows today.

Full design: `docs/plans/budgets/P1-schema-versions-spec.md`. It lands with the planning branch `docs/budgets-next-level-plan`; read it end to end, because it is the contract. Shared rules: `docs/plans/budgets/00-shared-contract.md`.

"Real" means real-PostgreSQL integration tests (CI clusters, `CI_INTEGRATION=1`), each red before the code exists and red again under the mutation named in spec §8. No mocked SQL in the evidence.

## 2. What already exists, do NOT redo (verified on origin/master 49d139b5e)

- `budget_month_amounts`, migration `scripts/migrations/sql/944_budget_month_amounts.sql`:
  - one row per company × account × calendar month, unique `budget_month_amounts_one_per_month`;
  - forced RLS in the 897 form, and trigger `budget_month_amounts_same_company`;
  - the one-shot legacy converter `public.budget_months_from_legacy`, which the 944 suites still call.
- `accounting_budgets`: per-account, per-year notes header. Its dead columns stay.
- Writers and readers:
  - `src/modules/accounting/services/core/budgetService.ts` (240 lines), plus `budgetMonths.ts` and `budgetYears.ts` in the same dir;
  - `src/modules/accounting/services/reports/budgetWindowService.ts` (`loadWindowBudgets`) and `budgetVarianceService.ts`.
  - Routes `pages/api/accounting/budgets.ts`, `budgets-action.ts`, `reports-budget-vs-actual.ts`, `budget-vs-actual-export.ts`, `reports-budget-comparator.ts`.
  - MCP `src/lib/mcp/tools/budgetVariance.ts`; packs `src/modules/accounting/services/packs/figures/packFigureSet.ts`.
- Dimension masters:
  - `cost_centres`: CC1 and CC2, by `cc_type` 'cc1' / 'cc2'.
  - `business_units`: migration 285. Journal-line FKs are migrations 882/884; validation is in `src/modules/accounting/services/gl/journalCostCentreValidation.ts`.
- Delete-usage guards: `src/modules/accounting/services/core/costCentreUsageGuard.ts`, `src/modules/accounting/services/core/businessUnitService.ts` (283 lines).
- Fiscal-year refusal census: `src/modules/accounting/services/gl/fiscalPeriodReferences.ts`. Registry: `src/modules/accounting/services/gl/fiscalYearRegistry.ts`, and SQL `public.fiscal_year_for_date` (mig 940).
- Audit: `logAuditOrThrow` in `src/modules/accounting/services/core/auditTrailService.ts` and table `audit_log`. The action CHECK has no lock or unlock; `'budget'` is already a filter in `pages/accounting/audit-log.tsx`.
- Bounded row-lock waits: `src/modules/accounting/services/core/rowLockBudget.ts` (`withRowLockBudget`).
- Role on API routes: `req.companyRole` (withAuth). The `withRole('admin')` admits owner + admin (`src/lib/auth/withRole.ts`).
- NL query allowlist: `src/modules/accounting/services/core/nlQueryValidationService.ts`, `nlQueryFkPairs.ts`.
- Prod and dev run **PostgreSQL 15.8**; CI runs PG16. So `NULLS NOT DISTINCT` and column-list `ON DELETE SET NULL (col)` are fine. btree_gist exclusion constraints with `uuid =` / `<>` are already live (mig 644).
- P2's spec (`docs/plans/budgets/P2-budget-grid-spec.md` §3) expects these exact P1 names:
  - `budgets/budgetVersions.ts`, `budgets/budgetVersionStatus.ts`;
  - routes `pages/api/accounting/budget-versions/[id]/status.ts` and `[id]/index.ts`;
  - errors `BUDGET_VERSION_LOCKED` / `BUDGET_VERSION_STALE`;
  - `updated_at` bumped on transitions and on every pre-lock.

  Keep them.
- P0 (`fix/budgets-p0-correctness-*`) runs in parallel and also edits `budgetWindowService.ts` and the budget readers. Whichever PR merges second rebases onto the other; if P0 merged first, P0's `budgetWindowActuals.ts` / row-model fields are part of the "unchanged figures" baseline for test 8.
- `src/lib/apiRoutes.ts` is a partial typed route map (33 `/api/accounting/*` entries): add the new routes a client reads.

## 2a. Product decisions already made (build them, do not re-ask)

1. Approve and Lock: owner + admin. Unlock: owner only, mandatory reason, audited.
2. Approved-but-unlocked stays editable by the finance user, and every write is audited. Locked = immutable, enforced by a DB trigger app_user cannot bypass.
3. Existing budgets → one "Original" per company + fiscal year, `approved`, `is_primary = true`, amounts unchanged. Count + sum parity fails the migration on mismatch.
4. One grain per account per version (company level OR one dimension set), enforced in the DB.
5. (P2) Rounding R1 / R100 / R1000, residue on the last month: not P1.
6. Prod validation only in ISAFlow Demo, via UI, after an approved deploy: not this session.

Also decided in the spec (§1–§4): composite FKs for company consistency; a GiST exclusion for the grain; `FOR SHARE` in the lock trigger; pre-lock of the version before every write; the DB-trigger writes the transition audit; no SECURITY DEFINER anywhere; no default-filling trigger for `version_id`.

## 3. Migration `scripts/migrations/sql/<next free prefix>_budget_versions.sql` (NEW; 947 on 2026-10-26) [spec §3–§4]

- Prefix: the next free one **at commit time** (947 was free on 2026-10-26). Re-check `git ls-tree --name-only origin/master scripts/migrations/sql/` and open PRs' files immediately before committing; take the next unused prefix if it has gone.
- Contents, in order:
  - the `budget_versions` table, RLS, partial uniques and composite based-on FK;
  - the guard and audit triggers (ENABLE ALWAYS);
  - the new amount columns and the `dim_grain` generated column;
  - composite FKs to `budget_versions` / `cost_centres` / `business_units`, plus the masters' `(company_id, id)` unique indexes;
  - the `cc_type` trigger and the lock trigger (ENABLE ALWAYS, `FOR SHARE`);
  - the conversion functions and the DO block with parity;
  - `SET NOT NULL`, `budget_month_amounts_one_per_cell UNIQUE NULLS NOT DISTINCT`, `budget_month_amounts_one_grain EXCLUDE`, then drop `budget_month_amounts_one_per_month`;
  - `CREATE OR REPLACE` of 944's `budget_months_from_legacy`, with only its INSERT changed;
  - the NL view (§6).
- Header comment covers: WHY, LOCKS, CONVERSION, ROLLBACK and the backward-compatibility table (spec §9).
- Error codes are a contract with P2 and must not change:
  - `BV001` locked;
  - `BV002` illegal transition or immutable field;
  - `23514` unlock without reason, wrong `cc_type`;
  - `23P01` + constraint `budget_month_amounts_one_grain`.
- [agent decides] the exact SQL. Every rule in spec §3 must hold, and every function stays SECURITY INVOKER.
- **[Confirmation Gate]** if the pre-flight census (spec §4: months `fiscal_year_for_date` cannot place, run on a pg_dump **clone** of dev in a throwaway cluster) is non-zero.

## 4. Readers and writers on the primary version [spec §5, rows R1–R10]

- `budgets/budgetVersionScope.ts` NEW: `resolvePrimaryVersion`, `lockVersionForWrite`, `primaryVersionScope(companyId, start, end)`, `namedVersionScope`.
- `budgetService.ts`:
  - readers filter by version;
  - `upsertBudget` auto-creates a draft primary `Original` when the year has none;
  - `deleteBudget` / `copyBudgets` act on primaries;
  - each write pre-locks the version, then writes one `logAuditOrThrow` row (entity `'budget'`, entity_id = version id).
- `loadWindowBudgets(…, versionId?)`: a primary contributes only months inside its own fiscal year; with no `versionId`, each year in the window uses that year's primary.
- `budgets.ts` and `budgets-action.ts`: optional `versionId`; typed errors → 409 `BUDGET_VERSION_LOCKED` / 400 `BUDGET_GRAIN_CONFLICT`. A lock refusal must come **before** any write, so the request transaction is never poisoned.
- Fixtures that INSERT amounts directly pass `version_id`. Census: `git grep -n "INSERT INTO budget_month_amounts" tests`. Existing suites' **assertions do not change**; only fixtures do.
- BvA, export, comparator, MCP and packs get no new parameters (that is P3). They must show identical figures.

## 5. Version services + API [spec §6]

- NEW in `src/modules/accounting/services/budgets/`:
  - `budgetVersionTypes.ts` (types, `BudgetVersionError`, `mapBudgetDbError`);
  - `budgetVersions.ts` (list, get, create, copy, set primary, delete);
  - `budgetVersionStatus.ts` (approve, lock, unlock: CAS on status plus optional `expectedUpdatedAt`; the audit row comes from the trigger, not the app);
  - `index.ts` barrel;
  - `.claude.md`.
- Existing `core/` and `reports/` budget files **stay where they are** (36 importers, 5 `vi.mock` paths); the barrel re-exports them. Record that in `.claude.md`.
- NEW routes:

  | Route | Methods |
  |---|---|
  | `pages/api/accounting/budget-versions/index.ts` | GET, POST |
  | `pages/api/accounting/budget-versions/[id]/index.ts` | GET, DELETE |
  | `pages/api/accounting/budget-versions/[id]/status.ts` | POST |
  | `pages/api/accounting/budget-versions/[id]/copy.ts` | POST |
  | `pages/api/accounting/budget-versions/[id]/primary.ts` | POST |

  Use `withAuth(withErrorHandler(withCsrf(withWriteAccess(…))))`, `apiResponse`, roles from `req.companyRole`. Another tenant's id → 404. Add a `.claude.md` in that route dir (it has ≥ 4 files). These are the only version routes in the programme: P2–P6 call them and never build their own (contract ownership table).
- Delete rule: not primary, not locked; a draft may be deleted by any writer, an approved version by owner/admin only.

## 6. Guards, fiscal refs, NL surface, docs [spec §5 R6–R9, §3.6]

- `costCentreUsageGuard.ts` and `businessUnitService.ts` count budget amounts in their delete-usage refusal. Extract `businessUnitUsage.ts` NEW to keep ≤ 300 lines.
- `fiscalPeriodReferences.ts`: `budgets` also counts `budget_versions`.
- NL query: [agent decides] between the `budget_primary_month_amounts` security-invoker view (default) and dropping the table from the allowlist. **Never** leave `budget_month_amounts` there.
- Docs:
  - `budgets/.claude.md` (≤ 50 lines);
  - entries in `core/.claude.md`, `reports/.claude.md` and `gl/.claude.md`;
  - `bun run agent-docs:generate`, then `bun run agent-docs:check`.
- No UI changes. No nav change: there is no new page.

## 7. Tests (names, proofs and mutations are in spec §8 #1–#14)

Write them first; each must be red before its code exists.
- Conversion parity: the DO block is extracted from 947 as shipped. A sabotaged conversion must raise `947 verification failed`.
- As **app_user**: a locked version refuses INSERT, UPDATE, version move and DELETE (`BV001`); `ENABLE ALWAYS` is proven.
- Lock race, with two connections, using real lock waits (not sleeps).
- Transition rules, plus the trigger-written audit row.
- Grain exclusion, including the concurrent-insert race and delete-then-reinsert in one tx.
- Cross-tenant FK refusal for version, cc1, cc2, bu and based_on (`23503`), and `cc_type` (`23514`), as app_user and as owner.
- NULLS NOT DISTINCT uniqueness.
- Primary-reader parity, with golden figures taken before conversion: the draft is ignored and each year uses its own primary.
- Routes: roles, 409-before-write, CAS, 404 cross-tenant, one audit row per write.
- Usage guards.
- **Old-code compatibility:** master's pre-P1 SQL, copied verbatim, against the new schema. Reads are identical; the old upsert fails `42P10` and writes nothing.
- NL surface.
- 944 suites still green.
- Catalog: no `prosecdef`, no TRUNCATE grant, FORCE RLS, `tgenabled='A'`. s07b/s07c suites green.

Do NOT apply 947 to `isaflow_dev` before merge: it breaks master's unit-db deploy gate for every peer. Prove behaviour on CI clusters, plus a pg_dump clone where a dev-shaped dataset is needed. State in the PR that the local unit-db `budgetServiceDb` stays red against dev until deploy applies 947.

## 8. Success criteria

- [ ] Census written into the PR body:
  - the prefix check;
  - every `budget_month_amounts` SQL site on master, mapped to R1–R10;
  - every fixture INSERT updated;
  - the pre-flight registry census = 0.
- [ ] Spec §8 tests #1–#14 committed. Each is red before its code and red again under its named mutation. Log paths are under `/home/hein/.cache/redchk/budgets-p1/` and listed in the PR body.
- [ ] Existing budget suites green with unchanged assertions:
  - `budgets-*.int.test.ts`, `budgetServiceDb`, `budgetVarianceDb`;
  - `reportsBudgetComparator`, `budgetVarianceTool`;
  - the budgets page and BvA component tests.
- [ ] `bun run ci` and `CI_INTEGRATION=1 bun run ci` green. Grep the passed line, because the wrapper exit can mask a failure. GitHub `quality` + `integration` green on the PR head.
- [ ] A blind `/review` and a fresh **adversarial breaker** (own cluster; it attacks the lock trigger, transitions, RLS, grain race, composite FKs, conversion parity and rollback compatibility with real-PG repros) both SHIP on the final head. A security review is also done. Every H/M/L finding is fixed.
- [ ] Spec §9's rollback runbook line is in the 947 header and in the PR body.
- [ ] PR opened. Hein has given the §9 OK. `mq-isa add <N>` run. Handoff written, listing:
  - spec §12's open questions, with Hein's answers if given;
  - that P2/P3 can start;
  - the after-hours deploy request: prod deploy needs Hein; on Demo afterwards, confirm the budgets page and BvA figures are unchanged.
- [ ] Worktree removed; clusters stopped.
- Playwright/browser: P1 has no UI change, so there is no screenshot criterion. The post-deploy check on ISAFlow Demo (budgets page and BvA unchanged, dark + light, 1280 + 390) is Hein's after-hours step. Write it into the handoff as an exact checklist.

## 9. Confirmation gates: STOP and ask Hein (the contract's human gates, nothing else)

- **Before merge: the migration.** Show Hein the migration file, the conversion/parity design, the rollback table, and the pre-flight census result (a non-zero census is presented here, with the months the registry cannot place). Merge only on his explicit OK.
- **Before `mq-isa add`: the diff.** This PR modifies existing production paths, so Hein reads the diff.
- Any production deploy (`bash scripts/deploy.sh`): never run it. Hand Hein the after-hours request.
- Outbound email/notifications, and any read or write of production or non-Demo company data.

**Never do (not gates):** write to `isaflow_dev` (a pg_dump of dev into a throwaway cluster is allowed; applying the migration to dev is not); change the `audit_log` action CHECK; add a SECURITY DEFINER function; change approval semantics beyond decisions 1–2. Spec §12 Q1–Q3: build the stated defaults and list them in the handoff. If review rounds keep surfacing new classes, scope back to the spec and say so in the PR body.

## Rules

- **Worktree:** `git worktree add -b feat/budgets-p1-versions-20261026 /home/hein/Workspace/IsaFlow-budgets-p1 origin/master`, then `cp -al` node_modules into it (never `ln -s`). `cd` into it on every Bash call.
- **Git:**
  - Never commit to master. Stage explicit paths, never `git add -A`.
  - No `git stash`, no `--no-verify`, no amend or force-push.
  - Merge only through `mq-isa add`, after §9.
  - Push in the background at load < 25.
- **Repo law** (CLAUDE.md):
  - `company_id` on every query; the `sql` tagged template from `@/lib/neon`; no backticks inside SQL comments in templates.
  - `withAuth(withErrorHandler(…))`, `apiResponse`, `log` and never `console`; no empty catch.
  - ≤ 300 lines per file; full typing; TDD.
  - Migrations use `IF NOT EXISTS` and are never edited after apply.
  - `.claude.md` for a new module of ≥ 4 files, then `agent-docs:generate`.
- **Artefacts:** `/home/hein/.cache/redchk/budgets-p1/`, never `/tmp`.
- **Process:**
  - Do not edit the tree during a gate run.
  - No pattern kills.
  - Subagents never edit memory.
  - Cap parallel agents at ~12.
  - Reviewers get the diff and CLAUDE.md files only, never this session's reasoning.
