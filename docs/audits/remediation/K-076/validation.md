# K-076 — OCR total and VAT regexes match anywhere in the document

**Claim.** The total pattern has no left word boundary so `Subtotal` matches, and the VAT
pattern matches a VAT registration number. (`ocrExtractionService.ts:156`, audited at
`5661d6f0`; file unchanged on `origin/master`.)

**Disposition: confirmed** on the total half; **confirmed with a narrower trigger** on the VAT
half.

**Evidence (read).** `origin/master:src/modules/accounting/services/core/ocrExtractionService.ts:156`
begins `(?:Grand\s*)?Total` with no `\b`, so the `total` inside `Subtotal` satisfies it, and
`text.match` (`:161`) returns the FIRST occurrence in the document. On a normal invoice
`Subtotal` is printed above `Total Due`, so `totalAmount` silently becomes the VAT-exclusive
figure. The VAT pattern at `:166` makes every separator optional, so `VAT: <number>` reads the
number as an amount.

**Evidence (executed).** `tests/unit/services/k076-ocr-label-boundaries.test.ts` — 2 tests,
**2 failed**. On `Subtotal: 1000.00 / VAT @ 15%: 150.00 / Total Due: 1150.00`, `totalAmount`
came back `1000` (expected `1150`) — the matched text was `total: 1000.00`, taken from inside
`Subtotal`. On `VAT: 4123456789 / Total 1150.00`, `vatAmount` came back `4123456789`.
Output: `red.log`.

**Correction to the VAT half.** A direct regex probe over nine label forms shows the commoner
registration layouts do NOT match: `VAT No 4123456789`, `VAT No: 4123456789`,
`VAT Reg No: 4123456789` and `VAT Registration Number 4123456789` all fail, because the letters
after the optional `R` alternative break the pattern. Only the bare `VAT: <number>` and
`VAT <number>` forms are affected. The claim is right about the class and overstated about the
common case.

**Reachability.** Same chain as K-075: `ocrService.ts:125` → `extractFromText`, the regex
fallback used whenever the VLM is unavailable or empty (`ocrService.ts:52-72`), feeding
document-capture, vlm-extract and bank-tx-attachments.

**Proposed minimal fix.** Anchor the labels. Prefix the total patterns with `(?:^|[^A-Za-z])`
(or `\b(?<!Sub)`) so `Subtotal` cannot satisfy them, and require a real separator or currency
token before the VAT digits — `VAT\s*(?:@\s*\d+%?)?\s*(?:[:-]\s*)?(?:ZAR|R)\s*` for the
currency form, and reject a bare 9-to-10-digit integer with no decimal part as a VAT amount.

**Historical-data impact.** Same population as K-075 — regex-fallback captures. A
`totalAmount` equal to `subtotal` with a non-null `vatAmount` is the signature of the Subtotal
mis-read; those documents understate the expense and, where posted, unbalance
`subtotal + vat != total`. `pages/api/accounting/receipt-to-journal.ts:132` rejects the
unbalanced ones with a 400, so the posted population is smaller than the extracted one.

**Risks.** Tightening the left boundary could stop matching a document that prints only
`Subtotal` and no total line. Today such a document gets a wrong total; after the fix it gets
none, which is the safer failure and surfaces in `computeConfidence`.
