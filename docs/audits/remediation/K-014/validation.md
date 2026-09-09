# K-014 — Supplier bill posted to the GL twice

**Claim.** The alternate post-to-GL path checks the journal link without locking the invoice,
so overlapping calls post two journals.

**Corrected trigger.** `postSupplierInvoiceToGL` reads the invoice with a plain SELECT
(`getSupplierInvoiceById`, supplierInvoiceWorkflowService.ts:201) and decides on
`invoice.glJournalEntryId` at :211. No row lock. Its sibling `approveSupplierInvoice` takes
`lockSupplierInvoiceForUpdate` at :95 for exactly this reason — the asymmetry is the defect.
Two overlapping requests both read NULL, both post, and the second `UPDATE` at :247 overwrites
the first's `gl_journal_entry_id`, orphaning journal one where `cancelSupplierInvoiceInner`
(which reverses only the id on the row) can never reach it. An `approve` holding the row lock does not block a concurrent `postSupplierInvoiceToGL` either.

**Disposition: confirmed.**

**Evidence.** File unchanged 5661d6f0..ebeac9ca. RED integration test on real PostgreSQL,
sequenced not raced: two open transactions, the second call issued only after the first has
posted, the first committed only once `pg_stat_activity` shows the second waiting on a lock.
Result: two journals, AP credited R230 for one R115 bill.

**Reachability.** `pages/api/accounting/supplier-invoices-bulk-action.ts:87` (`action=post_gl`)
calls it inside one request transaction across up to 100 bills — a window of seconds, not
milliseconds. Two operators, or an agent retrying with a fresh idempotency key, is enough.

**RED test.** `tests/integration/k014-supplier-bill-double-gl-post.int.test.ts` — 1 failed / 1.
Log: `docs/audits/remediation/K-014/red.log`.

**Proposed minimal fix.** In `postSupplierInvoiceToGL`, take `lockSupplierInvoiceForUpdate(companyId, id)`
before the `getSupplierInvoiceById` read (mirroring :95), returning the same not-found error when
it yields null. Re-read after the lock so the `glJournalEntryId` early-return at :211 sees settled
state. No new pattern; the helper and its lock-timeout error already exist.

**Historical-data impact.** Any bill carrying two `auto_supplier_invoice` journals has AP,
expenses and input VAT doubled, and only the later journal is reversible by cancel. Read-only:
```sql
SELECT si.company_id, si.id, si.invoice_number, count(*) AS journals
  FROM supplier_invoices si
  JOIN gl_journal_entries je ON je.company_id = si.company_id
   AND je.description = 'Supplier invoice ' || si.invoice_number
   AND je.source = 'auto_supplier_invoice'
 GROUP BY 1,2,3 HAVING count(*) > 1;
```

**Risks.** The lock is held to end of request; a bulk post_gl of 100 bills then holds 100 row
locks, as bulk approve already does.
