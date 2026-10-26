# Budgets P1: schema, versions and dimensions (spec)

**Date:** 2026-10-26 · **Parent:** `docs/plans/2026-10-26-budgets-next-level.md` §5 P1 · **Contract:** `docs/plans/budgets/00-shared-contract.md` (obeyed exactly; P1 owns the canonical names)
**Base:** `origin/master` 49d139b5e, migration head 946. **Goal file:** `.claude/handoffs/2026-10-26-budgets-P1-schema-versions-goal.md`
**Gates:** schema migration, so Hein gives an explicit OK before merge. It modifies existing production paths, so Hein reads the diff before `mq-isa add`. Adversarial (breaker) review is required on the migration, the lock trigger, RLS and the grain constraint.

Every existing path below was checked with `git ls-files | grep -F` on `origin/master`. **NEW** marks a file this phase creates.

## 1. What P1 delivers

1. `budget_versions` table (canonical columns plus the unlock columns in §3.1). Forced RLS in the 944 form.
2. `budget_month_amounts` gains `version_id NOT NULL`, `cc1_id`, `cc2_id`, `bu_id` and a stored `dim_grain`. The new unique key is NULLS NOT DISTINCT.
3. DB-enforced rules, all holding against app_user:
   - **Lock:** a locked version's amounts refuse INSERT, UPDATE and DELETE.
   - **Transitions:** only legal status moves are allowed; unlock needs a reason; every move writes its own audit row.
   - **Decision 4:** one grain per account per version, by exclusion constraint.
   - **Company consistency:** version, CC1, CC2, BU and based-on all belong to the row's company (composite FKs), and CC1/CC2 have the right `cc_type`.
4. Conversion: every existing month row goes to an "Original" version of its registry year (`approved`, `is_primary`). Count and sum parity per company and per company+account, compared through the primary-version read path. Any mismatch fails the migration.
5. Services in the new home `src/modules/accounting/services/budgets/`:
   - versions: list, get, create, copy, set primary, delete;
   - status: approve, lock, unlock. Role rules from decision 1, CAS on status, `updated_at` bumped.
6. Every existing reader reads the **primary** version, or a named `versionId`, so today's numbers do not change. Every existing writer writes the primary version, auto-created when missing, and is refused with a typed 409 when that version is locked.
7. API: `pages/api/accounting/budget-versions/**` (list, create, get, delete, copy, set primary, status).
8. Docs: `budgets/.claude.md` NEW, plus entries in `core/.claude.md` and `reports/.claude.md`. Run `bun run agent-docs:generate`.

**No UI changes in P1.** The budgets page and BvA must look and behave exactly as today. The versions bar is P2.

**Strongest argument against this design:** the lock is a trigger, and under the S-07 threat model only privileges hold. An app_user session can always run the legal unlock transition (`locked → approved`) itself, with a forged actor, because the owner-only role check is app-side.
- What the DB guarantees: locked amounts cannot change *while locked*. Getting out of locked needs a reason and always leaves an audit row that the app pool cannot delete (audit_log is SELECT/INSERT only for app_user).
- What the DB does not guarantee: that the person who unlocked was an owner.
- Making that unforgeable would mean moving transitions to `migrationAdminPool()`. That is disproportionate for a one-finance-user MVP, so it stays an open question for Hein (§12 Q1).

## 2. Facts resolved from the repo

| Question | Answer | Evidence |
|---|---|---|
| Business-units table | `business_units` (`id, company_id, code, name, …`). CC1 and CC2 are both `cost_centres` rows, distinguished by `cc_type` `'cc1'` / `'cc2'`. Journal validation requires `cc_type = type` exactly; NULL is refused. | `scripts/migrations/sql/285_cc_bu_dimensions.sql`, `882_journal_line_dimension_fks.sql`, `src/modules/accounting/services/gl/journalCostCentreValidation.ts:54` |
| Prod / dev Postgres | **PostgreSQL 15.8** (`supabase/postgres:15.8.1.085`, one shared cluster) | `docs/runbooks/s07b-app-pool-login-roles.md:531`, `docs/runbooks/supautils-grant-public-segfault.md:11`, `docs/audits/remediation/R-195/fix.md:8` |
| CI Postgres | PostgreSQL 16 throwaway clusters | `.github/workflows/ci.yml:76`, CLAUDE.md |
| NULLS NOT DISTINCT | PG15+ for both unique constraints and indexes, so it is supported on prod and CI. **Use it.** No COALESCE-sentinel index is needed. The fallback is recorded in §3.4 in case prod is ever downgraded. | as above. Precedent of PG15-only syntax in prod: `903_categorization_decisions.sql`, `854_payment_request_invoice_company_fk.sql` (column-list `ON DELETE SET NULL`) |
| btree_gist (for the exclusion) | Installed in baseline and prod; `uuid WITH =` and `<>` exclusion already live | `scripts/migrations/sql/644_loan_gl_postings_period_once.sql`, `502_fiscal_periods_no_overlap.sql`, baseline `CREATE EXTENSION IF NOT EXISTS btree_gist` |
| Login role / bypass | Prod pool logs in as `isaflow_service`. It inherits `app_service`, owns nothing and has no BYPASSRLS, so it cannot `DISABLE TRIGGER`. A trigger that branches only on **row data** (not `current_user`, claims or GUCs) holds. | `src/lib/neon.claude.md` "Login role (S-07b)"; memory `feedback_runtime_role_guard_beaten_by_set_config` |
| Definer registry | Any SECURITY DEFINER function needs an `app_definer_reviews` row. **P1 creates no definer:** every function is SECURITY INVOKER, so no registry rows are needed. Test 14 asserts this. | `930_credential_membership_writes_off_app_pools.sql`, `940_fiscal_years.sql:707` |
| app_service policies | Generated for every new RLS table by `public.app_service_sync_policies()`, which every migration run calls. Use the 944/897 tenant predicate verbatim so `s07b-app-pool-login-role.policies.int.test.ts` needs no new review entry. | `src/lib/neon.claude.md` |
| Audit table | `audit_log`. The `action` CHECK admits `create, update, delete, post, reverse, approve, reject, login, export`, with **no `lock` or `unlock`**. app_user has SELECT and INSERT only. `entity_type 'budget'` is already in the filter list. | baseline `audit_log_action_check`; `pages/accounting/audit-log.tsx:166`; `src/modules/accounting/services/core/auditTrailService.ts` (`logAuditOrThrow`) |
| Migration prefix | Next free = **947** on `origin/master` today. Re-check at commit time with `git ls-tree --name-only origin/master scripts/migrations/sql/` plus open PRs (`gh pr list --state open --json files`). Take the next unused prefix if 947 is gone. | CLAUDE.md migrations rule |

## 3. DDL sketch: `scripts/migrations/sql/947_budget_versions.sql` (NEW)

`947` here and below stands for the next free prefix **at commit time** (947 was free on 2026-10-26). If it has gone, rename the file and every `947` string in it (`system:migration-947`, `947 verification failed`, notices) — contract "Migration prefixes".

One file, one transaction (`apply-migrations.ts`). Header comment in the 944 style: WHY, LOCKS, CONVERSION, ROLLBACK, BACKWARD COMPATIBILITY (§9). `SET LOCAL lock_timeout = '5s';` at the top. If it trips, the file rolls back whole; rerun it.

### 3.1 `budget_versions`

```sql
CREATE TABLE IF NOT EXISTS budget_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_year INTEGER NOT NULL,                          -- registry LABEL (gl/fiscalYearRegistry), as accounting_budgets.fiscal_year
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  kind TEXT NOT NULL CHECK (kind IN ('original','reforecast','scenario')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','locked')),
  based_on_version_id UUID NULL,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  approved_by VARCHAR(255), approved_at TIMESTAMPTZ,
  locked_by VARCHAR(255),   locked_at TIMESTAMPTZ,
  unlocked_by VARCHAR(255), unlocked_at TIMESTAMPTZ, unlock_reason TEXT,   -- P1 additions (latest unlock; history is in audit_log)
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_versions_company_id_id UNIQUE (company_id, id),          -- target of the composite FKs
  CONSTRAINT budget_versions_name_per_year UNIQUE (company_id, fiscal_year, name),
  CONSTRAINT budget_versions_based_on_same_company
    FOREIGN KEY (company_id, based_on_version_id) REFERENCES budget_versions (company_id, id)
    ON DELETE SET NULL (based_on_version_id)                                -- PG15+ column list; plain SET NULL would null company_id
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_versions_one_primary  ON budget_versions (company_id, fiscal_year) WHERE is_primary;
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_versions_one_original ON budget_versions (company_id, fiscal_year) WHERE kind = 'original';
ALTER TABLE budget_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON budget_versions;
CREATE POLICY tenant_isolation ON budget_versions FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_versions TO app_user;   -- UPDATE also needed for the trigger's FOR SHARE (row locks need UPDATE)
CREATE TRIGGER trg_budget_versions_updated_at BEFORE UPDATE ON budget_versions FOR EACH ROW EXECUTE FUNCTION accounting_updated_at();
```

Use `DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER`, as 944 does.

### 3.2 Guard trigger on `budget_versions` (SECURITY INVOKER, data-only branches)

`public.budget_versions_guard()`, `BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW`, then `ALTER TABLE budget_versions ENABLE ALWAYS TRIGGER …` (the 940 pattern: it still fires under `session_replication_role = replica`). Every refusal uses `ERRCODE = 'BV002'` (illegal transition / immutable field) unless noted.

- **INSERT**
  - `status = 'locked'` is refused.
  - `status = 'approved'` requires `approved_by` and `approved_at` to be NOT NULL. Only the migration and copy-of-approved paths ever insert approved.
  - `unlock_*` must be NULL.
- **UPDATE**
  - Immutable: `id, company_id, fiscal_year, kind, based_on_version_id, created_by, created_at`.
  - While `OLD.status = 'locked'`, the only changes allowed are `is_primary`, `updated_at`, or the unlock transition. A rename is refused.
  - Legal status moves:

    | From → to | Requirement |
    |---|---|
    | same → same | none |
    | `draft → approved` | `approved_by` and `approved_at` NOT NULL |
    | `approved → locked` | `locked_by` and `locked_at` NOT NULL |
    | `locked → approved` | `unlocked_by` and `unlocked_at` NOT NULL, and `btrim(unlock_reason) <> ''` (ERRCODE `23514`) |

  - Anything else is refused, including `draft → locked`, `approved → draft` and `locked → draft`.
- **DELETE:** `OLD.status = 'locked'` is refused with `BV001`. Draft and approved versions may be deleted at DB level; the service narrows this further (§6). A locked version therefore also blocks a company cascade delete: QA purge scripts unlock first. This is noted in §9.

`public.budget_versions_audit()`, `AFTER UPDATE OF status FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)`, ENABLE ALWAYS. It runs as invoker and inserts one `audit_log` row:
- `company_id = NEW.company_id`, `entity_type 'budget'`, `entity_id NEW.id`, `entity_ref = 'FY' || fiscal_year || ' ' || name`;
- `action`: `'approve'` for draft→approved, `'update'` for lock and unlock (the action CHECK has no lock or unlock; P1 does **not** widen it);
- `user_id` = `NEW.approved_by` / `locked_by` / `unlocked_by` (column data, never a GUC);
- `changes = {fields:[{field:'status',old,new,label:'Status'}], metadata:{transition:'approve'|'lock'|'unlock', reason?, fiscalYear, versionName}}`.

The DB writes the audit row, so no app path can transition without one. A session whose claims do not admit the audit_log insert fails the transition (fail-closed).

### 3.3 `budget_month_amounts` changes

```sql
ALTER TABLE budget_month_amounts
  ADD COLUMN IF NOT EXISTS version_id UUID,             -- NOT NULL after conversion (§4)
  ADD COLUMN IF NOT EXISTS cc1_id UUID,
  ADD COLUMN IF NOT EXISTS cc2_id UUID,
  ADD COLUMN IF NOT EXISTS bu_id UUID,
  ADD COLUMN IF NOT EXISTS dim_grain SMALLINT GENERATED ALWAYS AS (
    (CASE WHEN cc1_id IS NOT NULL THEN 1 ELSE 0 END)
  + (CASE WHEN cc2_id IS NOT NULL THEN 2 ELSE 0 END)
  + (CASE WHEN bu_id  IS NOT NULL THEN 4 ELSE 0 END)) STORED;

-- Company consistency by composite FK (RI checks run as owner, race-safe, no trigger needed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_centres_company_id   ON cost_centres   (company_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_units_company_id ON business_units (company_id, id);
ALTER TABLE budget_month_amounts
  ADD CONSTRAINT budget_month_amounts_version_fk FOREIGN KEY (company_id, version_id) REFERENCES budget_versions (company_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT budget_month_amounts_cc1_fk FOREIGN KEY (company_id, cc1_id) REFERENCES cost_centres (company_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT budget_month_amounts_cc2_fk FOREIGN KEY (company_id, cc2_id) REFERENCES cost_centres (company_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT budget_month_amounts_bu_fk  FOREIGN KEY (company_id, bu_id)  REFERENCES business_units (company_id, id) ON DELETE RESTRICT;
-- (each ADD guarded by a pg_constraint NOT EXISTS check, 882 style, so a rerun is a no-op)
CREATE INDEX IF NOT EXISTS idx_bma_cc1 ON budget_month_amounts (cc1_id) WHERE cc1_id IS NOT NULL;   -- RESTRICT lookups on master delete
CREATE INDEX IF NOT EXISTS idx_bma_cc2 ON budget_month_amounts (cc2_id) WHERE cc2_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bma_bu  ON budget_month_amounts (bu_id)  WHERE bu_id  IS NOT NULL;
```

Why composite FKs instead of the brief's "company-consistency trigger" for version, CC and BU:
- They are checked by RI as the owner, with `FOR KEY SHARE` on the parent, so a concurrent master delete cannot slip between check and commit.
- They cannot be steered by RLS visibility.
- MATCH SIMPLE skips them when the dimension is NULL.

The existing `budget_month_amounts_same_company` trigger (944) stays unchanged for `gl_account_id`. A trigger stays only where a FK cannot express the rule, `cc_type`:
- `public.budget_month_amounts_dimension_kinds()`, `BEFORE INSERT OR UPDATE OF cc1_id, cc2_id`.
- It refuses when `cc1_id` names a `cost_centres` row whose `cc_type IS DISTINCT FROM 'cc1'`, or `cc2_id` one whose `cc_type IS DISTINCT FROM 'cc2'` (ERRCODE `23514`). This mirrors `journalCostCentreValidation`.
- It reads `cost_centres` by `(company_id, id)`. The composite FK has already proven the row is the company's, so RLS visibility cannot turn a refusal into a pass.

### 3.4 Unique key and grain constraint (after conversion, §4)

```sql
ALTER TABLE budget_month_amounts ALTER COLUMN version_id SET NOT NULL;
ALTER TABLE budget_month_amounts ADD CONSTRAINT budget_month_amounts_one_per_cell
  UNIQUE NULLS NOT DISTINCT (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month);
ALTER TABLE budget_month_amounts ADD CONSTRAINT budget_month_amounts_one_grain
  EXCLUDE USING gist (version_id WITH =, gl_account_id WITH =, dim_grain WITH <>);
ALTER TABLE budget_month_amounts DROP CONSTRAINT IF EXISTS budget_month_amounts_one_per_month;
CREATE INDEX IF NOT EXISTS idx_bma_version_month ON budget_month_amounts (version_id, month);
```

- Writers use `ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell`. The constraint is named, so no column-list inference is needed.
- **Fallback (only if prod ever runs on PG < 15):** replace the constraint with `CREATE UNIQUE INDEX … (company_id, version_id, gl_account_id, COALESCE(cc1_id,'00000000-0000-0000-0000-000000000000'::uuid), COALESCE(cc2_id,…), COALESCE(bu_id,…), month)`, and have writers name the same expressions in `ON CONFLICT (…)`. Not built in P1.

**Decision 4 mechanism and race safety.** Grain is the set of dimension kinds an amount row uses (`dim_grain` 0 to 7). Within one `(version_id, gl_account_id)`, every row must carry the same `dim_grain`, so company level (0) cannot coexist with by-CC1 (1), by-BU (4) and so on. Many CC1 members at grain 1 are fine.
- **Exclusion instead of a trigger with an advisory lock.** A GiST exclusion constraint checks each new row against committed **and in-flight** rows. A concurrent insert of a conflicting grain waits for the other transaction (like a unique index), then fails `23P01` if that transaction committed, or proceeds if it rolled back.
- So it is race-safe by construction, with no lock-ordering census and no bookkeeping table that deletes would have to release. Deleting every row of a grain frees the account for another grain automatically, in the same transaction, which is P2's "change grain = delete then upsert in one batch".
- Error: SQLSTATE `23P01`, `constraint_name = 'budget_month_amounts_one_grain'`. The service maps it to `BUDGET_GRAIN_CONFLICT` (400, account named).
- The table is small (one row per company × account × month), so the ACCESS EXCLUSIVE build is milliseconds.

### 3.5 Lock trigger on amounts

`public.budget_month_amounts_refuse_locked()`, `BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW`, `ENABLE ALWAYS`. SECURITY INVOKER; it branches only on version row data.

```text
IF TG_OP IN ('INSERT','UPDATE'):
   SELECT status INTO s FROM budget_versions WHERE id = NEW.version_id AND company_id = NEW.company_id FOR SHARE;
   IF NOT FOUND -> RAISE 'budget version % not found for company %' ERRCODE '23503'   (fail closed: an RLS-hidden version is never "unlocked")
   IF s = 'locked' -> RAISE 'budget version % is locked' ERRCODE 'BV001'
IF TG_OP IN ('UPDATE','DELETE') (OLD side; for UPDATE only when OLD.version_id differs or always — always is simpler):
   SELECT status INTO s FROM budget_versions WHERE id = OLD.version_id AND company_id = OLD.company_id FOR SHARE;
   IF FOUND AND s = 'locked' -> RAISE … 'BV001'
   IF NOT FOUND AND TG_OP = 'UPDATE' -> RAISE '23503'
   IF NOT FOUND AND TG_OP = 'DELETE' -> allow   (FK cascade of a version delete: the parent is already gone in this
                                               statement, and the guard (§3.2) only lets non-locked versions be deleted)
RETURN COALESCE(NEW, OLD)
```

**Race safety of the lock.** `FOR SHARE` on the version conflicts with the `FOR NO KEY UPDATE` that the lock transition's `UPDATE budget_versions SET status='locked'` takes.
- A writer in flight blocks the locker until it commits, so its rows are in before the lock.
- A lock in flight blocks the writer. Under READ COMMITTED the writer then re-reads the updated row, sees `locked`, and fails `BV001`.
- The FK's own `FOR KEY SHARE` is not enough, because a status UPDATE is not a key update. This is why the explicit `FOR SHARE` is required (test 3 mutates it away).

**Upgrade-deadlock rule (binding on every service writer, and P2's `gridSave`).** A writer must lock the version row **first**, with `UPDATE budget_versions SET updated_at = clock_timestamp() WHERE id = $v AND company_id = $c AND status <> 'locked' RETURNING …`, inside the bounded wait of `src/modules/accounting/services/core/rowLockBudget.ts` (`withRowLockBudget`). Only then does it write amounts. Two writers that each took `FOR SHARE` (via the trigger) and then tried to UPDATE the version would deadlock. Pre-locking also turns "locked" into a typed 409 **before** any write, so the request transaction is never poisoned by the trigger's error. The trigger stays as the backstop.

Not covered by the trigger: `TRUNCATE`. app_user has no TRUNCATE grant (944 grants SIDU only); test 14 asserts that.

### 3.6 NL query surface

`nlQueryValidationService` allowlists `budget_month_amounts`. Once versions exist, an LLM-written `SUM(amount)` over it would add drafts and reforecasts together. **[agent decides, one of these two, never neither]:**
- (a) **Default:** add `CREATE OR REPLACE VIEW budget_primary_month_amounts WITH (security_invoker = true) AS SELECT bm.* FROM budget_month_amounts bm JOIN budget_versions v ON v.id = bm.version_id AND v.company_id = bm.company_id WHERE v.is_primary;` with `GRANT SELECT … TO app_user`. Swap the allowlist entry to the view, and add the hand-carried FK pair `budget_primary_month_amounts.gl_account_id|gl_accounts.id` (the `bank_transactions_posted` precedent in `nlQueryFkPairs.ts`).
- (b) Drop `budget_month_amounts` from the allowlist and the FK pair.

## 4. Conversion and parity (inside 947)

Functions, all SECURITY INVOKER, `SET search_path = pg_catalog, public, pg_temp`, `REVOKE ALL … FROM PUBLIC`. They are callable per company so the integration suites can run them on synthetic rows (the 944 pattern).

- **`public.budget_version_original(p_company uuid, p_fiscal_year int, p_actor text) RETURNS uuid`**
  - Returns the year's primary version.
  - When the year has none, it creates `name 'Original', kind 'original', status 'approved', is_primary true, approved_by = p_actor, approved_at = now(), created_by = p_actor`, via `INSERT … ON CONFLICT (company_id, fiscal_year) WHERE is_primary DO NOTHING` and then a SELECT.
  - If the year has a primary that is **not** `kind='original'`, it returns that one. This cannot happen during conversion; documented for the redefined 944 function.
- **`public.budget_versions_from_months(p_company uuid DEFAULT NULL) RETURNS int`**
  - For each distinct `(company_id, month)` with `version_id IS NULL`, it takes the label from `(SELECT fiscal_year FROM public.fiscal_year_for_date(company_id, month))`.
  - **Any registry exception propagates**, re-raised with the company and month named. It fails loudly: no calendar fallback, unlike 944's notes headers.
  - It then sets `version_id = budget_version_original(company, label, 'system:migration-947')` for those rows, and returns the rows updated.
- **`public.budget_versions_snapshot(p_company uuid DEFAULT NULL) RETURNS jsonb`**
  - Returns `{company_id: {n, total, accounts: {gl_account_id: total}}}` over **all** rows.
- **`public.budget_versions_parity_mismatches(p_before jsonb, p_company uuid DEFAULT NULL) RETURNS int`**
  - Recomputes the same shape **only through the primary read path**: rows joined to `budget_versions v` with `v.is_primary`, where `v.fiscal_year` equals the registry label of the row's month.
  - Returns the number of companies, or company+account pairs, whose count or sum differs. Also counts rows still holding `version_id IS NULL`.

DO block, in this order:

```text
before := budget_versions_snapshot(NULL);
converted := budget_versions_from_months(NULL);           RAISE NOTICE '947: % budget months assigned to versions', converted;
bad := budget_versions_parity_mismatches(before, NULL);
IF bad > 0 THEN RAISE EXCEPTION '947 verification failed: % company or account budget totals/counts differ after conversion', bad;
RAISE NOTICE '947: % Original versions created', (SELECT count(*) FROM budget_versions WHERE created_by = 'system:migration-947');
```

Then §3.4 runs: SET NOT NULL, the unique and exclusion constraints, and dropping the old constraint. SET NOT NULL is a second loud check.

Notes:
- The conversion UPDATE fires `accounting_updated_at`, so converted rows' `updated_at` becomes the deploy time. This is accepted and documented in the header; `created_at` is untouched.
- **944's one-shot `public.budget_months_from_legacy`** still INSERTs without `version_id` and with `ON CONFLICT (company_id, gl_account_id, month)`. After 947 it would fail with 42P10, and the 944 suites (`tests/integration/budgets-legacy-conversion.int.test.ts`, `…-registry.int.test.ts`, `…-legacy-headers.int.test.ts`) call it on the post-947 schema.
  - 947 therefore `CREATE OR REPLACE`s it with the body unchanged except the INSERT. The INSERT adds `version_id = budget_version_original(company, registry label of month_date, created_by)` and uses `ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell DO NOTHING`.
  - Applied migration files are never edited; this is a redefinition in a new file.
  - If a 944 registry case depends on a month the registry cannot place, that case now fails loudly. Update its expectation and say so in the PR (reviewer checks it). **[agent decides]**
- Pre-flight census (read-only, on a **pg_dump clone** of dev in a throwaway cluster, never on dev or prod directly): `SELECT company_id, month FROM budget_month_amounts` where `fiscal_year_for_date` raises. Expect 0. A non-zero result is a Confirmation Gate.

## 5. Readers and writers changed (complete list)

`grep -rn "budget_month_amounts" pages src` on master finds two SQL owners. Every other surface reaches them transitively. Each must keep identical numbers when only primaries exist.

| # | File (exists) | Change |
|---|---|---|
| R1 | `src/modules/accounting/services/core/budgetService.ts` | `loadEntries` (both queries) filters `bm.version_id = <scope>`. `getBudgets` / `getBudgetsForYear` take an optional `versionId` (default: the year's primary; no primary → empty months, as today). `upsertBudget` resolves the primary (auto-creating `Original`, `draft`, `is_primary`, so an unbudgeted year stays editable as today) or the named version. It pre-locks per §3.5, writes `version_id` with the new `ON CONFLICT ON CONSTRAINT`, and writes one audit row (`logAuditOrThrow`, entity `'budget'`, entity_id version id, action `update`, metadata `{glAccountId, fiscalYear, months, total}`). `deleteBudget` deletes only the primary's company-grain rows of that account and year (pre-lock, audit `delete`). `copyBudgets` copies primary(from) → primary(to, auto-created), keeping dims, with `ON CONFLICT ON CONSTRAINT … DO NOTHING` (pre-lock target, audit `create`). The file is 240 lines today: move version resolution into `budgets/budgetVersionScope.ts` to stay ≤ 300. |
| R2 | `src/modules/accounting/services/reports/budgetWindowService.ts` | `loadWindowBudgets(companyId, start, end, versionId?)` joins `unnest(scope)` from `primaryVersionScope(companyId, start, end)`. The scope is one `{versionId, first, last}` per registry year overlapping the window, each clipped to that year's months, so **a primary contributes only months inside its own fiscal year** and a window spanning two years takes each year's primary. With `versionId` the scope is that one version clipped to its year. It still sums all grains: company total = Σ dimension rows (roll-up, R1). |
| R3 | transitive, no edit expected (verify) | `pages/api/accounting/reports-budget-vs-actual.ts`, `pages/api/accounting/budget-vs-actual-export.ts`, `src/modules/accounting/services/reports/budgetVarianceService.ts` → `pages/api/accounting/reports-budget-comparator.ts`, `src/lib/mcp/tools/budgetVariance.ts`, `src/modules/accounting/services/packs/figures/packFigureSet.ts`. Version and dimension parameters on these are **P3**, not P1. |
| R4 | `pages/api/accounting/budgets.ts` | GET accepts optional `?versionId` (`isUuidParam`, must belong to company and year, else 404). POST body accepts optional `versionId`. `BudgetLockedError` → 409 `BUDGET_VERSION_LOCKED`; grain → 400 `BUDGET_GRAIN_CONFLICT`. |
| R5 | `pages/api/accounting/budgets-action.ts` | Maps the same typed errors (today only `BudgetInputError` is a 400). |
| R6 | `src/modules/accounting/services/core/costCentreUsageGuard.ts` | Count `budget_month_amounts` rows on `cc1_id`/`cc2_id` (company-scoped) as a named refusal ("budget amount(s)"), so a delete is refused readably instead of a raw 23503. |
| R7 | `src/modules/accounting/services/core/businessUnitService.ts` | Same for `bu_id` in the delete-usage query. **At 283 lines:** extract the usage query to a sibling (e.g. `businessUnitUsage.ts` NEW) to stay ≤ 300. |
| R8 | `src/modules/accounting/services/gl/fiscalPeriodReferences.ts` | `budgets` counts `accounting_budgets` **+ `budget_versions`**, both keyed by fiscal-year number. Update the header comment. |
| R9 | `src/modules/accounting/services/core/nlQueryValidationService.ts`, `src/modules/accounting/services/core/nlQueryFkPairs.ts` | §3.6. |
| R10 | Test fixtures that INSERT amounts directly: `tests/integration/helpers/budgetLegacyFixture.ts`, `tests/integration/helpers/budgetsRouteFixture.ts`, `tests/integration/budgets-report-year.int.test.ts`, `tests/integration/budgets-action-route.int.test.ts`, `tests/unit/helpers/budgetServiceDbFixture.ts` | Create or resolve a version and pass `version_id`. Census with `git grep -n "INSERT INTO budget_month_amounts" tests`. |

Unchanged on purpose:
- `accounting_budgets` stays the per-account, per-year notes header, shared by all versions of the year. Per-version notes are a P2 question.
- The account merge (`gl/accountMergeReferences.ts`) already refuses on any `budget_month_amounts.gl_account_id` reference, and P1 adds no gl_accounts FK.
- The gl_accounts `ON DELETE CASCADE` stays. A locked version's rows make an account delete fail with `BV001`, which is correct.

## 6. Service and API shape

Directory `src/modules/accounting/services/budgets/` (NEW). The names match what P2's spec expects (`P2-budget-grid-spec.md` §3).

| File | Exports | ≈ lines |
|---|---|---|
| `budgetVersionTypes.ts` NEW | `BudgetVersion {id, fiscalYear, name, kind, status, basedOnVersionId, isPrimary, approvedBy, approvedAt, lockedBy, lockedAt, unlockedBy, unlockedAt, unlockReason, createdBy, createdAt, updatedAt /* text, microseconds */, amountCount, total}`; `BudgetVersionError extends Error {code: 'BUDGET_VERSION_LOCKED'\|'BUDGET_VERSION_STALE'\|'BUDGET_VERSION_STATE'\|'BUDGET_VERSION_FORBIDDEN'\|'BUDGET_VERSION_NOT_FOUND'\|'BUDGET_GRAIN_CONFLICT'\|'BUDGET_VERSION_INPUT', status: 400\|403\|404\|409}`; `mapBudgetDbError(err)` (SQLSTATE `BV001` → LOCKED; `BV002` → STATE; `23P01` + `budget_month_amounts_one_grain` → GRAIN; anything else rethrown) | 90 |
| `budgetVersionScope.ts` NEW | `resolvePrimaryVersion(companyId, fiscalYear, {create, actor})`, `lockVersionForWrite(companyId, versionId)` (§3.5 pre-lock under `withRowLockBudget`), `primaryVersionScope(companyId, start, end)`, `namedVersionScope(companyId, versionId)` | 150 |
| `budgetVersions.ts` NEW | `listVersions(companyId, fiscalYear?)`, `getVersion`, `createVersion(companyId, {fiscalYear, name, kind, basedOnVersionId?}, actor)` (draft; registry label must exist; second `original` → 409), `copyVersion(companyId, sourceId, {name, kind}, actor)` (same fiscal year, draft, `based_on` = source, copies every row and grain in one INSERT … SELECT; reports count and sum), `setPrimary(companyId, versionId, actor)` (one tx: clear the old primary, set the new one; partial index backstop), `deleteVersion(companyId, versionId, actor)` (not primary, not locked; draft: any writer; approved: owner/admin). Each writes `logAuditOrThrow` (create / update / delete). | 250 |
| `budgetVersionStatus.ts` NEW | `transitionVersion(companyId, versionId, {action: 'approve'\|'lock'\|'unlock', reason?, expectedUpdatedAt?}, actor: {userId, role})`. Roles: approve and lock need owner or admin; unlock needs owner, and `reason` (trimmed, 1–500 chars) is mandatory. CAS: `UPDATE … SET status, *_by, *_at[, unlock_reason] WHERE id AND company_id AND status = <expected>[ AND updated_at = $expected] RETURNING …`. Zero rows → re-read → 404, STATE or STALE. The audit row is the trigger's (§3.2); **no** second app audit row. | 150 |
| `index.ts` NEW | Barrel: re-exports the four files above plus `core/budgetService`, `core/budgetMonths`, `core/budgetYears`, `reports/budgetWindowService`, `reports/budgetVarianceService`. | 20 |
| `.claude.md` NEW | Purpose, caller contract (primary unless `versionId`; pre-lock before writes; typed errors; roll-ups are computed, never stored), the main signatures, business rules (decisions 1–4), recent changes. | ≤ 50 |

**Move decision.** P1 does **not** move the existing `core/budget*.ts` / `reports/budget*.ts` files: 36 files import them and 5 test files `vi.mock` their paths, so a move is churn with mock-path risk. The barrel `budgets/index.ts` is the entry point for P2 and later code. `budgets/.claude.md` records this, and a later cleanup PR may move the files behind the barrel.

**Routes** (NEW). All are `withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))` on writes, following `budgets-action.ts`. The role comes from `req.companyRole`, and `apiResponse` is used throughout. Register the response shapes in `src/lib/apiRoutes.ts`: it is a partial typed map (33 `/api/accounting/*` entries on 2026-10-26), so add an entry for each new route a client reads with `apiJson`.

| Route | Method | Body / query → response |
|---|---|---|
| `pages/api/accounting/budget-versions/index.ts` | GET | `?fiscalYear` (optional) → `{items: BudgetVersion[]}` |
| | POST | `{fiscalYear, name, kind}` → 201 `BudgetVersion` |
| `pages/api/accounting/budget-versions/[id]/index.ts` | GET | → `BudgetVersion` |
| | DELETE | → `{deleted: true}` |
| `pages/api/accounting/budget-versions/[id]/status.ts` | POST | `{action, reason?, expectedUpdatedAt?}` → `BudgetVersion` |
| `pages/api/accounting/budget-versions/[id]/copy.ts` | POST | `{name, kind}` → 201 `BudgetVersion` |
| `pages/api/accounting/budget-versions/[id]/primary.ts` | POST | owner or admin → `BudgetVersion` |

Status codes:
- 400: input or grain conflict;
- 403: role;
- 404: not found, including another tenant's id (never 403);
- 409: locked, state or stale.

Errors are mapped only through `mapBudgetDbError`. An unknown DB error stays a 500 and rolls back.

If `pages/api/accounting/budget-versions/` reaches 4 or more files, add a sibling `.claude.md` (CLAUDE.md module-docs rule).

## 7. Task DAG

```
T0 census ─► T1 migration+schema tests ─► T2 scope+readers ─► T3 versions/status services+API ─┐
                    └──────────────────► T4 guards / fiscal refs / NL query ──────────────────────┴─► T5 docs ─► T6 gates+PR (STOP: Hein OK)
```

| Task | Work | verify: |
|---|---|---|
| T0 | Worktree, `cp -al` node_modules. Re-check the prefix. Grep readers and fixture INSERTs (§5). Confirm no `budgets/` dir on master. Pre-flight census (§4) on a pg_dump clone. | `git ls-tree --name-only origin/master scripts/migrations/sql/ \| tail -3` shows head < 947; `git grep -n "budget_month_amounts" pages src` matches §5 exactly; census = 0 rows |
| T1 | Tests 1–7, 11, 13, 14 first (red on master schema), then `947_budget_versions.sql` | `CI_INTEGRATION=1` run of the new suites: red before the migration file exists, green after; each §8 mutation turns its test red (log paths kept) |
| T2 | `budgetVersionScope.ts`, then R1, R2, R4, R5, R10. Test 8 first. | test 8 green; the existing `budgets-*.int.test.ts`, `budgetServiceDb`, `budgetVarianceDb`, `reportsBudgetComparator`, `budgetVarianceTool` suites green **unchanged in their assertions** (fixture edits only) |
| T3 | `budgetVersionTypes.ts`, `budgetVersions.ts`, `budgetVersionStatus.ts`, routes. Test 9 first. | test 9 green; `bun run type-check` |
| T4 | R6–R9. Tests 10 and 12 first. | tests 10 and 12 green |
| T5 | `budgets/.claude.md`, entries in `core/.claude.md` + `reports/.claude.md` (+ `gl/.claude.md` for R8), `bun run agent-docs:generate` | `bun run agent-docs:check` clean |
| T6 | `bun run ci`; `CI_INTEGRATION=1 bun run ci`; blind `/review`; adversarial breaker (own cluster, real-PG repros); security review. Every H/M/L fixed. PR. **STOP** for Hein's migration OK and diff read, then `mq-isa add`. | both CI runs show the passed line (grep it; the wrapper exit can mask failure); GitHub `quality` + `integration` green on the PR head |

## 8. Tests (real PostgreSQL, `tests/integration/`, NEW unless noted) and the mutation each catches

Run as app_user means `SET LOCAL ROLE app_user` + `set_config('request.jwt.claims', …)` + `set_config('app.current_company_id', …)`, the form used in `tests/integration/payroll-batches-rls.int.test.ts:39-41`. Every suite routes to the right fixture DB by the guard it calls (CLAUDE.md integration step).

| # | File | What it proves | Mutation that must turn it red |
|---|---|---|---|
| 1 | `budgets-versions-conversion.int.test.ts` | In a rolled-back tx, `version_id DROP NOT NULL`, then legacy-shaped rows: company A across 2 registry years (one a 14-month year), company B one year. Runs **the DO block extracted from 947 as shipped** (the `budgets-legacy-headers` pattern). Result: one approved primary `Original` per company+year; every row's version year = registry year of its month; per-company and per-account count+sum equal. | Converter files every row under the first year's version → per-year assertion red. Parity compares count only → a test-only AFTER UPDATE trigger that alters an amount during conversion makes the DO block raise `947 verification failed`; with the sum check removed it does not raise → red. |
| 2 | `budgets-version-lock.int.test.ts` | As **app_user**, on a locked version: INSERT, UPDATE amount, UPDATE `version_id` away, DELETE are each refused `BV001`. The same holds as the non-superuser table owner. If the cluster user is superuser, also under `session_replication_role = replica`. An unlocked sibling version stays writable. A FK cascade delete of a draft version passes. Deleting a locked version is refused. | Drop the trigger; drop the OLD-side check (DELETE passes); `ENABLE` instead of `ENABLE ALWAYS` (replica case passes); treat NOT FOUND on NEW as allow and point at an RLS-hidden version |
| 3 | `budgets-version-lock-race.int.test.ts` | Two connections. (a) A inserts an amount (open tx); B's `status='locked'` UPDATE waits, shown in `pg_locks`/`pg_stat_activity` `wait_event_type='Lock'`, then commits after A; A's row exists. (b) B locks (open); A's insert waits; B commits; A fails `BV001`. Bounded waits, no sleeps-as-proof. | Remove `FOR SHARE` from the trigger: (b) A succeeds after B commits → red |
| 4 | `budgets-version-transitions.int.test.ts` | Legal moves pass. `draft→locked`, `approved→draft` and `locked→draft` are refused `BV002`. Unlock without reason → `23514`; with reason it passes, and exactly one `audit_log` row (entity `budget`, metadata transition + reason, user_id = `unlocked_by`) is written **by the trigger**. Immutable columns are refused. INSERT `locked` is refused. Run as app_user. | Remove the reason check; remove the audit trigger (row count 0); allow `kind` change |
| 5 | `budgets-grain-exclusion.int.test.ts` | Company-level row, then a CC1 row, same version+account → `23P01` `budget_month_amounts_one_grain`. CC1=A and CC1=B rows coexist. Different grains in different versions pass. Delete all grain-0 rows, then insert grain-1 in the same tx → passes. **Race:** A inserts grain 0 (open), B inserts grain 1 and blocks; A commits → B `23P01`. Rerun with A rolled back → B succeeds. | Drop the constraint; define `dim_grain` from `cc1_id` only (a BU row then collides with nothing) |
| 6 | `budgets-amount-tenant-fks.int.test.ts` | As app_user **and** as owner: `version_id` of company B → `23503`; `cc1_id`/`cc2_id`/`bu_id` of company B → `23503`; a cc2-type centre in `cc1_id` → `23514`; `based_on_version_id` of B → `23503`. | Replace a composite FK with a plain `REFERENCES cost_centres(id)` → red |
| 7 | `budgets-unique-cell.int.test.ts` | Two company-level rows, same version/account/month → `23505` (NULLS NOT DISTINCT). Same cell in two versions passes. | Constraint without `NULLS NOT DISTINCT` → second insert passes → red |
| 8 | `budgets-primary-readers.int.test.ts` | Fixture → `getBudgetsForYear`, `loadWindowBudgets` and `getBudgetVariance` figures equal golden numbers taken **before** conversion. A draft reforecast with different amounts leaves all three unchanged; `versionId` returns the draft's. A window across two fiscal years takes each year's primary. A primary's row outside its year is ignored. | Drop the `is_primary` scope (draft is summed in); drop the per-year clipping |
| 9 | `budgets-versions-routes.int.test.ts` | Roles: admin approve/lock 200; accountant/viewer 403; admin unlock 403; owner unlock without reason 400, with reason 200. Upsert into the locked primary → 409 `BUDGET_VERSION_LOCKED` **with no write and the request tx still usable**. Grain clash → 400 naming the account. Copy reproduces count+sum. Second `original` → 409. Delete of primary or locked → 409. Two concurrent approves → one 200, one 409. Another tenant's id → 404. Each amount write → exactly one audit row. | Remove the route role check (403 test red); remove the pre-lock (trigger error poisons the tx → 500); remove the CAS predicate (double approve 200/200) |
| 10 | `budgets-dimension-usage-guards.int.test.ts` | Deleting a CC1, CC2 or BU that budget rows reference → the typed refusal names "budget amount(s)"; there is no raw 23503. | Remove the new count |
| 11 | `budgets-p1-old-code-compat.int.test.ts` | §9 contract. Master's pre-P1 SQL (copied verbatim from `git show <merge-base>:` of `budgetService.ts` / `budgetWindowService.ts` into the test as strings) runs against the post-947 schema with only converted primaries: reads give the pre-migration totals; the old upsert raises `42P10` and writes nothing. | (a) The converter INSERTs version copies instead of UPDATE-ing in place → old reads double → red. (b) `version_id` left nullable plus a default-filling trigger → the old upsert stops failing loudly → red |
| 12 | `tests/unit/services/nlQueryBudgetSurface.test.ts` | Allowlist contains the view (or neither) and **not** `budget_month_amounts`; the FK pair matches. | Re-add the base table |
| 13 | existing `budgets-legacy-conversion*.int.test.ts`, `budgets-legacy-headers.int.test.ts` | Still green on the redefined `budget_months_from_legacy` | n/a (guard) |
| 14 | `budgets-p1-catalog.int.test.ts` | Every function 947 creates has `prosecdef = false`; app_user has no TRUNCATE on either table; `budget_versions` has FORCE RLS and an `app_service_*` mirror; triggers are `tgenabled = 'A'`; existing `s07c-credential-writes.migration.int.test.ts` and `s07b-app-pool-login-role.policies.int.test.ts` green | Mark one function SECURITY DEFINER (catalog test red, s07c red) |

Do **not** apply 947 to `isaflow_dev` before merge. Applying it there breaks master's unit-db project for every peer's deploy gate (memory `feedback_dev_migrations_break_deploy_gate`); the deploy's parity gate applies it to dev at deploy time. Locally, the unit-db `budgetServiceDb.test.ts` stays red against dev until then. Prove it instead on a pg_dump clone with 947 applied, and say so in the PR.

## 9. Rollback and backward compatibility

`scripts/rollback-deploy.sh` reverts **code only, never migrations**. So the pre-P1 code must be safe on the post-947 schema:

| Old-code path | Behaviour on 947 schema | Why |
|---|---|---|
| All reads (`loadEntries`, `loadWindowBudgets` → BvA, export, comparator, MCP, packs) | **Identical numbers** while only converted primaries exist at company grain | Conversion only sets `version_id`; one row per company/account/month still |
| `upsertBudget`, `copyBudgets` | **Fail loudly** (`42P10`, plan time, nothing written) | Their `ON CONFLICT (company_id, gl_account_id, month)` has no matching constraint |
| `deleteBudget` | Works; deletes the account's months of the year **in every version** | Unscoped DELETE; refused (`BV001`) if any is locked |

The design keeps the failure modes **loud, never silent**:
- `version_id NOT NULL` means no old INSERT can create a versionless row.
- No default-filling trigger is added. It would hide a new writer that forgot `version_id` by landing its rows in the primary.

**Rollback runbook line** (goes in the 947 header and the PR):
- Before rolling back code, run `SELECT count(*) FROM budget_versions WHERE NOT is_primary` and `SELECT count(*) FROM budget_month_amounts WHERE dim_grain <> 0`. If both are 0, old reads are exact. Otherwise old reads over-count, so roll forward instead.
- Budget saves return 500 until roll-forward.

Manual schema rollback (not automated, Hein-approved only, valid only while both counts are 0):
1. Re-add `UNIQUE (company_id, gl_account_id, month)`.
2. Drop the one_grain and one_per_cell constraints, the FKs, the triggers and the view.
3. Drop the columns and `budget_versions`.
4. Restore 944's `budget_months_from_legacy` body.

## 10. Locks taken by 947

- `budget_month_amounts`: ACCESS EXCLUSIVE (generated column rewrite, constraints). The table is small.
- `cost_centres` and `business_units`: SHARE, for the new unique indexes. This blocks writes to those masters for milliseconds.
- The FK adds take SHARE ROW EXCLUSIVE on the masters. That does not conflict with the ROW SHARE that journal-line FK checks take.
- `lock_timeout 5s`. The file is idempotent: constraints are guarded by `pg_constraint` checks, `IF NOT EXISTS` is used everywhere, and the conversion only touches `version_id IS NULL` rows. On a trip, rerun it.

## 11. Out of scope (later phases)

- Grid, wizard and Excel (P2).
- Version and dimension parameters on BvA, the comparator, packs and MCP (P3).
- Drivers (P4).
- Dropping `accounting_budgets` dead columns.
- Widening the `audit_log` action CHECK.

## 12. Open questions for Hein

1. **Unlock authority under S-07.** The owner-only unlock is app-enforced, so a forged session could unlock (and is always audited). Is an app-side check plus a DB-written audit row enough for MVP, or should transitions move to `migrationAdminPool()`? Default: enough.
2. **Change of year end after versions exist.** A version is keyed by fiscal-year label. After a year-end change, a month can move into another label, and readers clip by registry year, so that month's amount silently stops counting. Default: P1 refuses nothing; P2 or the year-end change flow must re-home versions. Flag it on the 943 path?
3. **Deleting an approved version** (allowed for owner/admin when not primary and not locked; drafts by any writer — P2's versions bar and golden-spec cleanup follow this rule). Confirm, or restrict deletion to drafts only.
