# K-056 — Dispute credit posts a VAT-inclusive amount at zero VAT

**Claim (AA H / A H19).** The credit note is created with the gross figure and no tax
split, overstating the revenue reversal.

**Corrected trigger.** Confirmed, with one correction that matters for the fix: the
credit note's TOTAL is right. Only the split is wrong. The customer's balance relief
is correct at gross; revenue is reversed by the VAT portion too much, and output VAT
already declared is never recovered.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)
- `disputeService.ts:311-313` — `createCreditNote(..., { subtotal:
  Number(existing[0].disputed_amount), taxRate: 0 }, ...)`.
- `disputeService.ts:127-133` — `raiseDispute` bounds `disputedAmount` by
  `total_amount - amount_paid`. `total_amount` is VAT-inclusive, so `disputed_amount`
  is a GROSS figure by construction.
- `creditNoteService.ts:113-115` — `taxRate = input.taxRate ?? 15;
  taxAmount = subtotal * taxRate / 100; totalAmount = subtotal + taxAmount`.
  With `taxRate: 0` the gross lands entirely in `subtotal` and `tax_amount` is 0.
- The default is 15, and the dispute path overrides it to 0 explicitly, so this is a
  positive choice in the code rather than a missing argument.
- Reachability: `resolveDispute` with `mode: 'resolve_with_credit'` is the documented
  user-choice resolution (header comment, `disputeService.ts:12-14`).

## RED test
`tests/integration/k056-dispute-credit-vat-split.int.test.ts` — 1 test, **1 failed**:
`expected 1150 to be close to 1000`. R1,150 invoice (R1,000 + R150 VAT) disputed in
full produces a credit note of subtotal 1,150 / VAT 0 / total 1,150. The test also
asserts `total_amount == 1150` so a fix that shrinks the note to R1,000 fails too.
Output: `red.log`.

## Proposed minimal fix
In `resolveDispute`, read `tax_rate` (or `tax_amount / subtotal`) from the disputed
invoice — it is already fetched two statements earlier for `client_id` — and derive
the net: `subtotal = round(disputed / (1 + rate/100), 2)`, `taxRate = rate`. Pass both
to `createCreditNote` so `subtotal + taxAmount` still equals the disputed gross.
Guard the zero-rated and exempt cases (`tax_rate = 0`) so they keep behaving as today.

## Historical-data impact
Every dispute resolved with credit has understated recoverable input/output VAT and
overstated the revenue reversal by the VAT portion. Read-only detector:

```sql
SELECT cn.company_id, count(*) AS notes, sum(cn.total_amount) AS gross
FROM credit_notes cn
JOIN customer_invoice_disputes d ON d.credit_note_id = cn.id
WHERE cn.tax_amount = 0 AND cn.total_amount > 0
GROUP BY cn.company_id;
```

## Risks
This is a VAT201 correction, not just a ledger one: restating the split changes
output VAT for the period the credit note was dated in. Do not reissue historical
credit notes without the person who files the returns. Also verify how credit notes
are posted to the GL before fixing — if the posting reads `subtotal` and `tax_amount`
separately, the fix moves both revenue and the VAT control account.
