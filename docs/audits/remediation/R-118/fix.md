# R-118: the bulk "Post to GL" action posts a draft bill

## Defect
`postSupplierInvoiceToGL` guarded only `cancelled`. The bulk action (`supplier-invoices-bulk-action.ts`, `action=post_gl`) is offered on any selection — `BulkActionBar.tsx` applies no status filter — so a draft bill posts an Expense/VAT/AP journal in one click. The journal then stands on the GL half of every AP-vs-GL reconciliation while `documentInPopulationExpr` keeps the draft off the document half: a permanent difference by the bill's full amount, which is the difference R-086's check exists to surface.

## Fix
The function refuses any document outside the AP population (`documentInPopulation`, the JS twin of the rule the reports use), naming the remedy: approving posts the journal and moves the status together. `cancelled` keeps its own message, because the remedy there is different.

The bulk route already reports per-id `{ ok: false, error }`, so a mixed selection posts what it may and names what it refused.

## Evidence
`tests/integration/r118-post-gl-draft-guard.int.test.ts`, real PostgreSQL, service driven inside an `als` request transaction as `withAuth` does.
- RED (`red.log`): 2 of 4 fail — a draft and a pending-approval bill both posted.
- GREEN: 4 of 4; `k014-supplier-bill-double-gl-post.int.test.ts` still 4 of 4 (the row lock is untouched).
- Mutations: `if (false)` → 2 red; narrowing the guard to `status === 'draft'` → 1 red (the pending-approval case).

## Historical-data impact
Not assessed here. Bills already posted from draft are found with:
```sql
SELECT company_id, count(*), sum(total_amount)
FROM supplier_invoices
WHERE status IN ('draft', 'pending_approval') AND gl_journal_entry_id IS NOT NULL
GROUP BY company_id;
```
Read-only, not run against production by this session.

## Not covered
The AR mirror. `customer_invoices` has no equivalent bulk post action; approval is the only posting path there.
