# K-014 fix — supplier bill posted to the GL twice

**Trigger.** `postSupplierInvoiceToGL` read the invoice with a plain SELECT and decided on
`glJournalEntryId` with no row lock, while its sibling `approveSupplierInvoice` locks first.
Two overlapping `action=post_gl` calls (the bulk action walks up to 100 bills in one request
transaction) both read NULL, both posted an Expense/VAT/AP journal, and the second UPDATE
overwrote the first's `gl_journal_entry_id` — AP, expenses and input VAT doubled, and the first
journal stranded where `cancelSupplierInvoiceInner` can never reverse it. An `approve` holding
the row lock did not block this path either.

**Before / after.** Before: two journals, AP credited R230 for one R115 bill. After:
`lockSupplierInvoiceForUpdate(companyId, id)` is taken before the read, so the loser blocks,
re-reads settled state and returns `{ alreadyPosted: true }` with the winner's journal id.
Guard order is otherwise unchanged (cancelled still refused; not-found still thrown).

**Files.**
- `src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts` (+16, lock + comment)
- `tests/integration/k014-supplier-bill-double-gl-post.int.test.ts` (+3 adjacent cases)
- `tests/unit/services/supplierInvoiceCancelReversal.test.ts` (mock the lock; +1 case)

**Tests.** Integration on real PostgreSQL, 4/4: sequenced two-client race (one journal, AP
credited 115.00, journal balanced 115 DR = 115 CR), sequential retry idempotence, wrong tenant
refused with nothing posted, cancelled bill still refused. Unit 10/10. Mutation-proof: reverting
the lock returns the race test to RED (`expected 2 to be 1`); see `green.log`. Unit suite shows
the same 204 pre-existing failures as origin/master.

**Migration / rollback.** None. Rollback is reverting the commit.

**Historical data.** Bills already carrying two `auto_supplier_invoice` journals are not repaired
by this change. Read-only detection (run per environment, not on production without approval):
```sql
SELECT si.company_id, si.id, si.invoice_number, count(*) AS journals
  FROM supplier_invoices si
  JOIN gl_journal_entries je ON je.company_id = si.company_id
   AND je.description = 'Supplier invoice ' || si.invoice_number
   AND je.source = 'auto_supplier_invoice'
 GROUP BY 1,2,3 HAVING count(*) > 1;
```

**Limits.** The lock is held to end of request, so a bulk post of 100 bills holds 100 row locks,
as bulk approve already does; a contended bill fails that one line with the existing 5s lock
timeout, which the bulk handler already reports per invoice. The file was 495 lines before this
change and is 511 after — over the 300-line guidance, pre-existing and not refactored here.
