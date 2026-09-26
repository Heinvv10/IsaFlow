# R-127: an evidenced bank-first provisional and the invoice from the same slip double-book

## What was found
Reproduced at c239c2b28. `postProvisional` expenses an outgoing bank line before any document exists (DR expense, DR VAT input, CR bank; `needs_evidence = true`). When the slip arrives, `attachEvidenceToProvisional` stamps it on that journal as evidence and marks the bank line `matched`. The capture routes also raise a supplier invoice from the same slip. When that invoice is approved, `approveSupplierInvoice` posts DR expense, DR VAT, CR AP. Nothing connected the two. On R100 + R15:

| | expense | VAT | AP | bank |
|---|---|---|---|---|
| before | R200 DR | R30 DR | R115 CR, never settled | R115 CR |
| after | R100 DR | R15 DR | nil | R115 CR (once, the provisional's own line) |

The invoice's journal carries no `source_document_id`, so the one-document-one-claim guard could not see it.

## Decision (Hein): the provisional becomes the payment
When a supplier invoice posts and its `source_document_id` evidences a qualifying provisional, the provisional becomes the invoice's payment. A provisional qualifies when it is posted, not reversed, has `needs_evidence = false`, is linked from `bank_transactions.provisional_je_id`, belongs to the same company, and is not consumed by any live payment. The settlement has three parts:
1. The invoice posts its normal journal. That journal is unchanged.
2. A reclass journal (`auto_supplier_payment`) posts DR AP, the account the invoice's own journal credited, and CR each non-bank line of the provisional, with its dimensions and `vat_type`. It is built with `gl/reversalLines.buildReversalLines`.
3. A `supplier_payments` row is inserted with status `processed`, reference = the bank transaction id, `bank_account_id` = the bank line's account, `gl_journal_entry_id` = the reclass, and `settles_provisional_je_id` = the provisional. It is applied through `planSupplierPaymentApplication` / `applySupplierPaymentPlan`, the same service every AP application uses. That service moves `amount_paid` and status, so the subledger, the ageing and the supplier statement agree with the GL. A GL post alone never does.

The bank line and the provisional are not touched.

Code: `src/modules/accounting/services/ap/provisionalInvoiceSettlement.ts` (`claimEvidencedProvisional`, `settleInvoiceFromProvisional`), called from `approveSupplierInvoice` and `postSupplierInvoiceToGL`.

### The claim
- `claimEvidencedProvisional` runs before the approval's first write. It locks the provisional with `FOR UPDATE OF je` (bounded to 5 s via `withSupplierInvoiceLock`). Only after holding the lock does it read whether a live payment already names the provisional. Two approvals of two invoices from one slip therefore serialise, and the second one reads the first one's payment.
- Migration 718 adds `supplier_payments.settles_provisional_je_id` with a partial unique index (`WHERE settles_provisional_je_id IS NOT NULL AND status <> 'cancelled'`). This is the constraint behind the lock. A voided (cancelled) payment releases the claim.
- If a qualifying provisional's lines do not add up to its bank line, the approval is refused with an error. Posting the invoice beside it would double-book, and reclassing it would be a guess.

### Amounts that differ (decided: settle, capped, never refuse)
The whole provisional is always reclassed, and the payment is always for the whole bank amount. Only the application is capped, at the invoice's outstanding balance:
- **Invoice above the bank line** (R130 vs R115): the invoice ends `partially_paid` and R15 stays open on the bill. GL AP is R15 CR and the subledger is also R15.
- **Bank line above the invoice** (R140 vs R120): the invoice ends `paid`, and the payment keeps R20 unapplied (status `processed`). GL AP is R20 DR, the same figure as that unapplied remainder.

In both cases expense and VAT are the invoice's own figures, booked once. Why not refuse? A refusal either lets the approval through with the double booking still standing, or blocks the approval with no in-product way to un-evidence a provisional. The capped settlement never leaves GL and subledger apart. It puts the difference on a named document, where `list_unapplied_payments`, `reconcile_subledger` and the ageing already show it to a human. The attach matched within ±R0.01, so a difference means the invoice was edited afterwards or the slip is not really that payment. Either way a human looks at an open balance, not at a hidden duplicate.

### Dates
The reclass and the payment are dated with the invoice's journal (the invoice date). The pair therefore nets inside one period and never posts into the provisional's period, which may already be filed. The input VAT stays claimed where the provisional claimed it, on the bank date. By construction of the attach match that is within ±2 days of the document date. Limit: if the invoice date falls in a locked VAT period, the reclass's VAT credit is refused (plain `VatPeriodLockedError`, no late-claim split), and so is the approval. That is a refusal, not a silent double booking.

### The auto-approve paths
`capture/[id]/post` and `ai-invoice-pipeline` INSERT an auto-approved invoice as `approved`, with no journal and no call to `approveSupplierInvoice`, and then run the attach. Before this fix, when the attach evidenced a provisional, the GL held the bill once but the AP subledger showed it owing. "Post to GL" (`postSupplierInvoiceToGL`, bulk `post_gl`) would then have booked it a second time.

Both routes now call `capture/provisionalAttachSettle.attachEvidenceAndSettleApproved`. When the invoice was inserted `approved` and the attach succeeded, that function posts the invoice through `postSupplierInvoiceToGL`, which carries the same settlement, in its own savepoint. It is best-effort, like the attach. If it fails, only the settlement rolls back. `postSupplierInvoiceToGL` itself also settles, which covers a later manual or bulk Post to GL.
- `ai-invoice-pipeline` writes line items, so its auto-approved invoice ends `paid` and is booked once (tested through the route).
- `capture/[id]/post` writes **no `supplier_invoice_items`** (see below), so its journal cannot balance. The settlement fails in its savepoint and the invoice stays `approved` and unposted, as before. Nothing is booked twice and the request commits (tested). Its subledger overstatement remains until that separate defect is fixed. The census reports these rows as `subledger_only`.

## Separate defect (not fixed here): capture/[id]/post creates invoices without line items
`pages/api/accounting/capture/[id]/post.ts` INSERTs `supplier_invoices` directly and never writes `supplier_invoice_items`. `buildExpenseLines` therefore produces no expense lines, and every journal attempted for such an invoice is unbalanced (DR VAT only, CR AP total). This affects `approveSupplierInvoice` for its drafts and `postSupplierInvoiceToGL` for its auto-approved invoices. Such an invoice can never be posted. The R-127 repro fixture adds an item for this reason. `ai-invoice-pipeline` does write items. This needs its own register item.

## Open question for Hein: voiding the settlement payment
Verified on the fixture: `voidSupplierPayment` on a settlement payment succeeds. It reverses only the reclass, and it un-applies the invoice back to `approved`, R115 open. The provisional still stands, so the ledger returns to the double-booked state (expense R200, VAT R30, AP R115 CR, bank R115 CR). The void is a deliberate human action, and the result stays visible as an open bill beside an evidenced provisional. The census finds it. It is still a UI path back into the defect.

The options are:
- (a) refuse voiding a payment that has `settles_provisional_je_id`, and name the remedy;
- (b) have the void also reverse the provisional and return the bank line to `imported`;
- (c) leave it as it is.

This fix does (c) and does not decide the question.

## Other limits
- An approval that reuses an existing journal (the `glJournalEntryId` branch in `approveSupplierInvoice`, legacy "Post to GL then approve" drafts) is not settled. Since R-118 no new rows reach it. Legacy rows show in the census.
- Unapplying the settlement payment (`unapplySupplierPayment`) was NOT exercised. By construction the bill should reopen with the payment's unapplied remainder equal to GL AP, but this is unverified.

## Census (READ-ONLY; run on the fixture only)
`census.sql`, in this folder, lists every invoice in the AP population (`approved` / `partially_paid` / `paid`) whose source document also evidences a live bank-first provisional in the same company. For each row it gives:
- `kind`: `double_booked_gl`, where the invoice's own journal is live, or `subledger_only`, where the invoice was auto-approved with no journal;
- `already_settled`: a live payment with reference = the bank transaction id is applied to the invoice.

It does not read migration 718's column, so it runs before or after the deploy.

Checked on the fixture, inside a rolled-back transaction, against four seeded slips:
- a double-booked slip was reported as `double_booked_gl, f`;
- a no-journal slip was reported as `subledger_only, f`;
- a settled slip was reported as `double_booked_gl, t`;
- a provisional still needing evidence was correctly absent.

```sql
WITH prov AS (
  SELECT je.company_id, je.id AS provisional_je_id, je.entry_number, je.entry_date,
         je.source_document_id, bt.id AS bank_tx_id, ABS(bt.amount) AS bank_amount
  FROM gl_journal_entries je
  JOIN bank_transactions bt ON bt.provisional_je_id = je.id AND bt.company_id = je.company_id
  WHERE je.source_document_id IS NOT NULL
    AND je.status = 'posted' AND je.reversed_at IS NULL AND je.needs_evidence = false
)
SELECT p.company_id, c.name AS company_name, si.id AS invoice_id, si.invoice_number, si.status,
       si.invoice_date, si.total_amount, si.amount_paid, p.provisional_je_id,
       p.entry_number AS provisional_entry, p.entry_date AS provisional_date, p.bank_tx_id, p.bank_amount,
       CASE WHEN ije.id IS NOT NULL THEN 'double_booked_gl' ELSE 'subledger_only' END AS kind,
       EXISTS (SELECT 1 FROM supplier_payments sp
               JOIN payment_allocations pa ON pa.payment_id = sp.id AND pa.invoice_id = si.id
               WHERE sp.company_id = p.company_id AND sp.reference = p.bank_tx_id::TEXT
                 AND sp.status <> 'cancelled') AS already_settled
FROM prov p
JOIN supplier_invoices si ON si.company_id = p.company_id AND si.source_document_id = p.source_document_id
LEFT JOIN gl_journal_entries ije ON ije.id = si.gl_journal_entry_id AND ije.company_id = si.company_id
 AND ije.status = 'posted' AND ije.reversed_at IS NULL
JOIN companies c ON c.id = p.company_id
WHERE si.status IN ('approved', 'partially_paid', 'paid') AND si.deleted_at IS NULL
ORDER BY c.name, p.entry_date, si.invoice_number;
```
Rows already on production are not repaired by this fix. A backfill that settles them the same way is a separate, human-gated change.

## Evidence
- RED: `red.log` (commit dee75d345). 7 assertion failures, plus 6 green that pin the behaviour that must not change.
- GREEN: 4 files, 16 tests, all passing on the fixture:
  - `r127-double-booking` (1)
  - `r127-provisional-settle-guards` (10)
  - `r127-provisional-settle-race` (1)
  - `r127-capture-auto-approve` (4)
- Mutations: `mutations.log`. 14 mutations. 13 went red on a named test. Two of those first survived and were closed:
  - M1: a silent `continue` masked the company guard. It now throws.
  - M10: the savepoint was only exercised by a failure before any SQL. A trigger-injected failure after the invoice journal was added.
  M12, the status check, is masked by R-118's draft refusal and is kept as defence.
