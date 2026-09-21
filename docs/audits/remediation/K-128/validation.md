# K-128 — export leaves the client name blank on legacy invoices

**Claim.** `pages/api/accounting/customer-invoices-export.ts:29` joins customers on
`client_id` only, so customer_id-linked invoices export with no name.

**Corrected trigger.** Both branches of the route (lines 29 and 43 on origin/master
`31fc2f10`) carry `LEFT JOIN customers c ON c.id = ci.client_id`. On the live schema
`customer_invoices.customer_id` is NOT NULL and `client_id` is NULLABLE, so every
invoice written on `customer_id` alone joins to nothing. Being a LEFT join the row is
not dropped — it is exported with an EMPTY Client column, in a file a human
reconciles by customer. The repo rule is `COALESCE(ci.client_id, ci.customer_id)`.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:pages/api/accounting/customer-invoices-export.ts` lines 29, 43.
- Schema: `select column_name,is_nullable from information_schema.columns where
  table_name='customer_invoices'` → `client_id|YES`, `customer_id|NO`.
- Executed RED test (below), 2 of 2 failing: the modern invoice exports
  "K128 Modern Customer", the customer_id-only one exports `''`.

**Reachability.** `GET /api/accounting/customer-invoices-export`, `withAuth` +
`withWriteAccess`, no other guard. Both the unfiltered and the `?status=` branch.

**RED test.** `tests/integration/k128-invoice-export-legacy-customer-id.int.test.ts`
(2 tests, 2 failed) — output in `red.log`.

**Related.** Same root cause as K-093 (`reports/sales-by-customer.ts`), different call
site and different symptom (blank name here, dropped row there). Fixing K-093 does not
fix this file; both need the COALESCE.

**Proposed minimal fix.** In both query branches replace
`LEFT JOIN customers c ON c.id = ci.client_id` with
`LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)`. Two lines,
no other change. A sweep for the remaining `= ci.client_id` join sites is worth doing
under one id rather than one candidate at a time.

**Historical-data impact.** No stored row is wrong; every CSV already downloaded is.
Read-only impact query (NOT run — production is out of scope for this validation):

```sql
SELECT company_id, COUNT(*) FILTER (WHERE client_id IS NULL) AS nameless,
       COUNT(*) AS total
FROM customer_invoices GROUP BY company_id ORDER BY nameless DESC;
```

**Risks.** None material. COALESCE on a nullable FK cannot widen the row set beyond
the company predicate already on `ci.company_id`.
