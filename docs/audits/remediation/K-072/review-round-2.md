# Blind-review round 2 — dispositions for all 13 findings

Review of 44d6a34e. Every finding below was reproduced before it was fixed, and each fix was
mutation-proved by reverting it and watching a named test go red. Mutation log in `green.log`.

| # | Sev | Disposition |
|---|-----|-------------|
| 1 | HIGH | FIXED — lookbehind boundary; `Sub Total` / `Sub-Total` / `SUB TOTAL` pinned |
| 2 | HIGH | FIXED — bare VAT column form restored; a stated VAT of 0 no longer derives 15% |
| 3 | MED | FIXED — both routes resolve `gl_accounts.vat_input_denied` and OR it into the builder |
| 4 | MED | FIXED — VAT candidates rejected by value, not digit count; no negative derived subtotal |
| 5 | MED | FIXED — lines tagged `vatType`; both routes now in the gate's scope AND guarded, no allowlist entry |
| 6 | LOW | FIXED — grammar moved to `ocrAmountPatterns.ts`; 269 lines, under the cap |
| 7 | LOW | FIXED — decimal separator anchored, in the OCR parser and in `bankCsvParserUtils` |
| 8 | LOW | FIXED — European `1.234,56` reads 1234.56; separator decided by the last one seen |
| 9 | LOW | NOT FIXED — deliberate, see below |
| 10 | LOW | FIXED — split VAT summary summed, but only where the arithmetic proves the sum |
| 11 | LOW | FIXED — integration fixtures purged in `beforeAll` as well as `afterAll` |
| 12 | LOW | FIXED — `inputVatDenied` returned and surfaced in both routes' `warnings` |
| 13 | LOW | NOT FIXED — reviewer marked it "not a fix request"; see below |

## LOW-9 — negative and refund totals extract nothing. Not fixed, and fixing it as described
would be worse.

Measured on this branch: `extractAmounts('Total Due: -1150.00')` returns
`{subtotal: null, vatAmount: null, totalAmount: null}`, and `validateReceiptExtraction` then
returns `valid: false, errors: ['totalAmount is required']`, so `receipt-to-journal.ts` answers
400. The document is refused loudly and nothing is written.

Admitting the minus sign changes that outcome to a journal. `shouldAutoPostReceipt` would then
auto-post a receipt whose expense leg is negative and whose bank leg is a debit — a reversal
nobody asked for, written unattended. A credit note against the original expense is the correct
treatment and it needs a designed path with its own approval, not a sign admitted into a regex.
Refusing the document is the safer of the two failures, and it is the one in place.

## LOW-13 — telecoms map to the Meals & entertainment account. Not fixed.

The reviewer wrote "Mentioned, not a fix request." `MERCHANT_PATTERNS` routes
`mtn|vodacom|telkom|cell c|rain|afrihost` to code 5600 with type `general`. The VAT treatment is
right, which is what these three audit items are about; the account is wrong, which is a chart-of-
accounts change that moves where live spend lands for every company on the platform. Out of scope
here and flagged for its own item.

## Noted while fixing MEDIUM-5, not a finding on this branch

The CI gate treats a file as guarded when it imports and uses ANY binding from a guard module.
An earlier mutation removed only `resolveVatCodeForAccount` from `receipt-to-journal.ts` and the
gate still passed, because the route also imports the `INPUT_VAT_DENIED_ADVICE` string. So a file
can satisfy the gate by importing a message constant while deciding a claim on its own. The
mutation recorded in `green.log` removes every binding, which is what makes it a real proof.
Tightening the gate to require a FUNCTION binding would touch every file it currently governs
and belongs in its own change.

## Pre-existing, made larger, not resolved

`pages/api/accounting/capture/[id]/post-expense.ts` was already 309 lines on `31fc2f10`, over the
300-line cap, and this branch takes it to 329. Getting it under the cap means extracting the
anonymous petty-cash branch into a service — a refactor of a live posting path, which is not
something to attach to an audit fix. Stated rather than done.
