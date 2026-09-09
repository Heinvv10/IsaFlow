# K-076 — OCR total and VAT labels matched anywhere in the document

**Trigger.** The total patterns began `(?:Grand\s*)?Total` with no left boundary, so the
`total` inside `Subtotal` satisfied them, and `text.match` returns the FIRST occurrence. On a
normal invoice `Subtotal` prints above `Total Due`. Separately, the VAT pattern made every
separator optional, so `VAT: <number>` read a registration number as an amount.

**Before.** On `Subtotal: 1000.00 / VAT @ 15%: 150.00 / Total Due: 1150.00`, `totalAmount` came
back `1000` — the VAT-exclusive figure, silently. On `VAT: 4123456789`, `vatAmount` came back
`4123456789`.

**After.** Each total pattern carries `(?<![A-Za-z])(?<!Sub[-\s])`. Round 2 replaced the first
attempt, `(?:^|[^A-Za-z])`, which only fixed the JOINED spelling: a space and a hyphen are both
non-letters, so `Sub Total` and `Sub-Total` still matched and still won on first occurrence. The
file's own subtotal patterns spell `Sub\s*[-\s]?Total`, which is how the codebase already knew
both forms occur.

The VAT label is split into forms that each require a real token before the digits — a rate, a
`:`/`-` separator, or a currency marker — plus a BARE COLUMN form last. That last one is not
optional: a till slip prints `VAT      0.00` with only whitespace between, and dropping it does
not merely lose the figure. `buildExpenseJournalFromReceipt` derives 15% whenever `vatAmount` is
null, so a document stating the VAT is ZERO produced an invented input-tax claim it explicitly
denies — the K-072 defect, arriving through the K-076 fix. Round 2 restored the form and pinned
it.

A candidate is rejected as a registration number by VALUE, not by digit count: the tax on a
document can never exceed the document's own total, and a registration number always does. The
earlier `^\d{9,10}$` was a shape test that one OCR digit escaped in either direction. Every
occurrence of a label form is now scanned, not just the first, so a registration number printed
above the real VAT line no longer consumes the pattern; and where several VAT lines are found,
they are summed ONLY if `subtotal + sum` equals the stated total, which stops a document printing
both a per-line and a total VAT from being doubled. A derived subtotal below zero is discarded.

Scope correction carried from validation: the commoner registration layouts (`VAT No:`,
`VAT Reg No:`, `VAT Registration Number`) never matched on master either, because the letters
after the optional `R` alternative break the pattern. Only the bare `VAT: <n>` and `VAT <n>`
forms were affected.

**Files.** `src/modules/accounting/services/core/ocrAmountPatterns.ts` (new — labels, amount
grammar and VAT candidate selection) and `ocrExtractionService.ts` (`extractAmounts`, now 269
lines, under the cap).

**Tests.** `tests/unit/services/k076-ocr-label-boundaries.test.ts` — 24. Adjacent cases: all four
Subtotal spellings, the SA-spaced `Sub Total 1 000,00`, a registration number printed above the
real VAT line, the currency form, `Total Excluding VAT`, a bare whitespace VAT column, a stated
VAT of zero, the rate not being read as the amount, 8/9/10/11-digit registration runs, a
whole-rand VAT smaller than the total, a bare registration number with no total to compare
against, a negative derived subtotal, and a split VAT summary both when the sum reconciles and
when it does not. Mutation proof in `green.log`.

**Migration.** None. **Rollback.** Revert the commit.

**Historical impact.** Same population as K-075 — regex-fallback captures. The signature of the
Subtotal mis-read is a `totalAmount` equal to the `subtotal` with a non-null `vatAmount`:

```sql
SELECT id, company_id, created_at,
       extracted_data->>'subtotal' AS subtotal,
       extracted_data->>'vatAmount' AS vat,
       extracted_data->>'totalAmount' AS total
FROM captured_documents
WHERE company_id = $1
  AND extracted_data->>'extractionMethod' = 'regex'
  AND extracted_data->>'vatAmount' IS NOT NULL
  AND (extracted_data->>'totalAmount')::NUMERIC = (extracted_data->>'subtotal')::NUMERIC;
```

Those understate the expense. Posting one is largely blocked: the route's balance pre-check
answers 400 when subtotal + VAT disagrees with the total.

**Limits.** A document that prints only `Subtotal` and no total line now extracts no total at
all, where before it got a wrong one. That is the safer failure and it surfaces through
`computeConfidence` — but it is a behaviour change, deliberately taken.

A negative or refund total still extracts nothing, and `validateReceiptExtraction` then rejects
the document with a 400. Admitting the minus sign would let the auto-post branch write an
unattended reversal; a credit note needs its own path. See `review-round-2.md`.
