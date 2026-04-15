# PITR Restore Drill

**Purpose:** Validate we can point-in-time restore prod-sized data within a known RTO.

**Retention window on current Neon plan:** 7 days.

## Pre-flight
- [ ] Confirm Neon plan has branch capacity (console → Branches).
- [ ] Calendar block 2h to avoid bill surprise from forgotten branch.
- [ ] Note current prod tip timestamp T0 (UTC).

## Drill procedure

### 1. Create prod-clone branch
- Neon console → Branches → Create branch from `production` at timestamp T0.
- Name: `drill-YYYYMMDD-pitr`.
- Record connection string into `.env.drill` (NOT committed).

### 2. Capture pre-state
Run against clone:

```sql
SELECT
  (SELECT count(*) FROM bank_transactions) AS bank_tx,
  (SELECT count(*) FROM customer_invoices) AS inv,
  (SELECT count(*) FROM gl_journal_lines) AS gl_lines,
  (SELECT count(*) FROM companies) AS companies;
```

Record row counts below.

### 3. Apply destructive change
Run against clone at T1 (note timestamp):

```sql
BEGIN;
DELETE FROM bank_transactions WHERE company_id = (SELECT id FROM companies LIMIT 1);
COMMIT;
```

Verify row count drop with same query as step 2.

### 4. Invoke PITR
- Neon console → Branches → `drill-YYYYMMDD-pitr` → Restore → select timestamp just before T1.
- Record `T_restore_start`.

### 5. Verify restore
Wait until Neon reports restore complete. Record `T_restore_complete`.
Re-run row-count query. Expected: counts match pre-state from step 2.

### 6. Teardown
- Delete branch `drill-YYYYMMDD-pitr`.
- Verify disappearance in Branches list.
- Delete `.env.drill`.

---

## Drill execution evidence (fill during drill)

**Drill date:** YYYY-MM-DD
**Operator:** <name>

**Pre-state row counts:**

| Table              | Count |
|--------------------|-------|
| bank_transactions  |       |
| customer_invoices  |       |
| gl_journal_lines   |       |
| companies          |       |

**Timings:**

| Event                           | Timestamp (UTC) | Delta |
|---------------------------------|-----------------|-------|
| T0 (branch created from prod)   |                 |       |
| T1 (destructive change applied) |                 |       |
| T_restore_start                 |                 |       |
| T_restore_complete              |                 |       |
| **Total RTO**                   |                 |       |

**Post-restore verification:** counts match / differ (explain)

**Neon console artifacts:** paste screenshot paths or CLI output excerpts.

**Gotchas encountered:** <free text>

**Conclusion:** RTO estimate for prod = <minutes>
