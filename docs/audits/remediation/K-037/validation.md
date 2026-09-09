# K-037 — SARS-code release admin write silently rolled back

**Claim (A C21, critical):** `pages/api/admin/payroll/sars-codes/release.ts:40` writes a
non-UUID value (`String(taxYear)` = `"2025"`) into a UUID audit target column; the failed
INSERT aborts the surrounding transaction, so the admin write returns 200 with no effect.

**Corrected trigger:** The mechanism is real but is gated entirely on the type of
`admin_audit_log.target_id`. On the current production schema that column is
`character varying(255)`, so nothing fails and nothing rolls back.

## Disposition: false-positive (on the audited/production schema)

## Evidence
- Production schema fixture (`isaflow_schema_fixture`, current production schema, zero rows):
  `\d admin_audit_log` → `target_id | character varying(255) | nullable`. Not UUID.
- Executed the exact route write against that schema inside a transaction: the INSERT of
  `'2025'` succeeds, `SELECT 1` after it still runs (transaction not aborted). See `red.log`.
- Route path traced on `ebeac9ca` (file unchanged since `5661d6f0`;
  `git log --oneline 5661d6f0..ebeac9ca -- pages/api/admin/payroll/sars-codes/release.ts`
  is empty): `withAdmin` → `withPlatformAdmin` (`src/lib/auth/withPlatformAdmin.ts:118` BEGIN,
  `:169` COMMIT) → handler → `setCurrentRelease` (`sarsCodesAdminService.ts:180-190`) →
  `logAdminAction` (`auditService.ts:60-91`).
- The swallow path is confirmed: `sars_codes.set_current` is not in `CRITICAL_ACTIONS`
  (`auditService.ts:40-50`), so `logAdminAction` catches and returns; the handler then sends
  200 before `withPlatformAdmin` reaches `COMMIT`.

## Reachability of the claimed failure (conditional, not on production)
Simulated the migration-defined schema in a throwaway schema (dropped afterwards): with
`target_id UUID`, the INSERT raises `invalid input syntax for type uuid: "2025"`, the next
statement returns `current transaction is aborted`, and `sars_code_releases.is_current`
stays `false` after COMMIT. So the claim would be exactly right on a UUID column.

## Real, separate finding: repo migration and production disagree
`scripts/migrations/sql/264_admin_platform_audit.sql:10` declares `target_id UUID` and is the
only DDL for this table in the repo. Production is `varchar(255)`, so 264 was a no-op
(`CREATE TABLE IF NOT EXISTS` over a pre-existing table). **A fresh install built from the
migrations gets the UUID column and the defect is live there.** Worth its own item; it is not
the defect K-037 asserts against production.

## Proposed minimal fix (defensive, low risk)
Not required for production correctness. If taken: in
`pages/api/admin/payroll/sars-codes/release.ts` pass `null` as `targetId` and keep the year in
`details` (already present as `tax_year`), which is type-safe under either column type.
Alternatively add migration `ALTER TABLE admin_audit_log ALTER COLUMN target_id TYPE VARCHAR(255)`
so new installs match production.

## Historical-data impact
None on production: no write ever failed, so no `sars_code_releases` row was silently left
unchanged. Read-only check that the audit rows exist and are non-UUID:
`SELECT target_id, count(*) FROM admin_audit_log WHERE action='sars_codes.set_current' GROUP BY 1;`

## Risks
Fixture-vs-production equivalence is assumed from the brief's statement that the fixture
carries the current production schema. If production were ever migrated to UUID, this flips
to confirmed-critical immediately.
