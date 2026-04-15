# Prod Migration Go-Live Plan — 2026-04-15 Batch

**Batch scope:** Migrations 292_product_categories_company_id, 325, 326, 327, 328, 329, 330, 331, 332.
**Prior applied to prod:** none (all are Phase 3/4 dev-only changes).
**Tool:** `scripts/apply-migrations.ts`
**Drill evidence:** `docs/runbooks/pitr-restore-drill.md`, `docs/runbooks/rollback-rehearsal.md`
**Estimated total duration:** `<sum from drill timings per migration>`

> **Schema note (Task 6 finding):** `schema_migrations` identity is filename (`name`),
> not version. 9 historical migration files share numeric prefixes (245, 246, 250,
> 251, 255, 265, 266, 292, 300 — two files each). The runner handles this by
> tracking on filename. Verification queries below key on `name`.

---

## Pre-flight checklist
- [ ] PITR retention window on prod ≥ 24h (Neon console).
- [ ] Latest prod backup point noted (timestamp): `___________`
- [ ] Operator + one reviewer on call.
- [ ] Maintenance window scheduled (after hours; see CLAUDE.md production time gate rule).
- [ ] Hein has given explicit approval (required per CLAUDE.md).
- [ ] Dev tracking table populated (verify: `bun scripts/apply-migrations.ts --dry-run` against dev → toApply empty).
- [ ] Dry-run against prod-clone branch done; output matches this plan.
- [ ] On prod: confirm existing `schema_migrations` shape. If it has only
      `(filename, applied_at)` columns (like dev did), the runner's bootstrap
      will upgrade it in-place (adds name/version/checksum, drops filename PK/column).
      **Rehearse this upgrade on a prod-clone first.**

---

## Migration list (in order)

| Version | File                                                      | Change summary                                      | Expected duration | Lock behavior                             |
|---------|-----------------------------------------------------------|-----------------------------------------------------|-------------------|--------------------------------------------|
| 292     | `292_product_categories_company_id.sql`                   | Add `company_id` to `product_categories`            | `<from drill>`    | brief AccessExclusive on `product_categories` |
| 325     | `325_supplier_payment_allocations.sql`                    | Create table `supplier_payment_allocations`         | `<from drill>`    | none (new table)                           |
| 326     | `326_gl_journal_entries_company_date_posted_index.sql`    | Create composite index                              | `<from drill>`    | ShareUpdateExclusive                       |
| 327     | `327_vat_and_retained_earnings_subtypes.sql`              | Data backfill                                       | `<from drill>`    | row locks only                             |
| 328     | `328_bank_transactions_company_date_index.sql`            | Create composite index                              | `<from drill>`    | ShareUpdateExclusive                       |
| 329     | `329_gl_journal_lines_company_id.sql`                     | **STRUCTURAL** — column add + backfill + NOT NULL   | `<from drill — LONGEST>` | AccessExclusive then row locks        |
| 330     | `330_customer_invoices_coalesce_index.sql`                | Expression index                                    | `<from drill>`    | ShareUpdateExclusive                       |
| 331     | `331_rate_limit_counters.sql`                             | Create table `rate_limit_counters`                  | `<from drill>`    | none (new table)                           |
| 332     | `332_schema_migrations_tracking.sql`                      | Create/upgrade tracking table                       | < 1s              | none (new/altered table)                   |

**NOTE on 292:** There are TWO files with prefix `292` in the repo
(`292_composite_indexes_batch2.sql` and `292_product_categories_company_id.sql`).
Check prod's `schema_migrations` (or legacy `filename`) to see which one, if any,
is already applied. The runner keys on filename so both can coexist.

---

## Execution sequence

1. Put app in maintenance mode (if migration 329 is in scope — it locks `gl_journal_lines`).
2. Run: `DATABASE_URL=<prod> bun scripts/apply-migrations.ts --dry-run`.
3. Compare dry-run output to this plan. If mismatch → abort, investigate.
4. Run: `DATABASE_URL=<prod> bun scripts/apply-migrations.ts`.
5. Watch per-migration timing output; compare to "Expected duration" column.
6. On completion, run verification queries (below).
7. Take app out of maintenance mode.
8. Watch `/api/health/deep` and structured logs for 30 minutes.

---

## Verification queries

```sql
-- Migrations tracked (should show all 9 batch files)
SELECT name, version, applied_at
  FROM schema_migrations
 WHERE name IN (
   '292_product_categories_company_id.sql',
   '325_supplier_payment_allocations.sql',
   '326_gl_journal_entries_company_date_posted_index.sql',
   '327_vat_and_retained_earnings_subtypes.sql',
   '328_bank_transactions_company_date_index.sql',
   '329_gl_journal_lines_company_id.sql',
   '330_customer_invoices_coalesce_index.sql',
   '331_rate_limit_counters.sql',
   '332_schema_migrations_tracking.sql'
 )
 ORDER BY version;

-- 292: product_categories scoped
SELECT count(*) FROM product_categories WHERE company_id IS NULL;  -- expected: 0

-- 325: new table exists
SELECT to_regclass('supplier_payment_allocations') IS NOT NULL AS exists;  -- expected: true

-- 329: column exists, no NULLs
SELECT count(*) FROM gl_journal_lines WHERE company_id IS NULL;  -- expected: 0

-- 331: new table exists
SELECT to_regclass('rate_limit_counters') IS NOT NULL AS exists;  -- expected: true

-- 332: tracking works (dev has 121 files, prod count may differ)
SELECT count(*) FROM schema_migrations;
```

---

## Go / no-go criteria
- **Go** if all pre-flight checkboxes ticked AND drill evidence exists AND dry-run matches plan.
- **No-go** if ANY pre-flight item unchecked, dry-run deviates, or Hein approval missing.

## Abort criteria (during run)
- Any migration takes 3× expected duration → abort (Ctrl+C), trigger rollback per `rollback-rehearsal.md` path A.
- Verification query fails → abort, rollback.
- App health endpoint returns 503 post-migration → rollback.

## Who calls abort
Operator has authority to abort; reviewer must be informed. Full rollback decision requires both.

---

## Post go-live
- Update this doc with actual timings.
- Append outcome to `docs/audits/2026-04-15/phase4d-closeout.md`.
- Keep maintenance window log for 7 days (PITR retention).

---

## Actual execution evidence (fill during go-live)

**Date:** YYYY-MM-DD
**Operator:** `<name>`
**Reviewer:** `<name>`
**Maintenance window:** `HH:MM–HH:MM SAST`

**Per-migration actual timings:**

| File | Start (UTC) | Duration | Notes |
|------|-------------|----------|-------|
| 292_product_categories_company_id.sql                   |  |  |  |
| 325_supplier_payment_allocations.sql                    |  |  |  |
| 326_gl_journal_entries_company_date_posted_index.sql    |  |  |  |
| 327_vat_and_retained_earnings_subtypes.sql              |  |  |  |
| 328_bank_transactions_company_date_index.sql            |  |  |  |
| 329_gl_journal_lines_company_id.sql                     |  |  |  |
| 330_customer_invoices_coalesce_index.sql                |  |  |  |
| 331_rate_limit_counters.sql                             |  |  |  |
| 332_schema_migrations_tracking.sql                      |  |  |  |

**Verification query results:** pass / fail (detail any failure)

**/api/health/deep samples (post go-live, 30 min window):** `<paste>`

**Conclusion:** success / rolled back (path A or B, reason).
