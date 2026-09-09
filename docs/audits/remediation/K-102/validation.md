# K-102 — Portal invoice and statement APIs query missing columns

**Baseline:** origin/master `31fc2f10`; `portalService.ts` unchanged since the audited `5661d6f0`.

**Claim vs corrected trigger.** Claim confirmed, and the count of five is right. The missing
references are `customer_invoices.total` (used three times, at
`src/modules/accounting/services/ar/portalService.ts:111`, `:113` and `:145` — the column is
`total_amount`) and, on `customer_payments`, `reference`, `amount` and `customer_id` (lines 152-155
— the table has `bank_reference`, `total_amount` and only `client_id`).

**Disposition: confirmed.**

**Evidence.** Read the fixture schema, which carries the current production shape:
`customer_payments` is `id, payment_number, client_id, payment_date, total_amount, payment_method,
bank_reference, bank_account_id, description, status, gl_journal_entry_id, project_id, created_by,
confirmed_by, confirmed_at, created_at, updated_at, cost_center_id, company_id`. Ran both queries
directly in psql: each fails with `ERROR: column "total" does not exist`. Postgres reports the
first bad column only, so the payments-side names are established from the catalogue, not from a
second error message.

**Reachability.** `GET /api/portal/invoices` calls `getClientInvoices`
(`pages/api/portal/invoices.ts:40`) and `GET /api/portal/statement` calls `getClientStatement`
(`pages/api/portal/statement.ts:41`). Both throw on every request for every tenant. The customer
portal's invoice list and statement have never worked.

**RED test.** `tests/integration/k102-portal-missing-columns.int.test.ts` — 2 failed, both with
`column "total" does not exist`. Output in `red.log`.

**Proposed fix.** In `portalService.ts`: rename `total` to `total_amount` in both queries (keeping
the `balance` expression); in the statement's payments leg select `bank_reference AS reference` and
`total_amount AS credit`, and drop `COALESCE(client_id, customer_id)` down to `client_id`, since
`customer_payments` has no `customer_id`. The invoice leg keeps its `COALESCE` — `customer_invoices`
genuinely has both columns.

**Historical impact.** None. The endpoints have never executed a write or returned data, so no row
is wrong. The impact is a dead feature, not corrupt books. Worth checking whether the portal is in
use at all before prioritising: `SELECT COUNT(*) FROM portal_access WHERE is_active;`

**Risk.** Low, but the fix must be verified against a real statement rather than a type-check:
`tests/**` is outside `tsconfig`, so a typo in a column alias would not surface at compile time.
