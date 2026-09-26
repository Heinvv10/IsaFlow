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
- Migration 711 adds `supplier_payments.settles_provisional_je_id` with a partial unique index (`WHERE settles_provisional_je_id IS NOT NULL AND status <> 'cancelled'`). This is the constraint behind the lock. A voided (cancelled) payment releases the claim.
- If a qualifying provisional's lines do not add up to its bank line, the approval is refused with an error. Posting the invoice beside it would double-book, and reclassing it would be a guess.

### Amounts that differ (decided: settle, capped, never refuse)
The whole provisional is always reclassed, and the payment is always for the whole bank amount. Only the application is capped, at the invoice's outstanding balance:
- **Invoice above the bank line** (R130 vs R115): the invoice ends `partially_paid` and R15 stays open on the bill. GL AP is R15 CR and the subledger is also R15.
- **Bank line above the invoice** (R140 vs R120): the invoice ends `paid`, and the payment keeps R20 unapplied (status `processed`). GL AP is R20 DR, the same figure as that unapplied remainder.

In both cases expense and VAT are the invoice's own figures, booked once. Why not refuse? A refusal either lets the approval through with the double booking still standing, or blocks the approval with no in-product way to un-evidence a provisional. The capped settlement never leaves GL and subledger apart. It puts the difference on a named document, where `list_unapplied_payments`, `reconcile_subledger` and the ageing already show it to a human. The attach matched within ±R0.01, so a difference means the invoice was edited afterwards or the slip is not really that payment. Either way a human looks at an open balance, not at a hidden duplicate.

### Dates
The reclass and the payment are dated with the invoice's journal (the invoice date). The pair therefore nets inside one period and never posts into the provisional's period, which may already be filed. The input VAT stays claimed where the provisional claimed it, on the bank date. By construction of the attach match, that is within ±2 days of the document date.

**Correction (review round).** An earlier version of this section said a locked invoice date meant "a refusal, not a silent double booking". That was wrong. Through `supplier-invoices-action`, the approval opts into the s16(3) late claim, so the invoice's journal DID post, its VAT split into the next open period. Only then was the reclass refused, and withAuth COMMITs the 400. Result: VAT claimed twice, and the approval could not be retried. Reproduced at f3337c3e9. The log shows `Late input VAT claim split` with claimDate 2026-10-01, then a 400.

### An invoice dated in a filed VAT period (decided: refuse)
The approval is refused before anything is written (`provisionalSettlementClaim.ts`) when both hold:
- the invoice date is inside an active VAT lock;
- the provisional's lines move a VAT figure.

Why refuse:
- The provisional's input VAT is already in the filed return.
- The only journal that could cancel the invoice's claim is the reclass's VAT credit. That is an input reduction, which the late-claim rules refuse (`input_reduction`). So it cannot be given the treatment the invoice got.
- The only date on which the reclass nets the invoice's VAT is inside the filed period.

Refusing leaves VAT claimed exactly once (the provisional's, in the filed return) and the filed period untouched. Test: `r127-approve-vat-lock`, through the route. It checks the 400 naming the filed period, an unchanged snapshot, and company input VAT = R91.50, the provisional's alone.

The remedy is in the message. Leave the bill unapproved or cancel it. If the provisional is wrong, reverse it first; that is allowed while no settlement holds it. The reversal rolls past the lock, and the approval then claims the VAT late, once.

### Atomicity (review HIGH)
`approveSupplierInvoice` and `postSupplierInvoiceToGL` each run in their own savepoint. Any failure in the settlement takes the invoice's own journal and status with it, even when the caller answers 4xx and withAuth COMMITs.

Every ordinary refusal is decided in the claim, before the first write:
- the provisional is contended (retryable);
- it is already taken;
- its lines don't add up;
- a line is on a deactivated account (`postJournalEntry` refuses every posting to one, reversals included);
- the invoice is dated in a filed VAT period (above).

The two remaining failure points from the review are designed out:
- The reclass carries the provisional's lines in `historical-copy` mode, as a reversal does, so a retired cost centre no longer refuses it.
- The payable account is passed in rather than read back from the journal.

The application plan cannot refuse by construction: same supplier, amount capped at the outstanding balance, invoice just approved. The savepoint is the backstop.

Tests: `r127-approve-route-atomic`, through the route. A settlement failure injected after the invoice journal leaves an unchanged snapshot. A retired CC1 still settles. A deactivated account gives a clean 400 with an unchanged snapshot. A Post to GL called in a transaction that COMMITs after the throw keeps nothing.

### The auto-approve paths
`capture/[id]/post` and `ai-invoice-pipeline` INSERT an auto-approved invoice as `approved`, with no journal and no call to `approveSupplierInvoice`, and then run the attach. Before this fix, when the attach evidenced a provisional, the GL held the bill once but the AP subledger showed it owing. "Post to GL" (`postSupplierInvoiceToGL`, bulk `post_gl`) would then have booked it a second time.

Both routes now call `capture/provisionalAttachSettle.attachEvidenceAndSettleApproved`. When the invoice was inserted `approved` and the attach succeeded, that function posts the invoice through `postSupplierInvoiceToGL`, which carries the same settlement, in its own savepoint. It is best-effort, like the attach. If it fails, only the settlement rolls back. `postSupplierInvoiceToGL` itself also settles, which covers a later manual or bulk Post to GL.
- `ai-invoice-pipeline` writes line items, so its auto-approved invoice ends `paid` and is booked once (tested through the route).
- `capture/[id]/post` writes **no `supplier_invoice_items`** (see below), so its journal cannot balance. The settlement fails in its savepoint and the invoice stays `approved` and unposted, as before. Nothing is booked twice and the request commits (tested). Its subledger overstatement remains until that separate defect is fixed. The census reports these rows as `subledger_only`.

## Separate defect (not fixed here): capture/[id]/post creates invoices without line items
`pages/api/accounting/capture/[id]/post.ts` INSERTs `supplier_invoices` directly and never writes `supplier_invoice_items`. `buildExpenseLines` therefore produces no expense lines, and every journal attempted for such an invoice is unbalanced (DR VAT only, CR AP total). This affects `approveSupplierInvoice` for its drafts and `postSupplierInvoiceToGL` for its auto-approved invoices. Such an invoice can never be posted. The R-127 repro fixture adds an item for this reason. `ai-invoice-pipeline` does write items. This needs its own register item.

## Undoing a settlement: void refused, unapply is the undo (Hein, option C)
A settlement payment's journal is the provisional's reclass, not a bank payment. Before this change, voiding it succeeded (verified on the fixture). It reversed only the reclass and put the invoice back to `approved`, R115 open, while the provisional still stood. The ledger went back to the double-booked state: expense R200, VAT R30, AP R115 CR, bank R115 CR.

The first brief asked for the void to reverse the reclass and end at expense R100, VAT R15, AP R115 open and bank R115 once. Those four figures cannot all hold: R115 of debits against R230 of credits. Hein chose option C:
- **Void is refused on every path, before any write.** `refuseProvisionalSettlementVoid` (`ap/supplierPaymentGates.ts`) throws a `SupplierPaymentRefusal` naming `unapply_supplier_payment`. It runs in `voidIfUnprocessed`, which serves the `supplier-payments-action` route (answers 400), and in `core/paymentVoidService.voidPaymentDocument`, which serves MCP `void_payment` (coded refusal, surfaced with its message). It reads `settles_provisional_je_id` from the payment row each path has already read under its lock, so it adds no query.
- The other supplier-payment exits cannot reach a settlement payment. `cancelSupplierPayment` already refuses processed and reconciled payments. Batch reversal only touches batch members, and a settlement payment has no batch. The bank-allocation reversal finds payments through the bank lines matched to their journal, and the reclass has no bank line. Read from code, not tested: `reverse_bank_allocation` pointed at the provisional's own bank line was not exercised; it belongs with the item below.
- **Unapply is the undo, unchanged.** A second bill raised from the same slip is now REFUSED (review LOW 1). The refusal names the payment and the bill it paid, rather than approving that second bill unsettled. It moves only the subledger. The invoice reopens (R115, `approved`, `amount_paid` 0). The payment stays `processed` with R115 unapplied on the same supplier. The GL does not move: expense R100, VAT R15, bank R115 once, net AP nil (the bill's R115 against the payment's R115). The payment is still live, so it keeps the provisional's claim. A re-approval cannot settle twice: re-approving the original is refused as already approved, Post to GL is a no-op, and a fresh bill from the same slip is refused. The credit applies to another bill of the same supplier through the normal application service.
- **UI gap:** unapply exists only as the MCP tool `unapply_supplier_payment`. There is no REST route or UI action for it, so a UI-only user who hits the refusal has no in-app remedy.

Tests: `tests/integration/r127-settlement-void.int.test.ts` (6).
- Route void answers 400 and a full snapshot is unchanged (ledger, invoice, payment, journal count).
- MCP void_payment raises a coded refusal and the snapshot is unchanged.
- Another company gets not-found, with nothing about the settlement in the message.
- Unapply leaves the exact figures above.
- The credit re-applies to another bill.
- The claim holds after unapply.

## Reversing either half of a settlement (review MEDIUM, LOW 4)
`reverseJournalEntry` refuses, pre-write, to reverse either half of a live settlement (`provisionalSettlementGuards.refuseReversingSettlementJournal`):
- the provisional a live `supplier_payments.settles_provisional_je_id` names;
- the reclass, i.e. the journal of such a payment.

Only entries whose source is `auto_bank_recon` or `auto_supplier_payment` are looked up, so every other reversal is decided without a query.

Every caller inherits the refusal:
- `journal-entries-action` answers 400;
- MCP `reverse_journal_entry` raises a coded refusal that the registry answers with its message;
- the auto-post run undo counts the line as `failed` and keeps the run open.

`reverseReconciledTransaction` (`reverse_bank_allocation`, batch, range and REST) used to be able to reach the settled provisional's own bank line. That line has no matched journal line, so the call reversed nothing and set the line back to `imported`, leaving the cash booked and re-allocatable. It now refuses (`refuseSettledProvisionalLine`). `dismissProvisionalEntry` was already safe, because it refuses an evidenced provisional. Tests: `r127-settlement-reverse`.

## Other limits
- An approval that reuses an existing journal (the `glJournalEntryId` branch in `approveSupplierInvoice`, legacy "Post to GL then approve" drafts) is not settled. Since R-118 no new rows reach it. Legacy rows show in the census.

## Census (READ-ONLY; run on the fixture only)
`census.sql`, in this folder, lists every invoice in the AP population (`approved` / `partially_paid` / `paid`) whose source document also evidences a live bank-first provisional in the same company. For each row it gives:
- `kind`: `double_booked_gl`, where the invoice's own journal is live, or `subledger_only`, where the invoice was auto-approved with no journal;
- `already_settled`: a live payment with reference = the bank transaction id is applied to the invoice.

It does not read migration 711's column, so it runs before or after the deploy.

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
- GREEN: 5 files, 22 tests, all passing on the fixture (the void file's 6 are listed above):
  - `r127-double-booking` (1)
  - `r127-provisional-settle-guards` (10)
  - `r127-provisional-settle-race` (1)
  - `r127-capture-auto-approve` (4)
- Mutations: `mutations.log`. 14 mutations. 13 went red on a named test. Two of those first survived and were closed:
  - M1: a silent `continue` masked the company guard. It now throws.
  - M10: the savepoint was only exercised by a failure before any SQL. A trigger-injected failure after the invoice journal was added.
  M12, the status check, is masked by R-118's draft refusal and is kept as defence.

### Follow-up round (2026-09-26)
- **Migration renumbered to 711.** 708–710 are reserved for R-035, R-032 and R-088. `audit-migration-naming` is clean.
- **File sizes.**
  - `supplierInvoiceWorkflowService.ts`: 512 on master, 481 now. The wiring is two one-line hooks per path, and the private row mapper moved, byte-identical, to `ap/supplierInvoiceWorkflowRow.ts`.
  - `core/paymentVoidService.ts`: 310, now 266. Its two pre-lock reads moved to `core/paymentVoidReads.ts`.
  - `supplierPaymentWorkflowService.ts` (324) and `types/ap.types.ts` (307) are untouched.
  - Every new file is ≤ 300.
- **RED for the void refusal:** `red.log`, second block. **Mutations V1–V5:** `mutations.log`.

### Review round (REQUEST_CHANGES, 2026-09-26)
- RED f3337c3e9: 13 assertion failures, all through the real routes or services with their real commit semantics. See `red.log`, third block.
- Fix 5ec2c3a35 covers atomicity, the pre-write refusals, the reversal chokepoint and the LOW items.
  - LOW 2: the lock timeout now names the provisional.
  - LOW 3: 711 gains a same-company trigger (SQLSTATE 23503). `gl_journal_entries` has no UNIQUE (company_id, id), and adding one would build a unique index over the whole journal table for this one column.
- Mutations R1–R12 are all red. R3 and R4 go red on the message only: the savepoint still keeps the snapshot clean, and the pre-checks are what make those refusals clean and named. See `mutations.log`.
- File sizes (master → now):
  - `bankAllocationService.ts` 922 → 879 (`assertReversalDatePostable` moved unchanged to `bank/reversalDatePostable.ts`);
  - `supplierInvoiceWorkflowService.ts` 512 → 496;
  - `journalEntryPostingService.ts` 251 → 253;
  - the claim was split out to `ap/provisionalSettlementClaim.ts` (≈170).
