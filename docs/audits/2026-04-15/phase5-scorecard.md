# Phase 5 — Final Scorecard

**Date:** 2026-04-15
**Status:** Signed — production-ready

---

## Exit gate

| Gate | Requirement | Actual | Pass |
|------|-------------|--------|------|
| P0 open | 0 | 0 | ✅ |
| P1 open | 0 | 0 | ✅ |
| tsc clean | 0 errors | 0 | ✅ |
| Unit tests | all pass | 1927/1927 | ✅ |

---

## Per-stream results (Wave 2)

| Stream | Scope | P0 found | P1 found | P2 | P3 | All P0+P1 fixed? |
|--------|-------|----------|----------|----|----|------------------|
| 2A | Tenant isolation | 6 | 4 | 2 | 1 | ✅ (BL-47..52, 80..83) |
| 2B | IDOR surface | 0 | 3 | 1 | 0 | ✅ (BL-84..86) |
| 2C | Schema/NOT-NULL | 5 | 0 | 0 | 0 | ✅ (BL-53..57) |
| 2D | Auth/CSRF | 21 | 8 | 15 | 0 | ✅ (BL-58..78, 87..94) |
| 2E | Logging/Sentry | 0 | 0 | 0 | 2 | — (clean) |
| 2F | Migrations | 1 | 8 | 0 | 0 | ✅ (BL-79, 95..102) |
| **Total** | | **33** | **23** | **18** | **3** | **56/56** |

---

## Commits (chronological)

All Wave 1 and Wave 3 fix commits, in order:

| SHA | Summary |
|-----|---------|
| `81f831c` | fix(BL-43): startRun persists company_id on gl_migration_runs |
| `1afc967` | fix(BL-45): creditNoteService approve/cancel UPDATEs scoped by company_id |
| `62207a3` | fix(BL-46): postCustomerInvoiceToGL SELECT scoped by company_id |
| `9c96a51` | fix(BL-47..BL-52): tenant isolation guards on 6 UPDATE sites (Wave 3 Batch 1) |
| `4aefd8f` | fix(BL-53..BL-57): populate required NOT-NULL columns on 5 INSERT sites |
| `3da88cc` | fix(BL-58..BL-78): apply withCsrf to 21 money-moving routes |
| `b296286` | fix(BL-79): delete ghost migration record 245_inventory.sql (Path 2) |
| `f704cf1` | fix(BL-80..BL-83): P1 tenant supplements — purge logs + 3 bank_tx guards |
| `384ce9e` | fix(BL-84..BL-86): P1 IDOR — group_id guards on eliminations + intercompany match, entity ownership on document upload |
| `03dd2ed` | fix(BL-87..BL-94): Zod validation on 8 auth/invite handlers |
| `3e801d7` | fix(BL-95..BL-102): rename 8 duplicate-prefix migrations + sync schema_migrations |

---

## Outstanding (non-gating)

- **18 P2 findings** (BL-103..BL-118) — mostly CSRF on non-money-moving config/supplier/customer/inventory/reporting routes and admin Zod validation — logged for future hardening pass.
- **3 P3 findings** (BL-119..BL-121) — cosmetic / defense-in-depth improvements.
- See `docs/audits/2026-04-15/phase5-wave2-findings.md` for the full P2/P3 list.

---

## Drill track

The PITR drill and rollback rehearsal are human-operated tasks. Per design doc, Phase 5 closeout confirms runbook existence and defers execution to the user.

| Runbook | Expected path | Status |
|---------|---------------|--------|
| PITR restore drill | `docs/ops/pitr-drill.md` | **NOT at expected path** — file lives at `docs/runbooks/pitr-restore-drill.md` |
| Rollback rehearsal | `docs/ops/rollback-rehearsal.md` | **NOT at expected path** — file lives at `docs/runbooks/rollback-rehearsal.md` |

Both runbooks exist under `docs/runbooks/`. The `docs/ops/` directory does not exist; the design spec referenced a path that was never created. Runbooks are functionally present and ready for execution.

Drill execution is the user's responsibility. Results should be logged to `docs/audits/2026-04-15/phase5-drill-log.md` when completed.

---

## Sign-off

Phase 5 exit gate: **PASSED**.
Zero open P0, zero open P1. All 6 verification streams signed off.
Ready for production deployment after user-executed PITR + rollback drills.

— Claude Sonnet 4.6, 2026-04-15
