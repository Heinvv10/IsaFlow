# K-032 — Cancelling a credit note creates spurious VAT201 amounts

**Claim (BB F04):** cancellation keeps the original journal link, so the VAT201
excludes the original but includes the reversal, adding net sales and output VAT.

**Corrected trigger:** accurate. Two mechanics make it fire: `cancelCreditNote`
posts a reversing journal and leaves `credit_notes.gl_journal_entry_id` on the
ORIGINAL, and `reverseJournalEntry` dates the reversal to the original's
`entry_date` when that period is still open — so both journals land in the same
VAT period and only one of them is suppressed. This affects the LEDGER-derived
VAT201 (report, export, MCP tools), which is the opposite path from K-031.

**Disposition: confirmed.**

## Evidence (`git show ebeac9ca:<path>`)
- `src/modules/accounting/services/reports/vatBoxBasisQuery.ts:97-110` — the
  `cancelled_entries` CTE collects `ci.gl_journal_entry_id`,
  `si.gl_journal_entry_id` and `cn.gl_journal_entry_id` for cancelled documents.
  The reversal journal is linked from no document row, so it is absent from the
  CTE and its lines come back with `cancelled_source = false`.
- `src/modules/accounting/services/reports/vatBoxBasis.ts:197-200` — a
  `cancelledSource` line is classified `cancelled`/`settlement` and kept out of
  the boxes. The reversal's lines fall through to the normal `tax` and `base`
  roles at 202-209.
- `src/modules/accounting/services/ar/creditNoteCancelService.ts:51-57` — the
  reversal is posted; `104-110` — the UPDATE sets status, `cancelled_at` and
  `applied_amount = 0`, and does NOT clear `gl_journal_entry_id`.
- `src/modules/accounting/services/gl/journalEntryPostingService.ts:259-278` —
  the reversal takes the ORIGINAL entry date while the period is open.
- Files unchanged between 5661d6f0 and ebeac9ca.

## RED test
`tests/integration/k-032-cancelled-credit-note-vat201.int.test.ts` — 1 failed /
1 total. A cancelled R1 000 + R150 customer credit note with its posted original
and its posted reversal, both dated 15 June 2026. The boxes should net to zero;
`deriveVatBoxes` returns R150 of output VAT (and R1 000 of standard-rated base)
that no supply gave rise to. Fails for the claimed reason.
Output: `docs/audits/remediation/K-032/red.log`.

## Proposed minimal fix
Suppress the reversal alongside its original in `cancelled_entries`, using the
link the reversal already carries:
```sql
UNION
SELECT rev.id FROM gl_journal_entries rev
  WHERE rev.company_id = ${companyId}::UUID
    AND rev.reversal_of_id IN (SELECT id FROM cancelled_entries_base)
```
i.e. split the existing CTE into a base (document-linked) CTE and a second that
adds `reversal_of_id` children. That also fixes the same pairing for cancelled
customer and supplier invoices, which have the identical shape.

## Historical-data impact
Every period containing a cancelled credit note or cancelled invoice whose
reversal was dated into the same period overstates output VAT and standard-rated
supplies by the cancelled document's amounts. Read-only scope query:
```sql
SELECT cn.company_id, cn.credit_note_number, cn.cancelled_at,
       orig.entry_date AS original_date, rev.entry_date AS reversal_date,
       cn.tax_amount, cn.subtotal
FROM credit_notes cn
JOIN gl_journal_entries orig ON orig.id = cn.gl_journal_entry_id
JOIN gl_journal_entries rev ON rev.reversal_of_id = orig.id
WHERE cn.status IN ('cancelled','void','voided') AND rev.status = 'posted'
ORDER BY cn.cancelled_at DESC;
```
Rows whose two dates fall in the same VAT period are the overstated ones.

## Risks
Filing periods already locked by `vatPeriodLockService` will now recompute lower
than what was filed. That drift is exactly what the lock exists to surface, but
it should be expected rather than treated as a new defect.
