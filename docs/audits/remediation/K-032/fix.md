# K-032 fix — cancelled documents leave their reversal in the VAT201

**Trigger.** Cancelling a credit note (or an invoice) posts a reversing journal
and leaves `gl_journal_entry_id` on the ORIGINAL document row.
`reverseJournalEntry` dates that reversal into the original's period while the
period is open. The `cancelled_entries` CTE in the ledger-derived VAT201 only
collects document-linked journals, so the original was suppressed and the
reversal — linked from no document — survived into the boxes.

**Before.** A cancelled R1 000 + R150 customer credit note contributed R150 of
output VAT and R1 000 of standard-rated base that no supply gave rise to. With
the reversal dated into the NEXT period, that period instead went R150 negative.

**After.** `cancelled_entries` is split into a base CTE of document-linked
journals plus their `reversal_of_id` children, company-scoped. Both legs are
flagged `cancelled_source` and land in the `cancelled` role, in every period, so
a cancelled document nets to nothing wherever its two journals fall.

**Files.** `src/modules/accounting/services/reports/vatBoxBasisQuery.ts` (+10/-1).

**Tests.** `tests/integration/k-032-cancelled-credit-note-vat201.int.test.ts`
(1) — the validator's RED case. `tests/integration/k-032-cancelled-reversal-adjacent.int.test.ts`
(3) — cancelled INVOICE with same-period reversal, reversal dated into the next
period, and another tenant's cancelled pair. 4 passed against the disposable
PostgreSQL fixture; all 4 go RED when the query change is reverted
(`green.log`). `bunx tsc --noEmit` and `eslint` clean; `vitest run tests/unit`
9 320 passed.

**Migration / rollback.** None. Read-path only; revert the commit to roll back.

**Historical data.** No rows change. Any period holding a cancelled invoice or
credit note whose reversal is posted now recomputes lower. Scope query:
```sql
SELECT d.company_id, d.number, orig.entry_date AS original_date,
       rev.entry_date AS reversal_date, d.tax_amount, d.subtotal
FROM (SELECT company_id, credit_note_number AS number, status, tax_amount,
             subtotal, gl_journal_entry_id FROM credit_notes
      UNION ALL
      SELECT company_id, invoice_number, status, tax_amount, subtotal,
             gl_journal_entry_id FROM customer_invoices) d
JOIN gl_journal_entries orig ON orig.id = d.gl_journal_entry_id
JOIN gl_journal_entries rev ON rev.reversal_of_id = orig.id AND rev.status = 'posted'
WHERE d.status IN ('cancelled','void','voided')
ORDER BY orig.entry_date DESC;
```
Periods already locked by `vatPeriodLockService` will drift from what was filed.

**Limits.** One level of reversal only — a reversal of a reversal is not walked.
Supplier invoices share the fix but are not separately tested here.
