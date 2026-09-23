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

## Review round 1 (blind reviewer), all findings fixed

| Finding | Fix | Proof |
|---|---|---|
| HIGH: the guard broke `tests/integration/api/supplierInvoiceApproveReusesJournal.test.ts`, whose step 1 was "Post to GL a draft" — the very sequence R-118 forbids — leaving the reuse guard (one journal, not two) without cover. My own run had missed it: I ran only the R-118 and K-014 suites, and CI does not run integration (gated on DATABASE_URL). | The test now seeds `gl_journal_entry_id` from a separate approved bill, which is the pre-guard production shape, and keeps both assertions. | The file passes, and mutation M3 (guard above the early return) turns it red again. |
| MEDIUM: the guard sat ABOVE the `glJournalEntryId` early return, so a draft that already carried a journal — the shape the register calls unassessed — threw instead of returning `alreadyPosted`. | Moved below it. Nothing new is posted for such a row, so refusing it only broke idempotency. | New case "is still an idempotent no-op for a draft that already carries a journal"; M3 red. |
| MEDIUM: `journalCount()` matched `description LIKE '%<uuid>%'`, but the description carries the invoice NUMBER, so it returned 0 either way. | Keyed on the invoice number. Caught a second trap while fixing it: a `<number>-SRC` helper bill matches `LIKE '%<number>%'`, so the donor bill has an unrelated number. | M1 now fails 2 tests rather than 1. |
| MEDIUM: the AR mirror `postCustomerInvoiceToGL` had the identical defect, reachable from `customer-invoices-gl.ts` with no status filter. | Same guard, same position. `approveCustomerInvoice` sets the status before posting, so approval is unaffected. | Two AR cases; M4 and M5 red. |
| LOW: the module docs record every behavioural change to these functions. | Noted in `ap/.claude.md` and `ar/.claude.md`; mirrors regenerated. | `agent-docs:check` OK. |
| LOW: the bulk bar showed only the first error, so a page of drafts gave one generic banner. | Failures are grouped by reason with counts. | — |

Mutations (`mutations.log`), all red: AP guard removed, AP guard narrowed to draft-only, AP guard above the early return, AR guard removed, AR guard narrowed to draft-only.
