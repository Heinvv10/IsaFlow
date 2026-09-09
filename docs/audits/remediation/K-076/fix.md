# K-076 — OCR total and VAT labels matched anywhere in the document

**Trigger.** The total patterns began `(?:Grand\s*)?Total` with no left boundary, so the
`total` inside `Subtotal` satisfied them, and `text.match` returns the FIRST occurrence. On a
normal invoice `Subtotal` prints above `Total Due`. Separately, the VAT pattern made every
separator optional, so `VAT: <number>` read a registration number as an amount.

**Before.** On `Subtotal: 1000.00 / VAT @ 15%: 150.00 / Total Due: 1150.00`, `totalAmount` came
back `1000` — the VAT-exclusive figure, silently. On `VAT: 4123456789`, `vatAmount` came back
`4123456789`.

**After.** Each total pattern is prefixed with `(?:^|[^A-Za-z])`, so a letter before `Total`
breaks the match. The single loose VAT pattern is split into three that each require a real
token before the digits — a rate (`@ 15%` or `(15%)`), a separator (`:` or `-`), or a currency
marker (`R`/`ZAR`) — and a match that is a bare 9-or-10-digit run with no decimal part is
rejected as a registration number and the loop continues to the next pattern.

Scope correction carried from validation: the commoner registration layouts (`VAT No:`,
`VAT Reg No:`, `VAT Registration Number`) never matched on master either, because the letters
after the optional `R` alternative break the pattern. Only the bare `VAT: <n>` and `VAT <n>`
forms were affected.

**Files.** `src/modules/accounting/services/core/ocrExtractionService.ts` (`extractAmounts`).

**Tests.** `tests/unit/services/k076-ocr-label-boundaries.test.ts` — 6. Adjacent cases: a
registration number printed ABOVE the real VAT line (the amount must still be found), the
currency form `VAT R 150,00`, `Total Excluding VAT` not read as the payable total, and a
document with only a Subtotal. Mutation proof in `green.log`: removing the left boundary takes
2 red, reverting the VAT patterns takes a different 2 red.

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
