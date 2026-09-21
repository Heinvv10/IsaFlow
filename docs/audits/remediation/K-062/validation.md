# K-062 — customer statement filters by client_id only

**Claim.** `pages/api/accounting/customer-statement.ts:86` omits legacy
`customer_id` invoices and payments, understating the statement balance.

**Corrected trigger.** Half right. Invoices: confirmed — the detail query
(line 89) and the headline-totals subquery (line 143) both filter
`client_id = $customerId`, while `customer_invoices.customer_id` is NOT NULL and
`client_id` is nullable. Payments and credit notes: no defect —
`customer_payments` and `credit_notes` have only `client_id`, no `customer_id`,
so there is nothing to COALESCE there.

The omitted shape has a live producer:
`src/modules/accounting/services/core/migrationImportService.ts:134` inserts AR
opening-balance invoices with `customer_id` and no `client_id`, reachable from
`pages/api/accounting/migration/ar-invoices.ts`. Every other
`INSERT INTO customer_invoices` writer sets both columns.

**Disposition: confirmed** (invoices only; the payments half of the claim is a
false positive).

**Evidence.**
- File unchanged between `5661d6f0` and `origin/master`; column nullability and
  the absence of `customer_payments.customer_id` read from the fixture schema.
- RED test: `tests/integration/k062-customer-statement-client-id-only.int.test.ts`.
  Two R600/R400 invoices for one customer, one with `client_id` set and one with
  it NULL (the migration-import shape); the real handler runs with auth wrappers
  stubbed. Expected both references and `totalInvoiced` 1000; got only
  `K062-INV-LINKED` and 600. 1 test, 1 failed. Output: `red.log`.

**Proposed minimal fix.** In the two invoice predicates (lines 89 and 143)
replace `client_id = ${customerId}::UUID` with
`COALESCE(client_id, customer_id) = ${customerId}::UUID`. Leave the payment and
credit-note predicates alone. The statement also includes soft-deleted invoices;
separate finding.

**Historical-data impact.** No stored value is wrong; the statement is a read.
Customers with importer-created opening balances were sent statements
understating what they owe. Read-only exposure count:

```sql
SELECT company_id, COUNT(*), SUM(total_amount - COALESCE(amount_paid,0))
FROM customer_invoices
WHERE client_id IS NULL AND deleted_at IS NULL AND status <> 'cancelled'
GROUP BY 1;
```
Not run — production is out of scope.

**Risks.** Low. The change widens a read; the company predicate is untouched.
