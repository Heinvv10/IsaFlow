# Phase 4D — Ops Readiness Closeout

**Date:** 2026-04-15
**Spec:** `docs/superpowers/specs/2026-04-15-phase4d-ops-readiness-design.md`
**Plan:** `docs/superpowers/plans/2026-04-15-phase4d-ops-readiness-plan.md`

---

## Scorecard

| Item | Status |
|---|---|
| PITR restore drill runbook | ✅ `docs/runbooks/pitr-restore-drill.md` |
| PITR drill execution (RTO captured) | ⏸ pending (human-operated on Neon console) |
| Rollback rehearsal runbook | ✅ `docs/runbooks/rollback-rehearsal.md` |
| Rollback rehearsal execution (timings) | ⏸ pending (human-operated) |
| Secrets inventory classified | ✅ `docs/audits/2026-04-15/secrets-inventory.md` (40/40 vars) |
| Secrets rotation runbook | ✅ `docs/runbooks/secrets-rotation.md` |
| Migration runner + tests | ✅ `scripts/apply-migrations.ts` (13 unit tests) |
| Migration 332 applied to dev | ✅ verified via `schema_migrations` (121 rows tracked, all checksummed) |
| Prod migration go-live plan | ✅ `docs/runbooks/prod-migration-go-live.md` |
| `bunx tsc --noEmit` | ✅ exit 0 |
| Regression suite | ✅ 81 test files, 1887 unit tests passing |

---

## What landed

| Commit | Change |
|--------|--------|
| `9d440ba` | Phase 4D ops readiness design spec |
| `9f09220` | Phase 4D implementation plan |
| `64c3101` | Secrets inventory classified by rotation risk (40 vars) |
| `b19aab8` | Fix coverage count off-by-one (41 → 40) in secrets inventory |
| `179b723` | Secrets rotation runbook + per-secret notes |
| `678a82d` | Migration 332 `schema_migrations` tracking table |
| `26821f7` | Idempotent migration runner with checksum + pg_advisory_lock |
| `ec6cbc9` | Runner: version as text (support legacy `244b_inventory.sql`) |
| `8d86081` | **Task 6 dev rollout**: runner tracks by filename (not version) — discovered 9 duplicate-prefix files; migration 332 upgrades pre-existing legacy table in-place |
| `535a47e` | PITR restore drill runbook |
| `4d27751` | Rollback rehearsal runbook |
| `1452065` | Prod migration go-live plan for 292 + 325–332 batch |

---

## Drill outcomes

- **PITR RTO on prod-sized data:** `<pending human-operated drill>`
- **Rollback path A elapsed:** `<pending>`
- **Rollback path B elapsed:** `<pending>`

Execution of the drills themselves is blocked on Neon console access and a
2-hour calendar block. Runbooks are ready to execute.

---

## Key findings during implementation

1. **Duplicate migration version prefixes** (9 cases): files like
   `245_inventory.sql` and `245_company_settings.sql` coexist in the repo.
   Version is NOT unique — filename is. Runner schema and tracking identity
   changed accordingly before dev rollout.
2. **Legacy dev tracking table**: had only `(filename, applied_at)` columns
   from prior ad-hoc tooling with 121 rows. Migration 332 and the runner
   bootstrap perform an in-place upgrade (add name/version/checksum, drop
   legacy `filename` PK/column, add `UNIQUE(name)`). Backfilled 120 legacy
   rows with checksums during dev rollout.
3. **Prod may have the same legacy shape** — go-live plan requires
   rehearsing the in-place upgrade on a prod-clone before running on prod.

---

## What was NOT done (deferred)

- Secrets manager integration (Vault/Doppler) — Phase 5+ decision.
- CI hook for migration dry-run on PRs — Phase 5+.
- Automated PITR drill in CI — not planned; drill is human-operated.
- Actual drill executions (PITR + rollback) — human-operated, to be done off-keyboard.

---

## Follow-ups

- **Execute the drills** (PITR + rollback), fill in evidence sections, and
  use captured timings to populate the "Expected duration" column in
  `prod-migration-go-live.md`.
- **Task #41** (still pending): `sage_customer_invoices` mirror of BL-40.
- **Task #53** (deferred): multi-project error tracker.
- **Phase 5**: final re-verification sprint.

---

## Next phase

Phase 5 — final verification. Separate spec + plan + cycle when Hein is ready.
