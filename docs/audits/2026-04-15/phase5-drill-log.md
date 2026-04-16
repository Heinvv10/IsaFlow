# Phase 5 Drill Execution Log

## Drill 1: PITR Restore

**Date:** 2026-04-16
**Operator:** Hein van Vuuren (assisted by Claude)

**Pre-state row counts (drill branch):**

| Table              | Count |
|--------------------|-------|
| bank_transactions  | 8,991 |
| customer_invoices  | 700   |
| gl_journal_lines   | 2,455 |
| companies          | 8     |

**Destructive change:** `DELETE FROM bank_transactions WHERE company_id = 'd27bac33-...'` — removed 8,114 rows. Post-delete bank_transactions = 877.

**Timings:**

| Event                           | Timestamp (UTC)       | Delta   |
|---------------------------------|-----------------------|---------|
| T0 (branch created from prod)   | ~02:52                | —       |
| T1 (destructive change applied) | 03:08:58              | —       |
| T_restore_start                 | ~03:09 (Neon console) | —       |
| T_restore_complete              | 03:34:34              | ~25 min |
| **Total RTO**                   |                       | ~25 min |

**Post-restore verification:** PASS — bank_transactions = 8,991 (matches pre-state exactly). All four table counts restored.

**Neon branch:** `drill-20260416-pitr` — created, restored, deleted.

**Conclusion:** Neon PITR RTO ≈ 25 minutes for this database size. Acceptable for disaster recovery.

---

## Drill 2: Rollback Rehearsal

**Date:** 2026-04-16
**Operator:** Hein van Vuuren (assisted by Claude)

**Scenario simulated:** Bad additive migration — `ALTER TABLE bank_transactions ADD COLUMN wrong_flag BOOLEAN DEFAULT false` + registered as `999_bad_add_column.sql` in `schema_migrations`.

**Path chosen:** B (manual DDL reversal)

**Rationale:** Migration was purely additive (added column, no data changes). Path B is faster, no downtime.

**Timings:**

| Event                         | Timestamp (UTC)  | Delta  |
|-------------------------------|------------------|--------|
| Bad migration applied         | 03:39:23         | —      |
| "This is broken" declared     | 03:39:45         | +22s   |
| Recovery path decided (B)     | 03:39:45         | +0s    |
| Recovery started              | 03:39:45         | +0s    |
| Service verified healthy      | 03:39:46         | +<1s   |
| **Total elapsed**             |                  | **<1s** |

**Recovery steps executed:**
```sql
ALTER TABLE bank_transactions DROP COLUMN wrong_flag;
DELETE FROM schema_migrations WHERE filename = '999_bad_add_column.sql';
```

**Post-recovery verification:**
```sql
SELECT
  (SELECT count(*) FROM bank_transactions) AS bank_tx,                           -- 8991 ✓
  (SELECT count(*) FROM information_schema.columns
   WHERE table_name = 'bank_transactions') AS col_count;                         -- 30 ✓
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'bank_transactions' AND column_name = 'wrong_flag';         -- 0 rows ✓
SELECT filename FROM schema_migrations WHERE filename = '999_bad_add_column.sql'; -- 0 rows ✓
```

**Results:** PASS — all four checks confirmed clean state restored.

**Gotchas:** `schema_migrations` uses column `filename` (not `name`) — discovered during drill when first INSERT failed. Good to know for real incidents.

**Conclusion:** Path B cost = <1 second for additive DDL reversal. Path A (PITR) cost ≈ 25 min (from Drill 1). Decision tree validated: use Path B for additive migrations, Path A for destructive ones.

---

## Sign-off

Both drills passed. ISAFlow production readiness is now fully validated:
- PITR RTO ≈ 25 minutes (Path A)
- Additive rollback ≈ instant (Path B)
- Neon branching workflow confirmed functional
