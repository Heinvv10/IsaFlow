# K-072 — receipt-to-journal claimed input VAT on entertainment

**Trigger.** `buildExpenseJournalFromReceipt` emitted three legs unconditionally, one of them
`{ accountId: vatInputAccountId, debit: vatAmount }`. The receipt type it computes itself
(`parseReceiptType` → `'meals'` for restaurant merchants) was never consulted. VAT Act
s17(2)(a) denies input tax on entertainment.

**Before.** Spur receipt R1 150: expense 5600 debit 1 000, VAT Input 1140 debit 150, bank
credit 1 150. The 150 was an unclaimable input-tax deduction, posted unattended by both
callers under their confidence gates.

**After.** The builder runs the receipt type through `applyVatDenial` — the same s17(2)(a)
funnel the bank paths use, and the one place that funnel is allowed to coerce rather than warn,
because nobody is watching an auto-post. On `'meals'` the VAT leg goes to zero and the expense
leg carries `subtotal + vatAmount`. Both routes already drop zero-value legs, so the journal
reaches the ledger with two lines and no VAT-input line at all. The denial keys off the receipt
TYPE, not the account code: `travel` and telecoms map to 5600 too and their input tax is
claimable.

**The account marker, added in round 2.** The merchant regex is a heuristic and it does not know
Tashas, Marble or a corporate caterer; and on `post-expense` the account is chosen by a user or a
capture rule, not by the merchant map at all. Both routes now call `resolveVatCodeForAccount` on
the expense account they resolved, reading the `gl_accounts.vat_input_denied` marker that
migration 521 sets, and the builder ORs that with its heuristic. The authoritative input decides;
the heuristic only adds to it.

**Files.** `receiptToJournalService.ts`, `pages/api/accounting/receipt-to-journal.ts`,
`pages/api/accounting/capture/[id]/post-expense.ts` and
`src/modules/accounting/services/capture/pettyCashJournalService.ts`. The last is the anonymous
petty-cash branch, moved out of the route unchanged so the route returns to 214 lines and back
under the 300-line cap; the 26 existing route tests pass untouched across the move.

The lines carry `vatType`, and the two files that now DECIDE the claim — `receipt-to-journal.ts`
and `pettyCashJournalService.ts` — import and use the denial funnel, so
`check-vat-guard-coverage.ts` sees both as in-scope and guarded. `post-expense.ts` drops out of
scope because it no longer decides anything; it delegates. The gate file is untouched and still
lists 14 allowlisted paths — no exemption was added. Before this round, both routes returned
`null` from the inspector: unattended posters the gate could not see.

**Tests.** `tests/unit/services/k072-receipt-entertainment-vat.test.ts` (12) and
`tests/integration/k072-receipt-entertainment-vat.int.test.ts` (5, real Postgres). Adjacent
cases: a hotel sharing account 5600 keeps its claim, an unclassifiable merchant keeps its claim,
a merchant the regex does not know is denied on the account flag alone, an explicit
`accountVatDenied: false` does not resurrect a claim the merchant map denied, a meals receipt
whose VAT was derived rather than extracted is still denied, and another tenant's document
writes no journal. Mutation proof in `green.log`.

**Migration.** None. **Rollback.** Revert the commit.

**Historical impact.** Journals already posted by this path over-claim input VAT. Read-only
detection, not run here:

```sql
SELECT je.id, je.entry_date, je.description, jl.debit
FROM gl_journal_entries je
JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
WHERE je.company_id = $1
  AND je.source = 'auto_expense_receipt'
  AND ga.account_code = '1140' AND jl.debit > 0
  AND je.description ~* '(spur|nandos|steers|mcdonald|kfc|wimpy|ocean basket|mugg|uber ?eat|restaurant|cafe|coffee)';
```

Each hit needs a correcting journal and a VAT201 adjustment. The population is small: the
`auto_expense_receipt` source only became postable at migration 509.

**Declined findings from the blind review, both accepted by the team lead.**

*Negative and refund totals are not extracted (LOW-9).* Measured on this branch:
`extractAmounts('Total Due: -1150.00')` returns `{subtotal: null, vatAmount: null,
totalAmount: null}`, and `validateReceiptExtraction` then returns `valid: false,
errors: ['totalAmount is required']`, so the route answers 400 and writes nothing. Admitting the
minus sign would change that outcome to a journal, and `shouldAutoPostReceipt` would auto-post a
reversal nobody asked for. A credit note against the original expense needs its own path with its
own approval, not a sign admitted into a regex. Refusing the document is the safer failure and it
is the one in place.

*Telecoms map to the Meals & entertainment account (LOW-13).* `MERCHANT_PATTERNS` routes
`mtn|vodacom|telkom|cell c|rain|afrihost` to code 5600 with type `general`. The VAT treatment is
correct — `general` claims its input tax, which is right for telecoms — so this is not a VAT
defect and not what these three items cover. The account is wrong, and changing it moves where
live spend lands for every company on the platform. Flagged for its own item; the reviewer raised
it as "mentioned, not a fix request".

**Limits.** A restaurant that the regex does not know AND whose account carries no
`vat_input_denied` flag still claims. Setting the flag is a per-company act, so the marker only
helps a company that has set it; migration 521 sets it for the accounts it can identify by name.
The denial is also reported to the caller but not blocked — an operator sees the advice in
`warnings` and must recode the receipt themselves.

---

## Round 3 — disposition of the nine findings in `review-k072-r2.md`

Evidence: `green-round3.log` (75 unit + 10 real-DB, full suite 9 513 passed with the fixture
env unset, tsc/eslint/vat-gate/agent-docs clean, nine mutations each proved RED).

| # | Verdict | What changed |
|---|---|---|
| HIGH-1 | FIXED | `ocrAmountPatterns.ts` — `NOT_A_SUBTOTAL` is now `(?<![A-Za-z])(?<!Sub[\s-]*)`, variable-width, matching the grammar the file already uses. Pinned on two spaces, three spaces upper-case, tab, non-breaking space, hyphen-space and the joined spelling, plus a case proving a plain `Total` following a subtotal line still reads. |
| — | FIXED (found while fixing HIGH-1) | Treated as a pattern, not one regex, per the brief. `SUBTOTAL_PATTERNS[0]` was `Sub\s*[-\s]?Total` — NARROWER than the new guard, so `Sub - Total 1000.00` was refused as the total and then not read as the subtotal either: the figure was lost. Both now spell `Sub[\s-]*Total`, as does the line-item terminator in `ocrExtractionService`. Every other lookbehind/anchor in the file was re-read; `(?<![A-Za-z])` on the Amount/Balance form is genuinely fixed-width-correct and is unchanged. |
| MEDIUM-1 | FIXED | `post-expense.ts` — the `employeeId` branch resolves `resolveVatCodeForAccount` on the coded account BEFORE building the amounts. On a denial the claim line carries the gross on `amount`, `vatAmount = 0` and `vatCode = 'none'`, so `postClaim`'s `totalVat` is zero and no VAT-Input leg is created; the response returns `inputVatDenied` + `INPUT_VAT_DENIED_ADVICE`. Proved end-to-end against the real ledger, including that the claim HEADER totals 1150/0. |
| MEDIUM-2 | FIXED | The generic `Tax` form moved BELOW the bare `VAT` column, and `extractVatAmount` now prefers the unique candidate the document's own arithmetic endorses (`subtotal + c === total`) over the first printed. The hotel bill reads VAT 150, not the R12 levy. |
| MEDIUM-3 | FIXED | New `NOT_A_TOTAL_LABEL` — `(?<!(?:Ex|In)cl(?:uding)?\.?[\s-]*)` — on every VAT pattern. Measured while isolating it: on a layout with no recognisable subtotal (`Price Excl VAT 1000.00 / VAT 150.00 / Total Due 1150.00`) the un-guarded reader returned **VAT = 1000, subtotal = 150** — balanced at 1150, i.e. an R1 000 input claim on an R1 150 invoice. Worse than the reported case, and now pinned by its own test. |
| MEDIUM-4 | FIXED | `pettyCashJournalService` runs `validateJournalEntry` on the built lines before its first write and throws the exported `ReceiptDoesNotBalanceError`; the route maps it to 400. Safe as a 4xx only because nothing is written before it — the reads above are all SELECTs. Proved: 400, no journal, `capture_events.status` still `extracted` so a corrected extraction can retry. |
| LOW-1 | FIXED, with one correction to the finding | The denied legs now carry `vatType`, so a denial is a recorded classification. The VALUE is `'no_vat'`, not the `'none'` the finding proposed: `'none'` is the bank `vat_code` vocabulary and is not a member of `VatType`, which spells the same fact `'no_vat'`. The finding's premise that "every sibling poster writes the resolved code onto the base line" does not hold for a denial — `bankAllocationService.ts:182` maps `'none'` to `undefined` rather than writing the code through. Substance fixed, token corrected. No reporting change: `vatReturnService` box 18 requires `accountType: 'asset'` and `vatBoxBasis` only reads the field on tax-control subtypes. |
| LOW-2 | FIXED | `receipt-to-journal.ts` refuses a document already `'matched'` (400) before any write. The `status` column it always selected is finally read. |
| LOW-3 | FIXED | `AMOUNT` ends `(?![\d.,]*\d)`. A plain `(?!\d)` was NOT enough — the engine simply backtracks to `1150` and matches that — so the lookahead has to reject a digit anywhere in the trailing digit/separator run. `1150.000`, `1150.005` and `1150.0001` now fail to match and the caller's validation refuses the document; ordinary two-decimal, thousands and whole-rand forms are pinned unchanged. |
| LOW-4 | FIXED | The single-space line at `receipt-to-journal.ts:200` and the double blank line in `ocrExtractionService` removed. |

**Migration:** none. **Historical data:** unchanged by this round — see the impact SQL above; the
r2 defects mis-READ documents at capture time and left no marker distinguishing an affected
journal, so no read-only query can identify them retrospectively. Journals posted before this
round keep `vat_type` NULL on a denied expense leg (LOW-1 changes new postings only).

**Limits.** The grammar is still a regex fallback over OCR text, not a parser: a document whose
figures genuinely disagree is refused rather than corrected, and `VAT 15% 150.00` without an `@`
still yields no VAT amount (pre-existing, out of scope). The `Tax`-below-`VAT` ordering fixes the
ranking; a document printing ONLY a non-VAT levy under a `Tax` label is still read as VAT.
