# K-032 fix — a cancelled credit note's reversal in the VAT201

**Scope: credit notes only.** `customerInvoiceCancelService.ts:151` and
`supplierInvoiceWorkflowService.ts:315` NULL `gl_journal_entry_id` when they
cancel, so a cancelled invoice never enters `cancelled_entries_base` and this
pairing cannot reach it. Only `creditNoteCancelService` keeps the link. The
earlier revision of this document claimed the invoice paths shared the fix; they
do not, and the fabricated invoice fixtures that implied otherwise are gone.

**Trigger.** Cancelling a credit note posts a reversing journal and leaves
`gl_journal_entry_id` on the ORIGINAL. `resolveReversalDate` dates the reversal
into the original's period while that period is open. The `cancelled_entries`
CTE behind the ledger-derived VAT201 collected only document-linked journals, so
the original was suppressed and the reversal — linked from no document — stayed
in the boxes.

**Before.** A cancelled R1 000 + R150 credit note left R150 of output VAT and
R1 000 of standard-rated base that no supply gave rise to.

**After.** The pair is hidden together or not at all.
- The reversal is suppressed only when the journal it reverses falls inside the
  queried period.
- An original whose posted reversal falls OUTSIDE the period is no longer
  suppressed: when the original's period is closed, the reversal is dated later
  on purpose, the original was filed in its own period and the credit belongs in
  the later one. A cancelled document that was never reversed is still
  suppressed, so the legacy Brightsphere row is unaffected.
- The walk is `WITH RECURSIVE`, so reversing the reversal by hand no longer
  re-admits the cancelled document's VAT. `UNION` dedupes, so a cycle terminates.
- Both arms walk POSTED journals only. A draft reversal has no GL effect, so it
  neither frees its original nor passes suppression on to its own reversal.

**Files.** `src/modules/accounting/services/reports/vatBoxBasisQuery.ts`,
`scripts/migrations/sql/623_gl_je_reversal_of_index.sql` (partial index on
`gl_journal_entries(reversal_of_id)`; the CTE probes it on every VAT201 render,
and no index existed).

**Tests.** `k-032-cancelled-credit-note-vat201.int.test.ts` (1, the validator's
RED case, tax and base now asserted independently with `expect.soft`) and
`k-032-cancelled-reversal-adjacent.int.test.ts` (8: original stands in period N,
credit taken in N+1, reversal-of-reversal, never-reversed note, draft reversal,
draft reversal in a later period, June totals, cross-tenant `reversal_of_id`).
9 passed on the disposable PostgreSQL fixture. Seven separate mutations recorded
in `green.log`; the only predicate no test kills is `rev.company_id`, which the
company-scoped base CTE, `parent.company_id` and the outer `je.company_id`
filter make unreachable — no observable output can differ, so no test for it can
exist.

**Migration / rollback.** 623 is a `CREATE INDEX IF NOT EXISTS`, applied to the
fixture DB; drop the index and revert the commit to roll back. No data changes.
The prefix gap at 619-622 is deliberate: prefixes are being assigned across
parallel branches, and 623 was allocated to this one. Nothing is missing.
Deploy note: `apply-migrations.ts` wraps each file in a transaction, so
`CONCURRENTLY` is not available and the build takes a SHARE lock on
`gl_journal_entries` for its duration. Deploy outside business hours, which the
existing gate already requires.

**Historical data.** No rows change; this is a read path. Periods holding a
cancelled credit note recompute: same-period reversals now net to nothing,
cross-period ones keep the original in its period and the credit in the
reversal's. Scope query:
```sql
SELECT cn.company_id, cn.credit_note_number, orig.entry_date AS original_date,
       rev.entry_date AS reversal_date, cn.tax_amount, cn.subtotal
FROM credit_notes cn
JOIN gl_journal_entries orig ON orig.id = cn.gl_journal_entry_id
LEFT JOIN gl_journal_entries rev
  ON rev.reversal_of_id = orig.id AND rev.status = 'posted'
WHERE cn.status IN ('cancelled','void','voided')
ORDER BY orig.entry_date DESC;
```
Periods already locked by `vatPeriodLockService` will drift from what was filed.

**Limits.** Cancelled invoices are out of reach entirely, per the scope note
above — both their original and their reversal survive in the boxes today. That
is a separate defect this fix does not address.
