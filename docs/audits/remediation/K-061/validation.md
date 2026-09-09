# K-061 — customer merge updates a column that does not exist

**Claim.** `pages/api/accounting/customer-merge.ts:63` sets
`customer_payments.customer_id`, a column that does not exist, so every merge
500s and rolls back.

**Corrected trigger.** Accurate. `customer_payments` has `client_id` and no
`customer_id` (fixture schema). Both the SET and the WHERE at lines 62-67 name
`customer_id`, so Postgres raises 42703 `column "customer_id" does not exist`,
`withTransaction` rolls back steps 1-2, and the handler answers 500. The
endpoint has never merged anything.

**Disposition: confirmed.**

**Evidence.**
- File unchanged between `5661d6f0` and `origin/master`.
- `information_schema.columns` for `customer_payments`: `client_id`, no `customer_id`.
- RED test: `tests/integration/k061-customer-merge-nonexistent-column.int.test.ts`.
  `withAuth`/`withCsrf`/`withWriteAccess` are pass-throughs so the real handler
  body runs against real Postgres. Expected 200 and the receipt re-parented; got
  500, and the log line is
  `customer-merge POST failed … "error":"column \"customer_id\" does not exist"`.
  1 test, 1 failed. Output: `red.log`.

**Proposed minimal fix.** Line 62-67: `UPDATE customer_payments SET client_id =
${target_id} WHERE client_id = ${source_id} AND company_id = ${companyId}`.
Two adjacent defects sit in the same handler and should go with it:
step 2 re-parents `customer_invoices` by `customer_id` only and must also move
`client_id` (`COALESCE` shape, per CLAUDE.md); step 7 is commented "soft-delete"
but sets `is_active = false` while step 1 gates on `deleted_at IS NULL`, so a
merged source stays eligible to be merged again.

**Historical-data impact.** None: nothing was ever written. Every attempted
merge rolled back whole. No remediation SQL needed. Users may have re-keyed
duplicate customers by hand instead; that is a data-quality question, not a
correction.

**Risks.** Fixing step 3 alone makes the merge succeed while step 2 still leaves
`client_id` pointing at the merged-away customer — the invoices would then be
split across both columns. Fix steps 2, 3 and 7 together or not at all.
