# K-075 — OCR stripped the South African decimal comma

**Trigger.** `parseAmount` ran `str.replace(/[\s,]/g, '')` to remove thousands spaces, which
also deleted the decimal comma. South Africa prints `R1 150,00`, and the capture group at
`extractAmounts` admits spaces and commas, so the comma reached `parseAmount` and was dropped.

**Before.** `Total Due R1 150,00` parsed as `115000`; its `VAT @ 15% R150,00` as `15000`. A
100x amount then fed `buildExpenseJournalFromReceipt` and the capture screens.

**After.** The separator is decided before stripping: comma followed by exactly two digits at
the end, and no point anywhere, means the comma is the decimal point. Otherwise today's
behaviour stands, so `1,234.56` still parses as `1234.56`. Non-breaking space (U+00A0, what PDF
text layers emit) is stripped alongside the ordinary space, which master did not do. Same rule
as `bankCsvParserUtils.parseAmount`.

**Files.** `src/modules/accounting/services/core/ocrExtractionService.ts` (`parseAmount`).

**Tests.** `tests/unit/services/k075-ocr-comma-decimal.test.ts` — 7. Adjacent cases:
non-breaking-space thousands separator, a whole-rand amount with no decimal part, a label with
no number at all, and the derived subtotal (which runs on the parsed numbers, so a 100x total
made it wrong too). Mutation proof in `green.log`: reverting `parseAmount` to master takes 4 of
the 7 red.

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

**Limits.** `1,234` alone is genuinely ambiguous between conventions. The `,\d{2}$` rule is the
conservative reading and treats it as thousands, as master did.
