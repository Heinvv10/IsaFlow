# K-073 — match candidates drop invoices carrying client_id

**Claim.** `fetchCustomerInvoiceCandidates` joins on bare `customer_id`, so "half the invoice
population is invisible to bank matching". (`bankMatchDbQueries.ts:107`, audited at `5661d6f0`;
file unchanged on `origin/master`.)

**Disposition: false-positive.**

**Disconfirming evidence (schema).** The join at
`origin/master:src/modules/accounting/services/bank/bankMatchDbQueries.ts:108` is
`JOIN customers c ON c.id = ci.customer_id`. On the production schema
`customer_invoices.customer_id` is `uuid NOT NULL` with
`customer_invoices_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id)`.
Every row therefore has exactly one joinable customer and the inner join can eliminate none.
No migration relaxes it: `grep -rn supplier_invoices/customer_invoices … DROP NOT NULL` over
`scripts/migrations/sql/` returns nothing for this column.

**Disconfirming evidence (executed).**
`tests/integration/k073-customer-invoice-customer-join.int.test.ts` — 2 tests, **2 passed**,
real PostgreSQL fixture. Test 1 attempts an insert with `customer_id = NULL` alongside a
populated `client_id` and Postgres refuses it (`null value in column "customer_id"`). Test 2
seeds an invoice carrying BOTH `client_id` and `customer_id` and asserts
`fetchCustomerInvoiceCandidates` returns it — it does. Output: `red.log` (green, kept as the
tripwire: if `customer_id` is ever made nullable, test 1 fails and this finding becomes live).

**What is true underneath the claim.** `CLAUDE.md` mandates `COALESCE(ci.client_id, ci.customer_id)`
for customer invoices, and this query does not use it. The consequence is not a dropped row but
a possibly wrong *label*: the candidate's display name comes from `customers` even when
`client_id` names the real counterparty. That is a cosmetic naming issue in the match modal, not
the population loss the claim describes, and it does not affect which invoices are offered or
which one is settled.

**Proposed fix.** None required for the claimed defect. If the labelling is worth correcting,
`LEFT JOIN clients cl ON cl.id = ci.client_id` and prefer `COALESCE(cl.name, c.name)` — a
display-only change to `bankMatchDbQueries.ts:105-113`.

**Historical-data impact.** None. No invoice was withheld from bank matching by this join.

**Risks.** The tripwire test depends on the fixture schema tracking production. It is cheap and
fails loudly if the NOT NULL is dropped.
