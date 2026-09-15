# K-075 — OCR strips the comma decimal separator

**Claim.** `replace(/[\s,]/g,'')` removes the South African decimal comma along with thousands
spaces, inflating amounts 100x. (`ocrExtractionService.ts:146`, audited at `5661d6f0`; file
unchanged on `origin/master`.)

**Disposition: confirmed.**

**Evidence (read).** `parseAmount` at
`origin/master:src/modules/accounting/services/core/ocrExtractionService.ts:146-150` strips both
characters before `parseFloat`. The capture group at `:156` is
`(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)`, which happily captures `1 150,00` — spaces and
commas are inside the class — so the comma reaches `parseAmount` and is deleted. South Africa
uses the comma as the decimal separator; till slips and many invoices print `R1 150,00`.

**Reachability.** `extractAmounts` is called by `ocrService.ts:125` in `extractFromText`, which
`extractFromPdf` falls back to whenever the VLM is unconfigured or returns nothing
(`ocrService.ts:52-72`). That reaches `pages/api/accounting/document-capture.ts`,
`pages/api/accounting/vlm-extract.ts` and `pages/api/accounting/bank-tx-attachments.ts`, and the
extracted `totalAmount` / `vatAmount` feed `buildExpenseJournalFromReceipt`.

**Evidence (executed).** `tests/unit/services/k075-ocr-comma-decimal.test.ts` — 3 tests,
**2 failed, 1 passed**. On `VAT @ 15% R150,00 / Total Due R1 150,00`:
`totalAmount` came back as `100000` (expected `1150`) and `vatAmount` as `15000`
(expected `150`). The passing test is the fix guard: `Total Due: 1,234.56` must stay `1234.56`.
Output: `red.log`.

**Proposed minimal fix.** In `parseAmount`, decide the separator before stripping: if the string
matches `/,\d{2}$/` and has no `.`, treat the comma as the decimal point
(`replace(/[\s.]/g,'').replace(',', '.')`); otherwise keep today's behaviour. Six lines in one
pure function, covered by the test above.

**Historical-data impact.** Any captured document whose source text used comma decimals and went
through the regex fallback carries a 100x amount. Read-only detection:

```sql
SELECT id, company_id, created_at, extracted_data->>'totalAmount' AS total
FROM captured_documents
WHERE company_id = $1
  AND extracted_data->>'extractionMethod' = 'regex'
  AND (extracted_data->>'totalAmount')::NUMERIC > 100000;
```

Verify the column and JSON key against the live table before running; not executed here.

**Risks.** Ambiguity is real: `1,234` alone could be either convention. The `,\d{2}$` rule is
the conservative reading and the passing US-format test pins it.
