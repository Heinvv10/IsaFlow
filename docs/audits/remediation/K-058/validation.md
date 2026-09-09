# K-058 — Debtors dashboard omits every invoice with a NULL client_id

**Claim (AA H / A H26).** Three queries join on `client_id` alone rather than
`COALESCE(client_id, customer_id)`, dropping legacy invoices.

**Corrected trigger.** The code defect is exactly as claimed and reproduces. What the
claim does not establish is the population: I could not count affected production rows
(production is out of scope for this validation), and no CURRENTLY WORKING writer
creates a NULL `client_id` — see reachability below. Treat this as a confirmed defect
whose historical impact is unquantified.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)
- `debtorsManagerService.ts:115` — `getDebtorsSummary`: `JOIN customers c ON
  c.id = ci.client_id` (INNER). A NULL `client_id` matches nothing and the row is
  dropped, not flagged.
- `debtorsManagerService.ts:163` — `getDebtorDetail`: `AND ci.client_id = $2::UUID`.
- `debtorsManagerService.ts:214` — `getOverdueInvoices`: same INNER JOIN.
- `debtorsManagerService.ts:260,262` — `getCollectionStats` counts
  `DISTINCT ci.client_id`, so the same rows are missing from the stats tile. That is a
  FOURTH site the claim does not name.
- Schema (fixture DB): `customer_invoices.client_id` is NULLABLE,
  `customer_invoices.customer_id` is NOT NULL — so the two are not interchangeable
  and `COALESCE` is the documented read pattern (root `CLAUDE.md`).
- `arAgingService.ts:41,44` reads the same invoices through
  `COALESCE(ci.client_id, ci.customer_id)`, so the two surfaces disagree about one book.
- Reachability of NULL `client_id`: every live writer sets both columns
  (`customerInvoiceCreateService`, `quoteConvertService`, `recurringInvoiceService`,
  `salesOrderWorkflowService`, `practiceWipService`, `sageCustomerImportService`,
  `sageMigrationCommitService`, `time-entries-invoice`). The one writer that sets
  `customer_id` only — `migrationImportService.ts:134` — also writes a `balance_due`
  column that does not exist in the schema, so that INSERT throws and the path is
  currently dead. NULL `client_id` rows are therefore legacy or import-era only.

## RED test
`tests/integration/k058-debtors-drops-null-client-id.int.test.ts` — 3 tests,
**2 failed, 1 passed**. The passing test is the control: AR aging counts the NULL
`client_id` invoice (R1,750). The dashboard reports R1,000 and the overdue list shows
one invoice instead of two. Output: `red.log`.

## Proposed minimal fix
In `debtorsManagerService.ts`, replace `ci.client_id` with
`COALESCE(ci.client_id, ci.customer_id)` in the join, the GROUP BY and the projection
of `getDebtorsSummary` (:85,115,119), in the predicate of `getDebtorDetail` (:163),
in `getOverdueInvoices` (:204,214), and in the DISTINCT of `getCollectionStats` (:260).
Do not change the writers — backfilling `client_id` is a separate, riskier decision.

## Historical-data impact
Unquantified here. Read-only count, to be run by whoever has production access:

```sql
SELECT company_id, count(*) AS invoices,
       sum(total_amount - COALESCE(amount_paid,0)) AS hidden_outstanding
FROM customer_invoices
WHERE client_id IS NULL
  AND status IN ('approved','sent','partially_paid','overdue')
  AND (total_amount - COALESCE(amount_paid,0)) > 0
GROUP BY company_id;
```
If that returns nothing, the finding is real but inert and should be fixed as
hygiene, not as an incident. If it returns money, that money has been invisible to
collections while appearing in aging.

## Risks
Low and one-directional: the fix ADDS rows to the dashboard, so debtor totals rise
toward the aging figure rather than moving away from it. The one thing to check is
that `COALESCE` does not introduce duplicate debtor rows where an invoice's
`client_id` and `customer_id` point at different customers — worth a
`WHERE client_id IS NOT NULL AND client_id <> customer_id` count before merging.
