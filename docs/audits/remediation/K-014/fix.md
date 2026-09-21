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

**Blast radius, fixed in the follow-up commit.** The lock carries a 5s `lock_timeout` whose
55P03 ABORTS the request transaction, and since PR #264 a whole bulk batch is one transaction.
So one contended bill failed every sibling with 25P02, and `withAuth` COMMITs on a <500
response — PostgreSQL runs that as ROLLBACK without raising, so the route answered 200 with a
success count for rows that had been discarded. Every id in
`supplier-invoices-bulk-action.ts` is now wrapped in `withSavepoint('bulk_supplier_invoice_item')`,
so a failed row rolls back to its savepoint and its siblings persist. If the savepoint's own
rollback fails (`als.getStore()?.txUnusable`) the route throws instead, so a genuinely lost
batch is reported as 5xx rather than as success.

**Files.**
- `src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts` (+16, lock + comment)
- `pages/api/accounting/supplier-invoices-bulk-action.ts` (per-id savepoint, tx-unusable bail,
  header comment corrected — the batch IS one transaction)
- `src/modules/accounting/services/ap/.claude.md` (recent-changes entry)
- `tests/integration/k014-supplier-bill-double-gl-post.int.test.ts` (+3 adjacent cases)
- `tests/integration/k014-bulk-post-gl-savepoint.int.test.ts` (new, drives the real route)
- `tests/unit/services/supplierInvoiceCancelReversal.test.ts` (mock the lock; +1 case)

**Tests.** Integration on real PostgreSQL, 6/6 across two files. The lock file, 4/4: sequenced
two-client race (one journal, AP credited 115.00, journal balanced 115 DR = 115 CR), sequential
retry idempotence, wrong tenant refused with nothing posted, cancelled bill still refused. The
bulk file, 2/2, driving the real route through `withAuth` with a second pool client holding
`FOR UPDATE` past the timeout: the uncontended sibling posts when the earlier id times out, and
a bill posted before the timeout stays posted, balanced and linked. Unit 10/10 plus the bulk
route's own 11/11, which now cover the two savepoint mechanics directly: nested SAVEPOINT /
RELEASE issued strictly LIFO around a service's own savepoint, and a FAILED
`ROLLBACK TO SAVEPOINT` making the handler throw rather than answer 200 with a success count. Mutation-proof both ways: reverting the lock returns the race test to RED
(`expected 2 to be 1`), reverting the savepoint returns both bulk tests to RED. See `green.log`.

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

**Limits.** The lock is held to end of request, so a batch at the route's 200-id cap holds 200
row locks, as bulk approve already does. A contended bill now fails that id alone: reported as
that item's error, rolled back to its savepoint, siblings committed. `supplierInvoiceWorkflowService.ts`
was 495 lines before this change and is 513 after (measured with `wc -l`) — over the 300-line
guidance, pre-existing and not refactored here; the bulk route is 133 lines. The savepoint change also covers `approve` and `cancel` on the same route,
which carried the same hazard before this commit; that is wider than K-014 but the same defect
and the same two lines.
