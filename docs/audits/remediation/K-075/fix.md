# K-075 — OCR stripped the South African decimal comma

**Trigger.** `parseAmount` ran `str.replace(/[\s,]/g, '')` to remove thousands spaces, which
also deleted the decimal comma. South Africa prints `R1 150,00`, and the capture group at
`extractAmounts` admits spaces and commas, so the comma reached `parseAmount` and was dropped.

**Before.** `Total Due R1 150,00` parsed as `115000`; its `VAT @ 15% R150,00` as `15000`. A
100x amount then fed `buildExpenseJournalFromReceipt` and the capture screens.

**After.** The separator is decided by the LAST one in the string: followed by one or two digits
to the end it is the decimal point, anything else is a thousands separator. One rule covers
`1 150,00`, `1,234.56`, `1.234,56`, `1,234` and `1150.5` with no locale switch. Non-breaking
space (U+00A0, what PDF text layers emit) is stripped alongside the ordinary space, which master
did not do.

Round 2 replaced an earlier `.replace(',', '.')`, which is NON-GLOBAL: on `1,234,56` only the
first comma became a point and `parseFloat` stopped at `1.23`, a thousandfold under-read.
`bankCsvParserUtils.parseAmount` carried the identical line and is fixed the same way, since a
bank statement row is imported without anyone re-reading the figure.

**Files.** `src/modules/accounting/services/core/ocrAmountPatterns.ts` (new — the grammar, split
out so `ocrExtractionService.ts` stays under the 300-line cap) and
`src/modules/accounting/utils/bankCsvParserUtils.ts`.

**Tests.** `tests/unit/services/k075-ocr-comma-decimal.test.ts` (13) and
`tests/unit/services/k075-bank-csv-comma-decimal.test.ts` (6). Adjacent cases: non-breaking-space
thousands, a whole-rand amount, a label with no number, the derived subtotal, comma thousands with
a comma decimal, the European point-thousands form, a single-digit decimal part, and a capture
that must not run across a line break into the next figure. Mutation proof in `green.log`.

**Migration.** None. **Rollback.** Revert the commit.

**Historical impact.** Documents captured through the regex fallback with comma decimals carry a
100x amount. Read-only detection, not run here — verify the JSON keys against the live table
first:

```sql
SELECT id, company_id, created_at, extracted_data->>'totalAmount' AS total
FROM captured_documents
WHERE company_id = $1
  AND extracted_data->>'extractionMethod' = 'regex'
  AND (extracted_data->>'totalAmount')::NUMERIC > 100000;
```

Only the regex fallback is affected; the VLM path parses its own numbers. Where such a document
was posted, `receipt-to-journal.ts` rejects it when subtotal + VAT disagrees with the total, so
the posted population is smaller than the extracted one.

**Limits.** `1,234` alone is genuinely ambiguous between conventions. The last-separator rule
treats it as thousands, which is the conservative reading and what master did. An amount printed
with three decimal places is read as thousands for the same reason.

## Round 3

The amount/label grammar was hardened again after the second blind review — see
`docs/audits/remediation/K-072/fix.md` for the disposition of all nine findings and
`K-072/green-round3.log` for the evidence. Touching this item: the subtotal and VAT label
guards are now variable-width (`Sub[\s-]*Total`, `(?<!(?:Ex|In)cl(?:uding)?\.?[\s-]*)`), the
generic `Tax` form ranks below the bare `VAT` column, VAT candidates are chosen by the
document's own arithmetic where it decides, and `AMOUNT` refuses to half-read a malformed
figure such as `1150.005`.
