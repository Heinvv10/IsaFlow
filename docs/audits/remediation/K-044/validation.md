# K-044 — recurring auto-post sets a forbidden status and writes no journal

**Claim.** A bare `UPDATE ... SET status='posted'` replaces the real posting path, violating
the invoice status CHECK and leaving no GL entry.

**Corrected trigger.** Confirmed for BOTH branches, not one:
`src/modules/accounting/services/core/recurringTransactionService.ts:191` (customer) and
`:239` (supplier). Neither `customer_invoices_status_check`
(`draft|pending_approval|approved|sent|paid|partially_paid|overdue|cancelled`) nor
`supplier_invoices_status_check`
(`draft|pending_approval|approved|partially_paid|paid|disputed|cancelled`) admits `'posted'`.
One correction to the claim: the header inserted moments earlier does NOT survive. The failed
statement aborts the transaction, so `withAuth`'s COMMIT on the route's 400 behaves as a
rollback. Nothing is written at all — auto-post is simply impossible, and the "no journal"
half is unreachable because the status write fails first. The `journal_entry` branch (:146-161)
is correct and does call `postJournalEntry`.

**Disposition: confirmed.**

**Evidence.** Baseline `origin/master` = `0f16391e`; file unchanged since `5661d6f0`.
RED test drives the real route against the disposable fixture:
`tests/integration/k-044-recurring-autopost-forbidden-status.int.test.ts` — 1 test, 1 failed.
PostgreSQL `23514` on `customer_invoices_status_check`, raised at
`recurringTransactionService.ts:191`; the route answered 400 and no `customer_invoices` row
remained. Log: `docs/audits/remediation/K-044/red.log`.

**Reachability.** `POST /api/accounting/recurring-transactions-execute` with a template whose
`auto_post` is true. Sibling defect, different service: K-013 covers `recurringInvoiceService`
and `recurring_invoices`; this is `recurringTransactionService` and
`recurring_transaction_templates`. Not a duplicate.

**Proposed minimal fix.** Replace both bare UPDATEs with the canonical approval calls that
already post the GL: `approveCustomerInvoice`
(`src/modules/accounting/services/ar/customerInvoiceApprovalService.ts:80`) for :190-194 and
`approveSupplierInvoice` (`src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts:69`)
for :238-242, passing `companyId`, the new invoice id and `userId`. That fixes the
status and the missing journal in one change, since those services are what post
DR AR / CR Revenue / CR VAT and the AP mirror.

**Historical impact.** No wrong rows: every auto-post attempt failed and rolled back. The loss
is silent non-delivery — templates marked `auto_post` have never produced an approved invoice
or a journal. Read-only impact query (not run here):
```sql
SELECT id, company_id, name, entity_type, frequency, last_run_date
FROM recurring_transaction_templates
WHERE auto_post = true AND is_active = true AND entity_type <> 'journal_entry';
```

**Risks.** Switching to the approval services makes these runs post to the GL for the first
time. Run the query above first and confirm with the tenant which templates should actually
post before enabling.
