# Migration Rollback Rehearsal

**Scenario:** Migration N applied to prod. Discovered to be wrong. Recover.

## Two paths

### Path A — PITR to pre-migration timestamp
Applicable: always, but costs `T_restore` minutes of downtime (see `pitr-restore-drill.md`).

Steps:
1. Stop writes (put app in maintenance mode).
2. Neon console → Restore branch to `T_pre_migration`.
3. App pods restart, read from restored state.
4. Post-verification: row counts, critical queries return expected data.

### Path B — Manual DDL reversal
Applicable: only when migration is purely additive (added columns/tables/indexes).
NOT applicable: `DROP COLUMN`, `ALTER COLUMN TYPE`, `DELETE`, `UPDATE`.

Steps:
1. Identify the reverse DDL (e.g., `DROP INDEX IF EXISTS idx_x` for a migration that did `CREATE INDEX idx_x`).
2. Apply reverse DDL as an ad-hoc hotfix migration (next number).
3. `DELETE FROM schema_migrations WHERE name = 'NNN_file.sql';`

## Decision tree

```
Is the migration purely additive (added columns/tables/indexes, no data changes)?
├── Yes → Path B (fast, no downtime)
└── No  → Path A (PITR, costs T_restore)
```

## Rehearsal procedure
Use same prod-clone Neon branch workflow as PITR drill.

1. Create `drill-YYYYMMDD-rollback` branch.
2. Simulate a bad migration: apply a fake migration that wrongly alters a column.
3. Choose a path (A or B), run it, capture timings.
4. Verify: application-level smoke query returns expected data.
5. Teardown branch.

---

## Rehearsal execution evidence (fill during rehearsal)

**Date:** YYYY-MM-DD
**Scenario simulated:** <describe bad migration>
**Path chosen:** A / B
**Rationale:** <why>

**Timings:**

| Event                         | Timestamp (UTC) | Delta |
|-------------------------------|-----------------|-------|
| "This is broken" declared     |                 |       |
| Recovery path decided         |                 |       |
| Recovery started              |                 |       |
| Service verified healthy      |                 |       |
| **Total elapsed**             |                 |       |

**Post-recovery verification queries run:**

```sql
-- paste actual queries used
```

**Results:** pass / fail

**Gotchas:** <free text>

**Conclusion:** path A cost = `<minutes>`, path B typical cost = `<minutes>`.
