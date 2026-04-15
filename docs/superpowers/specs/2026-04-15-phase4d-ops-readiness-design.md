# Phase 4D — Ops Readiness Design

**Date:** 2026-04-15
**Status:** Draft for review
**Follows:** Phase 4C observability (`docs/audits/2026-04-15/phase4c-closeout.md`)
**Precedes:** Phase 5 final verification

## Goal

Prove we can recover from a bad change, rotate secrets without surprising ourselves, and run a prod migration with evidence-based timings. Four deliverables — two drills, two runbooks — all pure ops/documentation work. No runtime code changes to the app.

## Non-goals

- Automated PITR testing in CI. Drills are human-executed, not continuous.
- Secrets manager integration (Vault, Doppler, AWS Secrets Manager). Inventory + manual rotation only.
- Migration rollback DSL / `down.sql` files — "rollback" means PITR, which the drill validates.
- Monitoring/alerting on migration events. Logging suffices for this phase.
- Deployment automation changes. `scripts/deploy.sh` stays untouched.

## Architecture

Four independent deliverables:

1. **PITR restore drill** — exercise Neon's point-in-time restore against a prod-clone branch. Capture RTO timings, validate restored data shape.
2. **Rollback rehearsal** — practice "migration went bad, recover to known-good" on the same prod-clone branch. Proves PITR answers the real operational question.
3. **Secrets rotation runbook** — inventory every `process.env.*` the app reads, classify by blast radius, write one generic rotation playbook plus per-secret notes for the risky classes.
4. **Prod migration plan** — build a repeatable migration runner (tracking table + script + tests), then the specific go-live plan for applying migrations 292 + 325–331 to prod using drill-captured timings.

Items 1 and 2 share the same prod-clone branch, executed in one session. Item 4's go-live plan consumes timing data from that session. Item 3 is independent, parallel-safe.

## Files

**New:**
- `docs/runbooks/pitr-restore-drill.md`
- `docs/runbooks/rollback-rehearsal.md`
- `docs/runbooks/secrets-rotation.md`
- `docs/runbooks/prod-migration-go-live.md`
- `docs/audits/2026-04-15/secrets-inventory.md`
- `docs/audits/2026-04-15/phase4d-closeout.md`
- `scripts/apply-migrations.sh`
- `scripts/migrations/sql/332_schema_migrations_tracking.sql`
- `tests/unit/scripts/apply-migrations.test.ts`

**Modified:** None. No application runtime changes.

**Env:** None added.

**New dependency:** None.

## Data flow / sequencing

```
Day 1 AM   → Create prod-clone Neon branch
Day 1      → Item 1 (PITR drill)            ← captures RTO data
Day 1      → Item 2 (rollback rehearsal)     ← uses same clone
Day 1 PM   → Teardown clone (verified deleted)
Day 2      → Item 3 (secrets, no clone needed, parallel-safe)
Day 2      → Item 4a (migration runner + migration 332 applied to dev)
Day 2      → Item 4b (go-live plan, uses Day-1 timings)
Day 3      → Phase 4D closeout
```

## Components

### Item 1: PITR restore drill

**Deliverable:** `docs/runbooks/pitr-restore-drill.md`

**Drill procedure:**
1. Create Neon branch `drill-YYYYMMDD` from prod at timestamp T0.
2. Note pre-state: row counts for the 10 largest tables, timestamp recorded.
3. Apply a destructive change on the branch (e.g., `DELETE FROM bank_transactions WHERE company_id = '<test>'`) at T1.
4. Invoke PITR to restore branch to T0.
5. Verify: row counts match pre-state; destructive change is gone.
6. Record timings: T_restore_start → T_restore_complete; total RTO.
7. Teardown: delete branch, verify deletion in Neon console.

**Artifacts captured in runbook:**
- Actual restore duration on prod-sized data
- Neon console screenshots / CLI log excerpts
- Retention window (currently 7 days on our plan) noted
- Verification queries and their outputs
- "Gotchas encountered" section

### Item 2: Rollback rehearsal

**Deliverable:** `docs/runbooks/rollback-rehearsal.md`

**Scenario:** Migration 331 applied to prod, discovered to be wrong. Recover.

**Two paths exercised:**
- **Path A — PITR to pre-migration timestamp:** documented steps, expected duration from Item 1.
- **Path B — Manual DDL reversal:** applicable only when the migration is purely additive (e.g., dropping a new column). Script template included.

**Decision tree in runbook:**
```
Is the migration purely additive (added columns, added tables)?
├── Yes → Path B (faster, no data loss)
└── No  → Path A (PITR; costs T_restore of downtime)
```

**Record:** total elapsed time from "this is broken" to "service restored."

### Item 3: Secrets rotation

**Deliverables:**
- `docs/audits/2026-04-15/secrets-inventory.md`
- `docs/runbooks/secrets-rotation.md`

**Inventory procedure:**
1. Grep `process.env\.` across repo, produce deduplicated list.
2. Classify each secret:
   - **auth-critical** — rotation invalidates active sessions (JWT_SECRET, session signing keys).
   - **data** — rotation requires connection draining (DATABASE_URL).
   - **third-party** — rotation must coordinate with vendor (SMTP creds, Stitch API keys, AI provider keys).
   - **infra** — low risk, stateless (CORS origins, feature flags, thresholds).
3. Note current location of each secret (env file, deploy config, vendor console).

**Generic rotation playbook sections:**
- Pre-flight (who to notify, maintenance window needed?)
- Rotate (generate new value, update in source of truth)
- Deploy (push new env to running service)
- Verify (endpoint check, auth flow check)
- Post-flight (revoke old value, update inventory doc)

**Per-secret notes written for auth-critical and data classes only.** Third-party and infra use the generic playbook.

### Item 4: Migration runner + go-live plan

**Part 4a — Runner infrastructure:**

Migration `scripts/migrations/sql/332_schema_migrations_tracking.sql`:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version int PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text
);
```

`scripts/apply-migrations.sh` behavior:
- Lists `scripts/migrations/sql/*.sql`, sorts by numeric prefix (292, 325, 326, …).
- For each file, derives version int from filename prefix.
- Checks `schema_migrations` for that version:
  - If present and checksum matches → skip.
  - If present and checksum differs → refuse, exit non-zero (migration file was edited after applying).
  - If absent → acquire `pg_advisory_lock(<const>)`, apply SQL inside a single transaction, insert tracking row with SHA-256 checksum of the file contents, release lock.
- Flags:
  - `--dry-run` — print what would be applied, no DB writes.
  - `--backfill` — populate `schema_migrations` with the known-already-applied versions (292, 325–331) without executing their SQL. Used once, during the migration 332 rollout.

Unit tests in `tests/unit/scripts/apply-migrations.test.ts`:
- Empty DB + 3 migration files → all applied, 3 tracking rows.
- 2 applied + 1 new → only the new one runs.
- `--dry-run` → no DB writes.
- Checksum mismatch → refuses, exit non-zero.
- Advisory lock held → second runner blocks or errors cleanly (no double-apply).
- `--backfill` flag → inserts tracking rows without executing SQL.

**Part 4b — Go-live plan:**

`docs/runbooks/prod-migration-go-live.md` contents:
- Pre-flight checklist (backup point captured, team on standby, maintenance window confirmed).
- Migration list: 292, 325, 326, 327, 328, 329, 330, 331 in order.
- Per-migration: file path, summary of change, estimated duration from Day-1 drill on prod-clone, locking behavior.
- Go/no-go checklist (Neon plan status, recent PITR point verified, rollback path rehearsed).
- Execution sequence (apply 332 first via `--backfill`, then the batch).
- Verification queries post-apply.
- Abort criteria and who calls it.

## Error handling & edge cases

**Prod-clone drill:**
- Clone creation fails / Neon quota hit → pre-flight confirms branch headroom before drill starts.
- Clone has stale schema relative to prod → drill verifies schema match before proceeding.
- Teardown forgotten → explicit "branch deleted, verified in console" step plus calendar reminder.

**PITR restore:**
- Target timestamp outside retention window (7 days) → documented limit; drill picks timestamp within window.
- Restore completes but data wrong → verification query section catches this, not just a success signal.

**Migration runner:**
- Two runners race (CI + human) → `pg_advisory_lock` around the apply loop.
- Migration file edited after apply → checksum mismatch; runner refuses.
- Partial batch failure → each migration in its own transaction; tracking row inserted on commit only; resume-safe.
- Existing dev migrations (292, 325–331) applied before tracking table existed → `--backfill` flag populates tracking without re-applying.

**Secrets rotation:**
- Auth-critical secret rotated without session migration plan → runbook flags this; requires maintenance window decision.
- Third-party secret rotated without vendor coordination → runbook requires vendor-side confirmation before app-side cutover.

## Testing

- **Drill execution is the test.** Closeout doc captures real timings, screenshots, and verification query outputs as evidence.
- **Migration runner** — unit tests listed in Item 4a.
- **Regression** — full suite green after migration 332 applied to dev: 1874 unit + 5 integration tests, `tsc --noEmit` exit 0.
- **Secrets inventory** — no automated test; validation is a second-pass grep review (inventory vs. `process.env.*` in repo).
- **Go-live plan** — validated by `apply-migrations.sh --dry-run` against a fresh Neon branch; output matches plan.

## Scope cuts (YAGNI)

- No CI-integrated PITR drill automation.
- No secrets manager integration.
- No migration `down.sql` DSL.
- No `/metrics` on migration runs.
- No changes to `scripts/deploy.sh`.

## Success criteria

1. `docs/runbooks/pitr-restore-drill.md` exists with real timings from an executed drill.
2. `docs/runbooks/rollback-rehearsal.md` exists with real timings from an executed rehearsal.
3. `docs/runbooks/secrets-rotation.md` + `docs/audits/2026-04-15/secrets-inventory.md` exist; inventory verified against `process.env.*` grep.
4. `scripts/apply-migrations.sh` passes its unit tests; migration 332 applied to dev; `--dry-run` and `--backfill` modes verified working.
5. `docs/runbooks/prod-migration-go-live.md` exists with pre-flight, go/no-go, verification sections filled using drill timings.
6. `docs/audits/2026-04-15/phase4d-closeout.md` ties it all together.
7. `tsc --noEmit` exit 0; full test suite green.

## Follow-ups (out of scope for 4D)

- Phase 5: final re-verification sprint, any remaining Phase 4 closeouts.
- Secrets manager evaluation (Vault / Doppler / AWS Secrets Manager).
- CI hook to run `apply-migrations.sh --dry-run` on every PR touching `scripts/migrations/sql/`.
- Task #41 (BL-41): `sage_customer_invoices` mirror of BL-40 — still pending.
- Task #53: Multi-project self-hosted error tracker — separate org-level initiative.
