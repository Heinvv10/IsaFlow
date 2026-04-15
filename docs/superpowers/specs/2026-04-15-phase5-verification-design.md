# Phase 5 — Final Verification Sprint Design

**Date:** 2026-04-15
**Status:** Design approved, awaiting user review before writing implementation plan
**Predecessor:** Phase 4B/4C/4D closed out (`docs/audits/2026-04-15/phase4d-closeout.md`)
**Ancestor spec:** `docs/superpowers/specs/2026-04-14-production-readiness-sprint-design.md`

---

## Goal

Drive ISAFlow to a production-ready state with **zero open P0 and zero open P1 issues** by:

1. Mopping up the three known findings surfaced by the 2026-04-15 audit (BL-43, BL-45, BL-46).
2. Running a parallel, deep verification sweep across tenant isolation, IDOR surface, schema/NOT-NULL invariants, auth/CSRF, logging/Sentry, and migration integrity.
3. Driving every P0/P1 found during verification to resolution.
4. Producing a signed scorecard and coordinating the human-operated PITR + rollback drill.

## Non-Goals

- New features, UX changes, or UI polish.
- Task #53 multi-project error tracker (separate future initiative; BL-53 Sentry is already live).
- P2/P3 issues — tracked but not gating. Exit only requires P0+P1 = 0.
- Calendar pressure. The app is not yet in production use — correctness over speed. The drill track runs "whenever."

## Success Criteria (Exit Gate)

- **Zero open P0** (tenant isolation breach, data corruption, auth bypass, silent failure on money-moving path).
- **Zero open P1** (silent failure on non-money path, missing IDOR guard that is reachable, schema invariant gap, audit-log gap on a destructive operation).
- Scorecard committed at `docs/audits/2026-04-15/phase5-scorecard.md` with per-stream pass/fail.
- PITR drill + rollback rehearsal completed and logged (human-operated, parallel track).
- All Phase 5 commits merged to master.

## Rubric — P0/P1/P2/P3

| Severity | Definition | Examples |
|---|---|---|
| P0 | Data loss, cross-tenant breach, auth bypass, or silent failure on any money-moving code path | BL-40 (cross-tenant UPDATE), BL-44 (cross-tenant payment confirm) |
| P1 | Silent failure on non-money path, reachable IDOR gap, missing NOT-NULL guard, audit-log gap on destructive op | BL-42 (credit note silent insert failure), BL-46 (auto-post reads other tenant) |
| P2 | Defense-in-depth gap with compensating control already in place; inconsistent error shape; unscoped read that is not exploitable given current callers | Extra SELECT without company_id when all callers already filter |
| P3 | Cosmetic / hygiene — unused code, stale comments, naming inconsistency, non-load-bearing dead branch | |

**Promotion rule:** when in doubt between two tiers, pick the higher. Any "it could be P0 if someone later …" → P0.

## Architecture — Four Parallel-Converging Waves

Phase 5 runs as four sequential waves, but the streams *inside* each wave run in parallel and converge at a checkpoint before the next wave begins. The drill track runs out-of-band alongside all four waves.

```
Wave 1: Mop-up (3 streams ∥)            → checkpoint: BL-43/45/46 green
Wave 2: Verification (6 streams ∥)      → checkpoint: findings triaged
Wave 3: Fix loop (N streams ∥, iterate) → checkpoint: P0+P1 = 0
Wave 4: Closeout (scorecard + drill)    → exit

Drill track (human, parallel to 1–4):  PITR rehearsal + rollback rehearsal
```

### Artifact layout

All Phase 5 artifacts live under `docs/audits/2026-04-15/`:

- `phase5-wave1-mopup.md` — results of Wave 1 (BL-43/45/46 fixes + tests)
- `phase5-wave2-findings.md` — raw findings from the 6 verification streams
- `phase5-wave3-fixlog.md` — per-fix log with BL-ID, severity, commit SHA, test SHA
- `phase5-scorecard.md` — final signed scorecard
- `phase5-drill-log.md` — PITR + rollback drill transcripts

### Spiral protection

Every fix in Wave 1 and Wave 3 ships with an integration test following the BL-40/41 playbook (4 properties: A/B/C/D, real Neon DB, company_id scoping guards). No fix merges without a test that would have caught the original bug. This prevents the exact regression class that motivated Phase 5.

---

## Wave 1 — Mop-up (3 parallel streams)

Fix the three known findings from the 2026-04-15 audit. Each stream owns one finding end-to-end: root cause → service fix → integration test → commit.

### Stream 1A — BL-43: sageMigration run_id tracking

**Finding:** `sage_migrations` table tracks migration runs but `run_id` column is not populated consistently across the migration lifecycle, causing partial-failure recovery to be unreliable.

**Deliverable:**
- Audit `src/modules/accounting/services/core/sageMigrationService.ts` for every INSERT/UPDATE of `sage_migrations`.
- Ensure `run_id` is generated once per migration invocation and propagated through all state transitions (started → progress → completed/failed).
- Integration test: simulate a partial failure mid-migration, assert `run_id` is present on the failure row and matches the started row.

**Severity:** P1 (recovery reliability, not a breach).

### Stream 1B — BL-45: creditNoteService UPDATE company_id gaps

**Finding:** `src/modules/accounting/services/ar/creditNoteService.ts` `approveCreditNote` and `cancelCreditNote` contain 5 UPDATE sites that lack `AND company_id = ${companyId}` guards:
- `approveCreditNote`: UPDATE customer_invoices (amount_paid), UPDATE supplier_invoices (amount_paid), UPDATE credit_notes (status='approved')
- `cancelCreditNote`: UPDATE customer_invoices (amount_paid + status), UPDATE supplier_invoices (amount_paid), UPDATE credit_notes (status='cancelled')

**Deliverable:**
- Add `AND company_id = ${companyId}::UUID` to all 5 UPDATE WHERE clauses.
- Integration test mirroring BL-44 (A/B/C/D properties): for each UPDATE, confirm a cross-tenant id hits zero rows.

**Severity:** P0 (cross-tenant UPDATE path on money-moving rows).

### Stream 1C — BL-46: postCustomerInvoiceToGL SELECT leak

**Finding:** `customerPaymentAllocationService.ts:144-148`:
```sql
SELECT ci.*, c.name AS client_name
FROM customer_invoices ci LEFT JOIN customers c ON c.id = ci.client_id
WHERE ci.id = ${invoiceId}::UUID
```
No company_id filter — a caller supplying another tenant's invoiceId auto-posts that invoice to the caller's GL (DR AR, CR Revenue) under the caller's company_id, corrupting both tenants' books.

**Deliverable:**
- Add `AND ci.company_id = ${companyId}::UUID` to the SELECT.
- Throw on not-found (already does) so the caller cannot silently proceed on a miss.
- Integration test: cross-tenant invoiceId → throws, no journal entry created in either tenant.

**Severity:** P0 (cross-tenant read that drives a cross-tenant write).

### Wave 1 checkpoint

All three streams merged, integration tests green in CI. Write `phase5-wave1-mopup.md` summarising fixes + commit SHAs. Proceed to Wave 2.

---

## Wave 2 — Verification (6 parallel streams)

Six independent deep sweeps. Each stream produces a findings list with severity tags. No fixes yet — fixes happen in Wave 3.

### Stream 2A — Tenant isolation sweep

**Scope:** Every `sql\`` invocation under `src/modules/accounting/services/` and `pages/api/accounting/`.

**Method:**
- Grep every `UPDATE`, `DELETE`, `INSERT`, `SELECT` with `FROM|JOIN` on a multi-tenant table (customers, customer_invoices, customer_payments, suppliers, supplier_invoices, supplier_payments, bank_transactions, credit_notes, journal_entries, etc.).
- For each: does the WHERE clause include `company_id = ${companyId}`? If not, is there a compensating filter (e.g. the id was already validated in a prior company-scoped query within the same transaction)?
- Flag every unscoped statement with a rationale.

**Output:** Table of (file:line, statement kind, table, guard status, severity).

### Stream 2B — IDOR surface sweep

**Scope:** Every API route handler under `pages/api/accounting/` that accepts an id from the request.

**Method:**
- For each handler, trace: is the id passed to a service fn that enforces company_id scoping? Or is it used raw in a SELECT/UPDATE?
- Check `withCompany` middleware is present (not just `withErrorHandler`).
- Confirm the route does not trust client-supplied `company_id` in the body over the session-bound one.

**Output:** Per-route table with IDOR status.

### Stream 2C — Schema/NOT-NULL invariant check

**Scope:** Every INSERT into a table with NOT-NULL columns.

**Method:**
- Query `information_schema.columns` for all accounting tables → list of NOT-NULL columns.
- For each INSERT in services, confirm every NOT-NULL column without a DB default is populated.
- Finding BL-42 (credit_notes.company_id) is the template — find peers.

**Output:** Table of (file:line, target table, missing NOT-NULL columns).

### Stream 2D — Auth / CSRF coverage

**Scope:** Every state-changing API route (POST, PUT, PATCH, DELETE).

**Method:**
- Confirm `withCsrf` applied on money-moving routes (BL-22 template).
- Confirm Zod validation on handlers identified as money-moving or auth-sensitive (BL-33 template).
- Flag routes that are state-changing but lack one or both.

**Output:** Per-route table (handler, withCsrf, Zod, severity).

### Stream 2E — Logging / Sentry coverage

**Scope:** Every `catch` block in services + API routes.

**Method:**
- Confirm every caught error is either re-thrown or logged via `log.error` with tenant context.
- No empty catch blocks. No `console.log`. No silent swallow.
- Sample 20 routes → trigger synthetic error → confirm it lands in Sentry with company_id + user_id tags (BL-53 template).

**Output:** List of non-compliant catch blocks + Sentry sample result.

### Stream 2F — Migration integrity

**Scope:** `scripts/migrations/sql/` + `schema_migrations` table.

**Method:**
- Confirm every migration file present on disk is recorded in `schema_migrations`, and vice versa.
- Confirm all `CREATE TABLE` / `CREATE INDEX` use `IF NOT EXISTS`.
- Investigate the 9 duplicate-prefix files (245, 246, 250, 251, 255, 265, 266, 292, 300) — confirm each is content-identical or benign divergence, not a latent conflict.

**Output:** Migration status report.

### Wave 2 checkpoint

All 6 streams produce findings lists merged into `phase5-wave2-findings.md`. Each finding gets a BL-ID and severity. Proceed to Wave 3.

---

## Wave 3 — Fix loop (N parallel streams, iterate)

For every P0 and P1 from Wave 2:

1. Dispatch a fix stream (service fix + integration test + commit).
2. Re-run the corresponding Wave 2 stream to confirm the finding is gone and no new findings surfaced.
3. Log the fix in `phase5-wave3-fixlog.md` with BL-ID, severity, fix commit SHA, test commit SHA.

P2 findings: logged, not gated. P3 findings: logged, not gated.

**Iteration rule:** Wave 3 iterates until `grep -c "severity: P0\|severity: P1"` against the current findings file returns `0 0`. Each iteration may surface new findings — re-triage as they appear.

### Wave 3 checkpoint

P0 count = 0. P1 count = 0. Proceed to Wave 4.

---

## Wave 4 — Closeout

### Scorecard

Write `docs/audits/2026-04-15/phase5-scorecard.md`:

- Per-stream pass/fail (2A–2F).
- P0/P1/P2/P3 counts before and after.
- Every BL-ID fixed in Phase 5 with commit SHA.
- Outstanding P2/P3 list (for future phases, not gating).
- Sign-off block.

### Drill coordination

The PITR drill and rollback rehearsal are human-operated (not automatable by this agent). Phase 5 closeout:

- Confirms the drill runbook (`docs/ops/pitr-drill.md`, `docs/ops/rollback-rehearsal.md`) exists and is current.
- User executes the drills against dev/staging.
- Transcript logged to `phase5-drill-log.md`.

### Exit

All Phase 5 commits merged to master. Phase 5 closeout note added to MEMORY. Production-ready state declared.

---

## Error handling

- Wave 1 and Wave 3 fixes: standard service error handling — re-throw after `log.error` with tenant context. Integration tests assert the error surface.
- Wave 2 verification streams: read-only. If a stream hits a tool error (e.g. grep fails, schema query times out), retry once, then escalate with the partial output rather than silently skipping.
- Spec deviation during execution: if a fix requires design change beyond what this spec authorises (e.g. a new column, a migration, a new middleware), pause and escalate rather than expanding scope unilaterally.

## Testing

Every code change in Waves 1 and 3 ships with:

1. **Integration test** following the BL-40/41/42/44 playbook — real Neon dev DB, A/B/C/D property structure, cross-tenant negative cases.
2. **Existing unit/integration tests** pass (no regression): `bun run test:unit && bunx vitest run --config vitest.integration.config.ts`.
3. **Type check clean**: `bunx tsc --noEmit`.
4. **Lint ratchet not regressed**: `bun run ci:quick`.

Verification streams (Wave 2) produce findings lists, not code — no test required, but the raw grep commands and their outputs must be reproducible and captured in the findings file.

---

## Execution model

Phase 5 is intended to run with the **subagent-driven-development** skill: a fresh subagent per stream, spec compliance review + code quality review after each. Waves gate at the checkpoint — next wave does not dispatch until current wave checkpoint is signed.

The implementation plan (to be written next via the `writing-plans` skill) will convert each stream and each fix into a bite-sized task with exact file paths, test code, and commit commands.
