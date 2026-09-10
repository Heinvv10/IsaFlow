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

---

## Round 4 — disposition of the eight findings in `review-k072-r3.md`

Both HIGHs were the SAME defect class as round 3's, surviving under different labels. Round 3
fixed `Sub Total` by making one guard and one pattern spell the same thing; every OTHER label
meaning "this is not the amount payable" kept its own spelling. So this round replaces the
hand-spelled regexes with a **label vocabulary**: `SEP`, `EXCL`, `INCL`, `VAT_WORD`, `TAX_WORD`,
`NET_LABEL`, `NET_PREFIX` in `ocrAmountPatterns.ts`, from which both guards, all three pattern
lists and the line-item terminator (`SUMMARY_LINE_START`, now imported by
`ocrExtractionService`) are built. Adding a spelling is one alternative plus one row in
`k076-ocr-label-vocabulary.test.ts`, not a new regex.

| # | Verdict | What changed |
|---|---|---|
| H-1 | FIXED | `Ex VAT` / `Ex. VAT` / `ExVAT` / `Exc VAT`. `NOT_A_TAX_LABEL` is now `(?<![A-Za-z])(?<!\b(?:Ex\|In)(?:c(?:l(?:uding)?)?)?\.?[\s-]*)` — every abbreviation of both markers, with and without the full stop. The inner `\b` is load-bearing: without it `Index VAT 150.00` loses the tax because the word merely ENDS in `ex`. Pinned both ways (`Price Ex VAT` is the net; `Index VAT` is the tax). |
| H-2 | FIXED | `Nett Total` / `Net Total` / `Nett Amount` / `Net Value` / bare `Nett`. `NOT_A_SUBTOTAL` is now `(?<![A-Za-z])(?<!\b(?:Sub\|Nett?\|S[./])${SEP})` and `NET_LABEL` reads exactly the same set, so guard and pattern cannot drift. The terminator shares the vocabulary too — a `Nett Total` summary line printed in a column was collected as a line item. |
| M-1 | FIXED | `SEP` is `[\s._/-]*` in BOTH the guard and the pattern, covering `Sub.Total`, `Sub_Total`, `Sub/Total`; `S/Total` and `S.Total` are their own alternative (`S[./]`, never a bare `S`, which would refuse `Sales Total` — pinned). |
| M-2 | FIXED | `captureRowLock.ts` — `SELECT … FOR UPDATE` with `SET LOCAL lock_timeout = '5s'`, taken before the status check on `captured_documents` (receipt-to-journal) and on `capture_events` (post-expense), same shape as `bankTxLock.ts`. The event row only, not the joined document: locking both would take the two rows in opposite orders on the two routes. Proved by two CONCURRENT posts on the real database — one 200, one 400, one journal, bank credit R1 150. Without the lock both return 200 (mutation recorded in `green-round4.log`). |
| M-3 | FIXED (both halves) | `deniedVatTypeForLine` (`claimVatAdvice.ts`) tags a denied claim's expense leg `vat_type = 'no_vat'`; observed in real `gl_journal_lines`. Only the denial is mapped — tagging a claim's expense leg `'standard'` would declare the supply on a leg no VAT201 box reads, which is a different change. `claimInputVatWarnings` surfaces `INPUT_VAT_DENIED_ADVICE` on `PATCH .../lines/[lineId]` and on `approve`; its predicate is the AMOUNT as well as the code, because `postClaim` sums `vatAmount` regardless of `vat_code`. |
| L-1 | FIXED | Both routes now `throw` anything that is not a `MissingSystemAccountError` instead of reporting it as "default accounts not configured", and log the refusal they do answer. The petty-cash branch's unwrapped `getSystemAccountId('bank')` is mapped to the same 400 rather than a 500, so the two paths agree. Covered: an actually-empty role still answers 400 and writes nothing. NOT covered by a test: the rethrow of a transient database fault — it needs an injected fault the fixture cannot produce, so it rests on the `instanceof` narrowing alone. |
| L-2 | FIXED | `ocrAmountReconciliation.reconcileNetAgainstTotal`. A levy under a printed subtotal no longer refuses the document: where the printed net contradicts `total − VAT`, the derived net wins IF the derived split looks standard-rated (13–17%), and the discrepancy is reported through `ExtractedAmounts.warnings` into the capture screen's warnings. Deliberately NOT unconditional: a mis-read tax line (VAT 12.00 on R1 150 → 1.1%) fails the same reconciliation, and silently rebasing on it would post a wrong claim instead of refusing. Both directions pinned. |
| L-3 | FIXED | `Total Inc VAT` reads 1150. `TOTAL_PATTERNS[2]` is built from `INCL`, the same alternation the guard refuses, and admits `Total\|Amount\|Price\|Value` in front of it. |

**Files.** `ocrAmountPatterns.ts`, `ocrAmountReconciliation.ts` (new), `ocrExtractionService.ts`,
`ocrService.ts`, `captureRowLock.ts` (new), `claimVatAdvice.ts` (new), `expenseClaimService.ts`,
`receipt-to-journal.ts`, `capture/[id]/post-expense.ts`, `expense-claims/[id]/approve.ts`,
`expense-claims/[id]/lines/[lineId].ts`. Every new/changed file is under the 300-line cap;
`expenseClaimService.ts` was already 532 lines before this round and grew by 5.

**Tests.** Unit: `k076-ocr-label-vocabulary.test.ts` (new, 60 — the vocabulary table),
`k076-ocr-subtotal-reconciliation.test.ts` (new, 18), `k076-ocr-label-boundaries.test.ts` (43).
Real DB: `k072-capture-double-post.int.test.ts` (new, 4 — including the concurrency proof),
`k072-claim-vat-classification.int.test.ts` (new, 4). Nine mutations proved RED
(`green-round4.log`). Two pre-existing mocked route tests were adapted, not weakened: they stub
`@/lib/als` so the new lock can take its client, and one now asserts BOTH `capture_events`
statements are tenant-scoped rather than the first one found.

**Migration.** None. **Rollback.** Revert the commit.

**Historical data.** Unchanged. The label defects mis-READ documents at capture time and leave no
marker, so no read-only query can identify affected journals retrospectively — the impact SQL
above is still the only detection available. A double-posted receipt IS detectable:

```sql
SELECT source_document_id, COUNT(*) AS journals
FROM gl_journal_entries
WHERE company_id = $1 AND source = 'auto_expense_receipt' AND source_document_id IS NOT NULL
GROUP BY source_document_id HAVING COUNT(*) > 1;
```

**Limits.** Still a regex over OCR text, not a parser. A document printing ONLY a non-VAT levy
under a `Tax` label is still read as VAT. `VAT INCLUDED @ 15% 150.00` (words between the label and
the rate) still yields no VAT figure and falls back to the derived 15%, which is correct for a
VAT-inclusive slip; admitting `VAT Inclusive` as a tax label would mis-read
`TOTAL (VAT INCL) 1150.00` as R1 150 of tax, so it stays out.
(Superseded in round 5: the cross-route double post is closed, and `TOTAL (VAT INCL) 1150.00`
now yields its total. See below.)

---

## Round 5 — the ten findings of `review-k072-r4.md`

**HIGH-1 `VAT Amount 0.00` invented an input-tax claim — FIXED.** `Tax` admitted an optional
noun after it and `VAT` did not, so `VAT Amount 0.00` returned `vatAmount: null`, which makes
`buildExpenseJournalFromReceipt` discard the printed subtotal and derive 15% of the total —
R130.43 claimed against SARS on a slip that prints the VAT as zero. One vocabulary entry,
`TAX_NOUN` (`Amount|Total|Value`), now feeds every VAT form and the `Tax` form.

**HIGH-2 the cross-route double post — FIXED, and the reviewer is right on both counts.**
It was not a race: `post-expense` never read `captured_documents.status`, so
receipt-to-journal → capture inbox wrote two VAT-bearing journals in sequence. And there was no
lock-order cycle to justify not locking the document on both routes — nothing took the event
first. Every posting route now (a) locks the document, then the event
(`lockCaptureEventForPosting`), (b) refuses on `captured_documents.status = 'matched'`, and
(c) CLAIMS the document with a status-predicated `UPDATE … WHERE status <> 'matched' RETURNING id`
placed after its last read-only step and before its first ledger write, answering 400 when it
matches no row. Proved by outcome on the real database in both orders and concurrently. The
mutation is the interesting one: deleting BOTH read guards leaves the tests green — the claim is
what closes it — and deleting the claim's predicate as well brings the double post back (5 of 7
RED).

**MEDIUM-1 `VAT Total 150.00` read as the payable total — FIXED.** `NOT_A_SUBTOTAL` refused a
`Total` preceded by a net word but not one preceded by a tax word; it now spells both.

**MEDIUM-2 the rebase discarded a checksum on unattended paths — FIXED.** Both reconciliation
wordings are now built from one exported prefix, `UNRECONCILED_WARNING`, and
`shouldAutoPostReceipt` takes the warnings and returns false when any of them starts with it.
The rebase stays for the attended path, where the warning is rendered; the unattended path
refuses what the reader could not settle. Both call sites pass `extracted.warnings`.

**MEDIUM-3 the approver advice reached no screen — FIXED.** `pages/accounting/expenses/[id].tsx`
now keeps `json.data.warnings` from the approve/reject transition and renders it as a banner.
There is no UI consumer of `PATCH …/lines/[lineId]` anywhere in the app, so that half of the
finding has no screen to fix. The advisory-by-design point stands: an approver may still restore
the VAT, and now they are told first.

**MEDIUM-4 `TOTAL (VAT INCL) 1150.00` yielded no total — FIXED.** `TOTAL_PATTERNS[0]` admits an
optional parenthesised qualifier after the total word.

**LOW-1 the line-item terminator — FIXED.** `SUMMARY_LINE_START` now carries `NET_PREFIX` in
front of the exclusive marker, so `Amount Excl VAT 1000.00` is no longer collected as an item.

**LOW-2 teardown exceeded the hook budget — FIXED.** All four K-072 integration files carry an
explicit `afterAll(fn, 60_000)`. Measured: the `K072%` company count is unchanged across a full
run, so the teardown completes.

**LOW-3 `deniedVatTypeForLine`'s doc-comment overclaimed — FIXED (comment).** The tag asserts what
the predicate can see — this line claims no input tax — and the comment now says so; the denial
itself is recoverable only from the `gl_accounts.vat_input_denied` join. The classification is
unchanged.

**LOW-4 the L-1 rethrow was untested — COVERED.** Two unit tests per route: a fault raised while
resolving the VAT Input role propagates (no journal created), and a genuinely unmapped role still
answers 400. Mutation-proved.

**Round-5 files.** `ocrAmountPatterns.ts`, `ocrAmountReconciliation.ts`, `receiptToJournalService.ts`,
`captureRowLock.ts`, `pettyCashJournalService.ts`, `claimVatAdvice.ts`,
`capture/[id]/post-expense.ts` (293 lines), `receipt-to-journal.ts`, `expenses/[id].tsx`
(444 lines — 431 before this round), `services/capture/.claude.md` (+ mirror).

**Round-5 tests.** Unit: `k076-ocr-label-vocabulary.test.ts` (95), `k076-ocr-subtotal-reconciliation.test.ts`
(25), `postExpenseZeroVatLine.test.ts` (9), `receiptZeroVatLine.test.ts` (9),
`expenseClaimVatAdvice.test.tsx` (new, 2). Real DB: `k072-capture-double-post.int.test.ts` (7,
three of them the cross-route cases). Full unit suite 9637 passed with the fixture env unset;
component suite 418 passed. Nine mutations RED — `green-round5.log`.

**Round-5 migration.** None.

**Round-5 historical data.** The double-post query above is unchanged and is still the detection
for receipts posted twice. Documents mis-read by the label defects carry no marker; the closest
read-only probe is the rawText the extraction stored:

```sql
SELECT cd.id, cd.company_id, cd.extracted_data->>'vatAmount' AS vat_read
FROM captured_documents cd
WHERE cd.company_id = $1
  AND cd.extracted_data->>'rawText' ~* '(VAT|V\.A\.T\.)[ ._/-]*(Amount|Total|Value)'
  AND cd.extracted_data->>'vatAmount' IS NULL;
```

Rows it returns had their VAT derived at 15% of the total rather than read; where the document
printed zero, the derived figure is an input-tax claim that must be reversed.

**Round-5 limits.** `captured_documents.status = 'matched'` is also what
`captureBankTxAttachService` and `evidenceAttachmentService` stamp, so a document already attached
to a bank transaction as evidence is now refused by both posting routes. That is deliberate — it
has been accounted for — but it is a behaviour change beyond the double-post itself. The claim
predicate keys on that one status value; a future status that also means "settled" has to be added
to it.

---

## Round 6 — the fence stops being a lifecycle column

**Trigger.** `review-k072-r5.md`: 3 HIGH, 2 MEDIUM, 2 LOW. The reviewer's root-cause reading is
correct and is what this round implements — `captured_documents.status` was one column meaning
four things to four subsystems, and every leak followed from using it as the posting fence.

**Before → after.**

| # | Before | After |
|---|---|---|
| HIGH-1 | `capture/[id]/post.ts` — the only posting button in the product — read no document state. receipt-to-journal then inbox-post gave a posted journal AND an auto-approved supplier invoice with `tax_amount` 150.00 on one R1 150 receipt: R300 of input tax from R150 of VAT. | Locks both rows (`lockCaptureEventForPosting`), refuses on the claim, and claims the document immediately before the `supplier_invoices` INSERT — after the duplicate-blocked 409 branch, which has already written. |
| HIGH-2 | `document-capture-action` `'confirm'` reset `status` unconditionally: post → confirm → post = 2 journals, R2 300 bank credit, in three UI clicks. | The fence is `posted_at`, which no lifecycle action writes. `confirm` and `reject` both carry `AND posted_at IS NULL` and answer 400 naming the reason; a posted document cannot be edited or un-posted by a button. |
| HIGH-3 | `status <> 'matched'` admitted `'rejected'`; a rejected receipt posted. | `claimCapturedDocumentForPosting` claims `WHERE posted_at IS NULL AND status <> 'rejected'`, and `refusalForPosting` is the matching read guard used by all three routes. |
| MEDIUM-1 | A document merely ATTACHED to a bank transaction was refused with "Document already posted to a journal" while zero journals existed, undoable only via HIGH-2's button. | Attach writes `status`, not `posted_at`, so attach-then-post works. Refusals now say either "Document already posted" or "Document was rejected — reopen it before posting". The reviewer's correction is confirmed: `evidenceAttachmentService` stamps `bank_transactions.status`, never the document's. |
| MEDIUM-2 | `pages/accounting/expenses/[id].tsx` 444 lines (cap 300); the branch added 13. | Toast, VAT advice, rejection banner and summary tiles lifted into `src/components/accounting/expense/ClaimHeaderBanners.tsx`. Page is 420 — below the 431 it was BEFORE this branch, still over the cap. Getting under 300 means extracting the line-editing forms, which is a refactor this defect does not justify. |
| LOW-1 | `ocrAmountPatterns.ts` 305 lines. | `AMOUNT`, `parseAmount`, `hasDecimalPart`, `isPlausibleVatAmount` moved to `ocrAmountParsing.ts` (79). Patterns file is 247; the split is number-spelling vs label-spelling. |
| LOW-2 | `claimInputVatWarnings` runs on PATCH and DELETE of a route no `.tsx` consumes. | **Kept, deliberately.** Removing it from DELETE means answering `warnings: []`, and the lines that REMAIN can still carry a denied claim — a client would clear a warning that is still true. One indexed query is the cheaper of the two mistakes; the reasoning is now a comment on the branch. |

**Files.** `scripts/migrations/sql/672_capture_posting_claim_fence.sql` (new);
`captureRowLock.ts`; `pettyCashJournalService.ts`; `receipt-to-journal.ts`;
`capture/[id]/post.ts`; `capture/[id]/post-expense.ts`; `document-capture-action.ts`;
`expense-claims/[id]/lines/[lineId].ts`; `expenses/[id].tsx`; `ClaimHeaderBanners.tsx` (new);
`ocrAmountParsing.ts` (new); `ocrAmountPatterns.ts`; `ocrExtractionService.ts`;
`check-vat-guard-coverage.ts`; capture `.claude.md` + `AGENTS.md`.

**Round-6 tests.** Real DB: `k072-capture-posting-fence.int.test.ts` (new, 9) — each HIGH driven as
a UI-shaped sequence asserting journals, bank credit, supplier invoices and total input tax, plus
attach-then-post, cross-tenant, and a direct INSERT proving the unique index. Unit:
`k072-posting-fence-refusal.test.ts` (new, 11). Existing k072 integration 21/21 and full unit suite
9648 passed with the fixture env unset. Four mutations RED — `green-round6.log`.

**Round-6 migration.** 672. Adds `captured_documents.posted_at` + `idx_captured_documents_unposted`,
backfills it for documents that already produced a journal, a supplier invoice or a
`matched_invoice_id`, and creates `uq_gl_je_capture_source_document` — a partial UNIQUE index on
`gl_journal_entries(company_id, source_document_id) WHERE source = 'auto_expense_receipt'`. Scoped
to that source on purpose: the evidence-attach paths stamp `source_document_id` onto an existing
provisional bank journal, and an unscoped index would 23505 a legitimate attach. Rollback: `DROP
INDEX uq_gl_je_capture_source_document, idx_captured_documents_unposted; ALTER TABLE
captured_documents DROP COLUMN posted_at;` — the three routes then refuse nothing again, so roll the
code back with it.

**Round-6 historical data.** The index is created only when no duplicate pair exists; otherwise the
migration RAISEs a WARNING, skips it and still exits 0, so it cannot abort a deploy. Production has
not been queried. Run this read-only first — every row is one receipt whose input tax reached the
VAT201 twice:

```sql
SELECT company_id, source_document_id, COUNT(*) AS journals, MIN(entry_number), MAX(entry_number)
FROM gl_journal_entries
WHERE source_document_id IS NOT NULL AND source = 'auto_expense_receipt'
GROUP BY company_id, source_document_id
HAVING COUNT(*) > 1;
```

And the HIGH-1 shape, which produces no duplicate journal at all — one journal plus one invoice:

```sql
SELECT je.company_id, je.source_document_id, je.entry_number, si.invoice_number, si.tax_amount
FROM gl_journal_entries je
JOIN supplier_invoices si
  ON si.source_document_id = je.source_document_id AND si.company_id = je.company_id
WHERE je.source = 'auto_expense_receipt' AND je.source_document_id IS NOT NULL;
```

## Round 7 — the fourth route, the census, and the way out

### HIGH-1 — `ai-invoice-pipeline` was a FOURTH posting route with no claim

FIXED. It read `captured_documents.status` and nothing else: no `FOR UPDATE`, no `posted_at`, no
claim. `receipt-to-journal` then this endpoint on one R1 150 receipt gives a posted GL journal
claiming R150 of input tax AND an auto-approved supplier invoice carrying `tax_amount` 150.00 —
R300 in front of the VAT201 from a slip that says R150. It now locks the document, refuses on
`refusalForPosting`, and claims immediately before the `supplier_invoices` INSERT, after the
duplicate-blocked branch (which has already written and answers 409). Proved in
`tests/integration/k072-capture-fourth-route.int.test.ts`.

**The sentence at fix.md:341 was false and is retracted.** It said "only the application claim
stops a second invoice there". That route had no claim at all — the sentence described a defence
that did not exist on the path it named. The table below replaces it.

### The census — every writer that can put a captured document into the ledger

Enumerated from the WRITERS of `gl_journal_entries` / `supplier_invoices` carrying a
`source_document_id`, not by grepping for the fence. `journalEntryCrudService` is the only INSERT
into `gl_journal_entries`, so its callers are the complete journal set; `INSERT INTO
supplier_invoices` has six sites, of which two stamp `source_document_id`.

| # | Writer | Row it creates | `source` | Claims? | Index reach |
|---|---|---|---|---|---|
| 1 | `receipt-to-journal.ts` | `gl_journal_entries` | `auto_expense_receipt` | YES | covered by `uq_gl_je_capture_source_document` |
| 2 | `capture/[id]/post-expense.ts` → `pettyCashJournalService` | `gl_journal_entries` | `auto_expense_receipt` | YES | covered |
| 3 | `capture/[id]/post-expense.ts` → `expenseClaimService` | `expense_claim_lines`, later a JE | `auto_expense_claim` | YES | n/a — the claim JE header carries **no** `source_document_id` (a claim has many source docs), so it can never collide |
| 4 | `capture/[id]/post.ts` | `supplier_invoices` | n/a | YES | **NOT covered** — different table |
| 5 | `ai-invoice-pipeline.ts` | `supplier_invoices` | n/a | **NO → now YES** | **NOT covered** — different table |

Not posting events, and deliberately outside the fence:

| Writer | What it does | Why it is not a posting |
|---|---|---|
| `evidenceAttachmentService`, `provisional/[jeId]/attach.ts` | UPDATEs `source_document_id` onto an existing provisional bank journal | attaches evidence; creates no ledger row. An unscoped unique index would 23505 these — which is why the index is scoped to `source = 'auto_expense_receipt'` |
| `bankAllocationService.ts:369` | copies an invoice's `source_document_id` onto an allocation journal | lineage stamp under a different `source` |
| `ar/disputes/index.ts` → `disputeService` | writes `ar_disputes.source_document_id` | not a ledger table |
| `writeOffService`, `migrationApService`, `creditNoteApproveService`, `adjustmentService`, `batchPaymentService`, `vatAdjustmentService`, `migrationImportService` | each carries an explicit `// No sourceDocumentId` comment | the column stays NULL |

**Does the index cover route 5's `source`?** No — and not because of a `source` mismatch. Routes 4
and 5 write `supplier_invoices`; `uq_gl_je_capture_source_document` is a unique index on
`gl_journal_entries`. It cannot reach either of them at any `source` value. On those two paths the
application claim is the whole fence, and `captureRowLock.ts` now says so in its header instead of
implying the index covers every route.

### HIGH-2 — the "single vocabulary" had two members spelling their own parts

FIXED. `NET_LABEL` carried a hardcoded `S[./]` while `SEP` is `[\s._/-]*`, so `S-Total`, `S_Total`
and `S Total` were refused by neither guard nor pattern: measured, `S-Total 1000.00 / VAT 150.00 /
Total Due 1150.00` came back total=1000, subtotal=850, vat=150 — balanced, inside the auto-post
gate, bank credited R150 short. `NOT_A_TAX_LABEL` carried a hardcoded `[\s-]*`, so `Total Excl_VAT
1000.00 / Total Due 1150.00` measured vat=1000: an R1 000 input-tax claim on an R1 150 invoice.

Every member was then audited and rebuilt from the shared parts:

| Member | Was | Now |
|---|---|---|
| `NET_LABEL` | `S[./]${SEP}Total` | `S${SEP}Total` |
| `NOT_A_SUBTOTAL` | `(?:Sub\|Nett?\|S[./]\|TAX)${SEP}` | `(?:Sub\|Nett?\|S\|TAX)${SEP}` |
| `NOT_A_TAX_LABEL` | `(?:EXCL\|INCL)[\s-]*` | `(?:EXCL\|INCL)${SEP}` |
| `NET_PREFIX` | hand-spelled `Sub${SEP}Total` | `${NET_LABEL}` — all four members |
| `EXCL`/`INCL` | two copies of the `c(?:l(?:uding)?)?` stem | both from `ABBREV_TAIL` |
| `SUBTOTAL_PATTERNS[2]` | its own `Exc(?:l(?:uding)?)?\.?` | `EXCL_LONG`, from `ABBREV_TAIL` |
| `TOTAL_PATTERNS[0..2]`, `VAT_PATTERNS[4]`, `SUMMARY_LINE_START` | `\s*` / `[\s-]*` between label words | `${SEP}` throughout |

`tests/unit/services/k076-ocr-vocabulary-separators.test.ts` walks each member across every
separator `SEP` admits, in both directions (`Sales Total`, `Taxi fare`, `Exclusive of delivery` and
`Index VAT` must NOT be swallowed). 132 assertions.

### MEDIUM — migration 672's WARNING was provably swallowed

FIXED: it now `RAISE EXCEPTION`s. Measured on the fixture with two live duplicate journals seeded:

- the committed pre-fix file (`git show 10f0abaef:...672...`) → **psql exit 0**, index absent. The
  deploy proceeds and the database ships without the constraint.
- the fixed file → **psql exit 3**, index absent, message `K-072: 1 captured document(s) carry more
  than one LIVE posting journal…`.
- after the operator remedy below → **exit 0**, index created.

There is no `notice` listener in `scripts/apply-migrations.ts` on this branch or on master (the one
that surfaces migration warnings is R-041, still unmerged), so `RAISE WARNING` went to a callback
nothing was listening on.

**What an operator must do when 672 aborts.** List the offenders:

```sql
SELECT company_id, source_document_id, COUNT(*), array_agg(entry_number)
  FROM gl_journal_entries
 WHERE source_document_id IS NOT NULL AND source = 'auto_expense_receipt' AND reversed_at IS NULL
 GROUP BY company_id, source_document_id
HAVING COUNT(*) > 1;
```

For each pair, REVERSE the journal that should not exist (Accounting → General Ledger → the entry →
Reverse), then re-run the migration. Reversal, never DELETE: the incorrect input VAT has already
been claimed in a VAT201 and must be corrected in the period that carries it. The reversal also
releases the document's posting claim, so the receipt can be re-posted correctly.

### MEDIUM — `posted_at` had no clearing path

FIXED. `document-capture-action` refuses a confirm/reject with "Reverse the journal or invoice
first"; nothing cleared `posted_at`, so that instruction was a dead end and the document stayed
refused by every route permanently.

`releaseCapturedDocumentPostingClaim` (`src/modules/accounting/services/capture/capturePostingClaimRelease.ts`)
clears it, and is called from the two undo paths: `reverseJournalEntry` (when the reversed entry
carries a `source_document_id`) and `cancelSupplierInvoice`. It refuses unless **both** NOT EXISTS
clauses hold — no unreversed `auto_expense_receipt` journal and no uncancelled supplier invoice
still reference the document — so undoing ONE of two live rows does not hand the document back.
That case is asserted directly.

Migration 672's index gained `AND reversed_at IS NULL` for the same reason: without it the re-post
the release permits would 23505 against the row it had just reversed, making the release a promise
the database refused to keep. The 672 backfill now uses the same two predicates, so the fence and
its undo cannot disagree about what "posted" means.

### MEDIUM — the `INCL` half of the vocabulary had a guard but no pattern

FIXED. `NOT_A_TAX_LABEL` refused `Incl VAT` as the tax with no prefix required, while
`TOTAL_PATTERNS` read it back only behind a MANDATORY prefix and `SUMMARY_LINE_START` had no branch
at all. Measured, a bare `Incl VAT 1150.00` came back total/subtotal/vat all NULL — a 400 on a
legible slip — and the line was collected as a phantom R1 150 expense item. The prefix is now
optional in `TOTAL_PATTERNS[2]` (the same shape `SUBTOTAL_PATTERNS[1]` gives the exclusive twin) and
`SUMMARY_LINE_START` carries one branch per pattern.

### Also fixed, because the fence could not be proved without it

`ai-invoice-pipeline` inserted `company_id` into `supplier_invoice_items` — a column that table has
never had (no migration adds it; `supplierInvoiceService`, the canonical AP insert, omits it).
`buildInvoiceFromExtraction` synthesises an "As per invoice" line when the document has none, so
there was ALWAYS at least one item: every call raised 42703, `withAuth` rolled the request back and
the route had never created an invoice. That is why HIGH-1's double claim was latent rather than
live — one repaired line away from posting. The column is removed from the INSERT; tenancy rides on
`supplier_invoice_id`, whose invoice is company-scoped, exactly as `supplierInvoiceService` does.

### Round-7 limits, disclosed

- **`journalEntryPostingService.ts` is 358 lines and `supplierInvoiceWorkflowService.ts` is 524** —
  both were already over the 300-line cap before this branch (345 and 513); this round added 8 and
  11 lines respectively. Splitting either is a refactor of code the findings did not name.
- **`expenses/[id].tsx` is 420 lines**, below its pre-branch 431. Disclosed and accepted in round 6.
- **No unique index on `supplier_invoices(company_id, source_document_id)`.** Routes 4 and 5 are
  fenced by the application claim only. The follow-up index is still deferred: its production
  duplicate risk has not been measured, and unlike the journal index there is no `reversed_at`
  equivalent to make it undo-safe (`status = 'cancelled'` would have to be in the predicate).
- **The backfill still treats a hard-DELETEd ledger row as un-posted.** A document whose journal was
  deleted outright rather than reversed becomes postable again. Deleting a posted journal is itself
  blocked elsewhere, so this is a residual, not a live path.
- The three round-6 LOW findings could not be recovered — the review file was lost with the
  scratchpad and neither `fix.md` nor `green.log` records their text. Stated rather than guessed.

**Round-6 limits.** The backfill treats "has a journal, a supplier invoice, or a
`matched_invoice_id`" as posted; a document whose ledger row was later deleted outright becomes
postable again. The unique index does not cover the supplier-invoice path — `capture/[id]/post` and
`ai-invoice-pipeline` both insert `supplier_invoices.source_document_id`, and only the application
claim stops a second invoice there; a partial unique index on `supplier_invoices(company_id,
source_document_id)` is the follow-up, deferred because its production duplicate risk has not been
measured. `expenses/[id].tsx` is still over the 300-line cap.

## Round 8 — the five findings of `review-k072-r5.md`

### HIGH-1 — a section total was read as the payable total

FIXED, and fixed as a CLASS. `TOTAL_PATTERNS[0]` is guarded by `NOT_A_SUBTOTAL`, a five-member
DENYLIST of net-label stems, and `extractAmounts` took `text.match(...)` — the LEFTMOST hit. Any
other noun in front of `Total` therefore won. Measured on `85e8baef9`:

```
Tashas Cafe / Food Total 200.00 / Drinks Total 50.00 / VAT 32.61 / TOTAL 287.50
  → {subtotal: 167.39, vatAmount: 32.61, totalAmount: 200, warnings: []}   autoPost = true
```

R287.50 on the slip, R200.00 credited to the bank, silently: with no printed net the subtotal is
DERIVED as `total − VAT`, so the entry balances by construction, the routes' balance pre-check
passes and `shouldAutoPostReceipt` returns true. No downstream gate can see it.

Widening the denylist is what produced the defect twice already, so the total is now chosen
POSITIVELY. `extractTotalCandidates` (`ocrAmountReconciliation.ts`) collects EVERY candidate the
first productive pattern yields; `selectTotalAmount` takes the single distinct value where there is
one, else the candidate the document's own arithmetic endorses (`printed subtotal + VAT`), else the
LAST one — a grand total is printed below the sections it sums — with the disagreement declared
under the `UNRECONCILED_WARNING` prefix, which `shouldAutoPostReceipt` already refuses. Measured
after the fix (same call, `{maxAmount: 5000, minConfidence: 0.85}`):

| Document | total | warnings | autoPost |
|---|---|---|---|
| `Food Total 200 / Drinks Total 50 / VAT 32.61 / TOTAL 287.50` | **287.50** | 1 | false |
| `Goods / Items / Line / Order / Deposit Total 250 …/ Total Due 1150` | **1150** | 1 | false |
| `Beverage / Kitchen / Pharmacy / Workshop / Trolley Total …` (nouns in no denylist) | **1150** | 1 | false |
| `Delivery Total 250 / Sub Total 1000 / VAT 150 / Total Due 1150` | **1150** | 0 | true |
| `Sub Total 1000 / VAT 150 / Total Due 1150` | 1150 | 0 | true |
| `TOTAL (VAT INCL) 1150.00 / Total Due 1150.00` | 1150 | 0 | true |

The `Delivery Total` case IMPROVES: it used to warn and 400; the printed net now settles it on
evidence. `tests/unit/services/k076-ocr-grand-total-selection.test.ts` asserts all of it, over ten
section nouns, five of which appear in no list in this repo.

### HIGH-2 — a draft receipt journal claimed the document permanently

FIXED. `receipt-to-journal` claims before its first ledger write and only POSTS when the auto-post
gate passes; over R5 000 or below 0.85 confidence — the majority — it left a DRAFT, and every exit
was closed (confirm 400, reject 400, re-post 400, `reverseJournalEntry` throws on a draft, no JE
delete route).

`releaseUnpostedCaptureClaim` (`capturePostingClaimRelease.ts`) is the way back: it reads liveness
FIRST — any unreversed non-draft capture journal, any uncancelled supplier invoice, any expense
claim not rejected/cancelled — and refuses having written nothing, which is what makes the 400 safe
under `withAuth`'s commit-on-4xx. Otherwise it DELETEs the draft capture journals (`AND status =
'draft'`, lines cascade) and clears `posted_at`. `captureLifecycleGate.releaseClaimForLifecycleAction`
takes the document lock first, so the release and the lifecycle UPDATE cannot be raced apart.

The employee-claim branch is fixed at its own undo: `rejectClaim` and `cancelClaim` now call
`releaseClaimDocuments`, because the claim journal carries `source_document_id = NULL` by design and
the reversal release can never reach those documents. `releaseCapturedDocumentPostingClaim` gained a
third NOT EXISTS for live claims so no caller can hand back a slip another claim still holds.

Measured end to end through the real routes (`k072-draft-claim-release.int.test.ts`):

```
receipt (confidence 0.5) → 200, journal 'draft', posted_at stamped
confirm                  → 200, posted_at NULL, draft journal GONE, no orphan lines
re-post                  → 200, exactly one journal
reject (second document) → 200, posted_at NULL; the next post refuses on 'rejected'
receipt (confidence .95) → posted; confirm 400, journal untouched; reverse → confirm 200
post-expense claim       → claimed; confirm 400 while submitted; reject claim → posted_at NULL
reversed + re-drafted    → confirm 200, the reversed POSTED entry still standing
invoice/claim + draft    → confirm 400 and the draft still there (refusal writes nothing)
```

### MEDIUM-1 — migration 672 backfilled on a predicate no code shares

FIXED. `OR cd.matched_invoice_id IS NOT NULL` is gone: it appeared in neither
`refusalForPosting` nor the release, and nothing clears that column, so every row it claimed was
refused by all four posting routes and by both lifecycle buttons forever. The backfill now carries
exactly the three NOT EXISTS predicates of `releaseCapturedDocumentPostingClaim` (journal, invoice,
live claim) and the comment says what the code does. The test runs the REAL migration file inside a
rolled-back transaction (the fixture database is shared) and asserts both directions: a document
with `matched_invoice_id` and no ledger row stays postable, a document with a live posting journal
is claimed.

`ai-invoice-pipeline`'s duplicate branch still writes `status='matched', matched_invoice_id` before
its 409 — DISPUTED as a defect. That row records a true fact (this slip duplicates that invoice) and
with the disjunct dropped it is no longer a dead end: measured, such a document confirms, rejects
and posts normally.

### LOW-1 — the claim's own `posted_at` predicate is now pinned

`claimCapturedDocumentForPosting` is called twice directly, with no lock held, in
`k072-draft-claim-release.int.test.ts`. Deleting `AND posted_at IS NULL` makes the second call
succeed and the test red (M1 below).

### LOW-2 — the manual journal route, and the census re-run

`pages/api/accounting/journal-entries.ts` took `source` from the body unvalidated. It now refuses
anything but `'manual'` (the only value any caller in the repo sends — `pages/accounting/journal-entries/new.tsx`
and the close-agent E2E specs), so a hand-made journal can no longer land inside
`uq_gl_je_capture_source_document` nor create a live journal against a claimed document outside the
fence.

**Census re-run, by consumer, with the directories walked listed.** Enumerated from the TABLE
(`INSERT INTO gl_journal_entries`, callers of `createJournalEntry`) and from the ARGUMENT (every
`sourceDocumentId` / `source_document_id` occurrence), not from the guard.

Directories walked in full: `pages/api/**` (every route, not only `accounting/`), `pages/accounting/**`,
`src/lib/mcp/tools/**`, `src/modules/accounting/services/{afs,annotations,ap,ar,bank,capture,commentary,core,dashboard,expense,gl,items,loans,packs,payroll,practice,reconciliation,reports,share,shared,workbench}`,
`src/modules/{admin,analytics,billing,bureau,onboarding}/services/**`, `scripts/**`,
`scripts/migrations/sql/**`.

| Writer | Stamps a captured document? | Covered by |
|---|---|---|
| `receipt-to-journal.ts` | yes (`documentId`) | claim + unique index |
| `capture/[id]/post-expense.ts` (both branches) | yes | claim (+ index on the journal branch) |
| `capture/[id]/post.ts` | yes (supplier invoice) | claim |
| `ai-invoice-pipeline.ts` | yes (supplier invoice) | claim |
| `journal-entries.ts` (manual POST) | body-supplied, ownership-checked | `source` restricted to `'manual'` (this round) |
| `evidenceAttachmentService`, `provisional/[jeId]/attach` | stamps an EXISTING journal | not a posting; index scoped to `auto_expense_receipt` |
| `bankAllocationService` | copies an invoice's document id | not a posting; source is `auto_payment` |
| `expenseClaimService` (claim lines) | yes (`expense_claim_lines.source_document_id`) | claim + release on reject/cancel (this round) |
| `src/lib/mcp/tools/writeJournals.ts`, `writeOpeningBalance.ts` | no — passes neither `source` nor `sourceDocumentId` | defaults to `'manual'` |
| every other `createJournalEntry` caller (35 files) | no — each states why, most because the FK is to `captured_documents` | n/a |
| `scripts/**` one-off + seed scripts, `assetDepreciationPosting`, `yearEndCloseService`, `bank-transfers.ts` | raw INSERTs, no `source_document_id` | n/a |

### Mutations, round 8 (file copies, restored and byte-compared)

| # | Mutation | Outcome |
|---|---|---|
| M1 | drop `AND posted_at IS NULL` from `claimCapturedDocumentForPosting` | RED (1 int) |
| M2 | delete the claim in `ai-invoice-pipeline.ts` | RED (3 int) |
| M4 | revert `NET_LABEL` to `S[./]Total` | RED (6 unit) |
| M5 | stop `reverseJournalEntry` releasing the claim | RED (4 int) |
| M6 | empty `TAX_NOUN` | RED (13 unit) |
| M7 | take the FIRST total candidate | RED (12 unit) |
| M8 | drop the ambiguity warning | RED (11 unit) |
| M9 | skip the lifecycle gate | RED (2 int) |
| M10 | release ignores its liveness read | RED (1 int) |
| M11 | claim rejection releases nothing | RED (1 int) |
| M12 | manual route trusts the body's `source` | RED (1 int) |
| M13 | re-add the `matched_invoice_id` disjunct to the backfill | RED (1 int) |
| M14 | drop `AND status = 'draft'` from the release's DELETE | RED (1 int) |
| M15 | drop the live-claim clause from `releaseCapturedDocumentPostingClaim` | RED (1 int) |
| M16 | drop the live-claim clause from the liveness read | RED (1 int) |
| M17 | selection ignores the arithmetic endorsement | RED (1 unit) |
| M18 | selection takes the first candidate instead of the last | RED (11 unit) |

M10, M14, M15 and M16 survived their first run and are red only because a test was then written
for the state each protects — the supplier-invoice-plus-draft and live-claim-plus-draft rows are
written directly, because no route can build them now.

### Round-8 limits, disclosed

- **M3 (dropping `AND posted_at IS NULL` from the confirm/reject UPDATEs) now SURVIVES.** Measured:
  49 integration tests stay green. The lifecycle gate refuses or releases first, while holding the
  document's `FOR UPDATE`, so the statement-level predicate can no longer be reached as a fence. It
  is kept as the last line of defence and the layer that decides is pinned by M9. Same shape as
  round 7's LOW-1, with the outer layer pinned this time.
- **`expenseClaimService.ts` is 548 lines** (538 before this round) and `document-capture-action.ts`
  is 277. The lifecycle gate was extracted to `captureLifecycleGate.ts` rather than pushing the
  route over the cap; splitting `expenseClaimService` is a refactor no finding named.
- The supplier-invoice unique index and the hard-DELETE residual carry over from round 7 unchanged.

---

## Round 9 — the endorsement inverted the defect, and the minus sign was never read

### HIGH-1 — `subtotal + VAT` may endorse only the BOTTOM figure

`ocrAmountReconciliation.ts` `selectTotalAmount`. Round 8 replaced the section-total denylist
with "the candidate the document's own arithmetic endorses, anywhere in the list". That rule
under-refuses in the mirror direction, on the ordinary SA layout that prints a gratuity, a
delivery fee or a rounding line BELOW the Sub Total / VAT / Total block:

```
Sub Total 200.00 / VAT 15% 30.00 / Total 230.00 / Gratuity 23.00 / Total Due 253.00
```

200 + 30 endorsed the INTERMEDIATE 230.00 **and suppressed the warning**, so the branch that
was supposed to add evidence is precisely what converted a correct refusal into a silent wrong
number. Measured end to end before the change (probe output,
`<scratchpad>/agents/fix-k072g/out.txt`):

| slip | total read | payable | warnings | autoPost |
|---|---|---|---|---|
| gratuity below the block | 230.00 | 253.00 | 0 | **true** |
| delivery below the block | 230.00 | 287.50 | 0 | **true** |
| rounding below the block | 230.00 | 230.05 | 0 | **true** |

After (`out3.txt`): 253.00 / 287.50 / 230.05, two warnings each, `autoPost: false`.

The rule is now `subtotal + VAT === last`. Because `last` is always in `distinct`, the
"exactly one endorsed candidate" filter collapses to that one comparison.

**Both directions proved.** The round-8 cases that must NOT regress into refusals are
unchanged and still measured green in the same probe run: `Delivery Total 250 / Sub Total 1000
/ VAT 150 / Total Due 1150` → 1150, no warning, `autoPost: true`; the ten unknown section
nouns → 1150; the Tashas multi-section slip → 287.50 refused; the one-total-printed-twice and
the plain single-total slips unchanged.

**The cost, stated rather than hidden.** Where the endorsed figure IS the payable and something
LARGER is printed under it (a cash-tendered line), the reader now refuses instead of getting it
right by accident. That document is indistinguishable from the gratuity case by arithmetic, and
by label only to a denylist — which is what this module abolished. On an unattended posting path
the correct default for an ambiguous document is a person, so this is deliberate; it is pinned
as an outcome by `refuses rather than guesses when the endorsed figure is not the bottom one`.
No round-8 test covers that shape, so nothing regressed.

### LOW-1 — a printed minus sign is read, and a negative total never auto-posts

`AMOUNT` carried no sign and BOTH separators ate a hyphen unconditionally — the label separator
`[:-]?` and the word separator `SEP` (`[\s._/-]*`), which sits between `Total` and its figure in
`TOTAL_PATTERNS[0]`. Fixing only the first would have left the totals line reading `+115`.

Measured before: `CREDIT NOTE / Sub Total -100.00 / VAT 15% -15.00 / Total -115.00` →
`{100, 15, 115}`, `warnings: []`, `autoPost: true` — a refund read as a purchase, balanced, and
inside the unattended gate. `detectDocumentType` answers `credit_note` on the same text, and
nothing in the posting path consults it.

- `AMOUNT` gains a capture-group-internal `-?`.
- `SEP` and the new shared `VALUE_SEP` consume a hyphen only when a digit does NOT follow it
  (`-(?!\d)`), so `Total - 115.00` and `Total -  115.00` stay positive and `Total -115.00`
  reads the sign. A dash printed as a separator with no space after it is the one ambiguous
  spelling and now reads negative — the safe way round, because the gate below refuses it.
  **Corrected in round 10: that held for the total and net labels only.** On the VAT line
  (`VAT_PATTERNS[1]`, whose separator is required, not optional) `VAT-0.00` read NULL, and a null
  VAT is not refused — the builder derived 15%, R13.04 of invented input tax on a zero-rated
  slip, auto-posted. See round 10, HIGH-2.
- `isPlausibleVatAmount` compares MAGNITUDE. Signed, `-15 <= -115` is false, so a credit note's
  VAT line printed without cents would have been refused as a registration number and lost.
- `shouldAutoPostReceipt` refuses `totalAmount <= 0`. `buildExpenseJournalFromReceipt` would
  otherwise build a REVERSED expense entry from a negative total — balanced, negative debits,
  a negative bank credit, unattended. A refund is a real accounting event and not this route's.

Not fixed, and named: a parenthesised negative `Total (115.00)` is consumed by the
qualifier group in `TOTAL_PATTERNS[0]` and comes back null (the document is refused, not
mis-read). No finding names it and it is not a wrong-number class.

### LOW-2 — the migration test no longer fails on a peer's rows

`k072-draft-claim-release.int.test.ts`. Migration 672's duplicate check scans
`gl_journal_entries` globally, as it must in production, and the fixture database is shared with
six other worktrees — a peer's duplicate `auto_expense_receipt` pair would `RAISE EXCEPTION` and
fail this branch's test for a reason that is not this branch's. Inside the SAME rolled-back
transaction the test now stands OTHER companies' duplicate groups down to one live row each
(`company_id <> $1`), leaving this company's rows exactly as the sequence built them. The
`BEGIN … ROLLBACK` and the execution of the real migration file are unchanged, so M13's pinning
of the backfill predicate is unaffected. The residual table locks the reviewer noted are
inherent to executing the real file and are transaction-short.

### Mutations, round 9 (file copies, restored and byte-compared identical)

Suite: the seven k075/k076 unit files, 332 tests.

| # | Mutation | Outcome |
|---|---|---|
| N1 | endorsement accepts a candidate anywhere (the round-8 rule) | RED (4) |
| N2 | drop the endorsement entirely (`if (false)`) | RED (1) |
| N3 | drop `-?` from `AMOUNT` | RED (2) |
| N4 | `SEP` back to `[\s._/-]*` | RED (1) |
| N5 | `VALUE_SEP` back to `[:-]?` | RED (1) |
| N6 | drop the `totalAmount <= 0` gate | RED (2) |
| N7 | `isPlausibleVatAmount` back to a signed comparison | RED (1) |

| N8 | `extractVatAmount` ignores its arithmetic endorsement (after the move below) | RED (2) |

N1 and N2 are the two directions of the same line: N1 is the over-trusting rule this round
replaced, N2 the over-refusing one it must not become. All eight were re-run AFTER the move
below, against the moved code, with fresh backups.

### File-size cap

`ocrAmountPatterns.ts` was already 312 lines at `421000e2f` — over the 300 cap, on this branch —
and `VALUE_SEP` would have taken it to 329. `extractVatAmount` moved to `ocrAmountReconciliation.ts`:
it cross-checks `subtotal + VAT === total`, which is document arithmetic, and the patterns file's own
header says nothing in it knows what a document is. One production importer
(`ocrExtractionService`), no direct test importer; the body is unchanged and N8 pins it in its new
home. Now: patterns 283, reconciliation 235, parsing 90, extraction service 295.

The LOW-2 change is test hygiene against a shared fixture and has no production line to mutate;
its correctness is that the 7 integration files still pass 49 tests unchanged.

---

## Round 10 — the gate stops picking a total, and asks whether there is one to pick

### Why the approach changed — read this before adding a rule to `selectTotalAmount`

Four rounds in a row had a HIGH in grand-total selection, and every fix failed in a direction
nobody was pointing it at:

| round | rule for "which printed total is the payable" | the slip that beat it |
|---|---|---|
| 5–7 | leftmost `Total`, guarded by a DENYLIST of net labels | `Goods / Items / Line / Order / Deposit Total` above the payable |
| 8 | the candidate `subtotal + VAT` endorses, anywhere | a gratuity, delivery fee or rounding line BELOW the block: 230 read of 253 |
| 9 | the endorsed candidate only if it is the BOTTOM one | a mixed basket whose VAT-analysis block is printed UNDER the tender: 230 read of 253, where master read 253 |
| (proposed) | `&& last === Math.max(...distinct)` | not built — a fifth heuristic, and a sixth slip would beat it |

The OCR text is genuinely ambiguous: `Sub Total 200 / VAT 30 / Total 230` is a complete
standard-rated block whether it is the whole slip, the part above a gratuity, or the VAT analysis
of a basket that also carries zero-rated bread. No ordering or arithmetic rule separates those,
and by label only a denylist does — which is what round 8 abolished.

But on an UNATTENDED posting path the goal was never to pick right. It is **never to post a wrong
number**, and that problem is solvable, because a refusal costs a person a few seconds on the
capture screen while a wrong post costs money silently. So the two are separated:

- **Extraction guesses.** `selectTotalAmount` offers the bottom candidate as the best guess and
  ALWAYS declares the ambiguity (under `UNRECONCILED_WARNING`) when more than one distinct total is
  printed. The `subtotal + VAT` endorsement is gone — it never decided anything safely.
- **`unattendedPostingRefusal` decides** (`core/unattendedPostingGate.ts`, new). A document posts
  with nobody looking only if nothing on it is left to choose: not a credit note (stored type OR
  text); no reconciliation warning; a total > 0; a VAT figure that was read and is >= 0; net + VAT =
  total where a net is printed; and exactly ONE distinct total re-read from `rawText`, equal to the
  total read. Re-reading the text rather than trusting the stored warnings means an extraction
  stored by an earlier build — or produced by the VLM — is judged by the same rule.
- `shouldAutoPostReceipt(extracted, config)` takes the whole document; the amount cap and the
  confidence floor apply only after the gate.

**The default for any ambiguity is refusal. Do not add a rule that promotes one of several
candidates to postable** — that is the move that failed four times.

### HIGH-1 — every slip from rounds 5–9 either refuses or posts its payable

`tests/unit/services/k076-slip-corpus.ts` holds all 50 (the Tashas multi-section slip, the eleven
section nouns, gratuity/delivery/rounding below the block, the `Delivery Total / Sub Total` case,
the tender and card-slip layouts, the four VAT-analysis layouts, nine credit-note spellings, the
glued-dash slips, three slips built against this gate). `k076-unattended-posting-gate.test.ts`
runs each through the real `extractFromText` and the real gate, asserts the invariant on every row
(refuses, or posts `totalAmount === payable` with the bank leg equal to it and no more input tax
than the slip prints), and pins the outcome. Measured, old = `c23bbf133`, new = this round
(`<scratchpad>/agents/fix-k072h/probe-{old,new}.tsv`):

| outcome | slips |
|---|---|
| refused before and after | 25 |
| posted the payable before and after | 12 — ordinary single total, one total printed twice, cash tendered + change, card slip with its own `Total`, tender-only mixed basket, zero-rated `VAT-0.00` / `VAT - 0.00` / `VAT: 0.00` (D5–D7, E2–E4), registration number glued to a dash. E2 and E3 posted the right bank figure before with R13.04 of INVENTED input tax (HIGH-2); they now claim 0 |
| **posted a WRONG number before, refused now** | 9 — A1–A4 (230 of 253), C1/C2/C3/C5 (credit notes as purchases), X2 (no VAT line: the builder invented 15%) |
| posted the payable before, refused now (over-refusal) | 4 — see below |
| posts a wrong number now | **0** |

**Over-refusal, measured honestly.** Four honest slips that posted correctly at `c23bbf133` now
refuse: `Delivery Total 250 / Sub Total 1000 / VAT 150 / Total Due 1150` (two distinct totals);
`VAT-150.00` on two standard-rated slips (D1, E1 — the glued dash now reads -150, see HIGH-2; they
posted before only because a null VAT was replaced by 15%, which happened to be right); and a slip
with a `QTY ITEM TOTAL` column header, whose `TOTAL` reads the next line's quantity as a total.
Ordinary tender lines and card slips still post (O2, O3, the tender-only basket). Two structural
costs are larger than any slip count:

- **A photo the VLM read directly has no `rawText`, so it cannot show it is unambiguous, and is
  refused.** `extractFromImage` returns `rawText: ''` and `vllm-qwen` is active on this machine, so
  if the production `.env.local` sets `VLLM_BASE_URL` every photographed receipt now lands as a
  draft. I could not read that file. The count is one query:
  `SELECT COUNT(*) FILTER (WHERE COALESCE(extracted_data->>'rawText','') = '') , COUNT(*) FROM captured_documents`.
  This follows the brief's rule (ambiguity refuses); reversing it is one line in the gate.
- **A slip with no VAT line refuses** (a non-VAT vendor). It used to post with 15% input tax the
  document never stated, so this corrects a wrong post rather than blocking a right one.

### The other direction — what this gate still lets through

Built against the gate before reporting (`probe-residual.tsv`). A payable printed under a label the
total vocabulary does not read — `TO PAY 253.00`, Afrikaans `TOTAAL 253.00`, a bare `Balance
253.00` — below a gratuity or a VAT-analysis block leaves exactly ONE readable total, the
intermediate `Total 230.00`, and it posts: **R230 against a payable of R253**. Master and
`c23bbf133` post the same figure, so this is not a regression, but it is the gate's limit: it is
exactly as strong as the vocabulary that finds totals. Two ways to close it, neither built, both a
decision: widen the PAYABLE vocabulary positively (unlike the old denylist, each label added can
only add a candidate, i.e. move a slip towards refusal), or refuse any larger two-decimal figure
printed after the single total (which costs the cash-tendered layout — `Cash 300.00 / Change
47.00` — the brief requires to keep posting). In the other direction, `Points Total 45` on an
honest slip refuses.

### HIGH-2 — `VAT-0.00` reads 0 again

`VAT_PATTERNS[1]`'s separator is REQUIRED, so round 9's `(?::|-(?!\d))` did not make a glued
`VAT-0.00` negative — it made it read NOTHING, and the builder replaced the null with 15%: R13.04
of invented input tax on a zero-rated slip, auto-posted. The reviewer's measured fix is taken:
`(?::|-(?!\d)|(?=-\d))` accepts the glued dash without consuming it, so `AMOUNT` reads the sign —
`VAT-0.00` is 0, `VAT-150.00` is -150 and refuses. `parseAmount` folds the resulting `-0` into 0.
The round-9 claim that this spelling "reads negative, safe" is corrected in place (round 9, LOW-1)
and at `ocrAmountPatterns.ts` `VALUE_SEP`. Under the new gate a null VAT refuses anyway; the fix is
so the person reviewing the draft sees 0.

With the dash now read as a sign, a letterhead `VAT-4123456789` reaches `isPlausibleVatAmount` as
-4123456789; its MAGNITUDE comparison refuses it (row X1 pins that — the reviewer's "nearly
equivalent" `Math.abs` survivor is now load-bearing and killed).

### HIGH-3 — a credit note never posts unattended, on any of the four paths

`isCreditNote` reads the stored `documentType` OR `detectDocumentType(rawText)` (the VLM classifies
on its own). Enumerated from the writers in the round-7 census, not assumed:

| path | unattended outcome | refusal |
|---|---|---|
| `receipt-to-journal.ts` | posts the journal | `shouldAutoPostReceipt` → gate → draft |
| `capture/[id]/post-expense.ts` → `pettyCashJournalService` | posts the journal | same gate → draft |
| `ai-invoice-pipeline.ts` | `status = 'approved'` supplier invoice | `approvalRoute = 'manual_review'` → draft |
| `capture/[id]/post.ts` | `approved` via `auto_approve` OR the supplier rule's `auto_publish` | `invoiceStatus = 'draft'` before either |
| `post-expense` → `expenseClaimService` | claim lines, approved by a person | not unattended |

Each path is pinned by an outcome test (two unit, three integration). On the invoice paths the
ambiguity checks are NOT applied — only the credit-note refusal the finding named. A supplier
invoice's text layer routinely prints a `Total` column header, so the candidate check would refuse
most PDF invoices, and I have no invoice corpus to measure that on.

### LOW-1 — the five `VALUE_SEP` sites are pinned

`Amount Due`, `Incl VAT`, `Tax Amount`, `Excl VAT`, `Nett Excl` each read a glued minus sign
(`k076-ocr-negative-amounts.test.ts`, `GLUED_MINUS`); reverting any one site goes red (P2–P6 below).

### Mutations, round 10 (file copies, restored and byte-compared identical)

Unit suite: the k07x unit files, `receiptZeroVatLine`, `fiscalPeriodAutoCreate`,
`ai/receipt-to-journal`, `postExpenseZeroVatLine` — 15 files, 483 tests, green before each run.
W2–W4 run the integration file named. Script and log: `<scratchpad>/agents/fix-k072h/mutate.{py,log}`.

| # | Mutation | Outcome |
|---|---|---|
| G1 | gate: drop the credit-note refusal | RED (7) |
| G2 | `isCreditNote` by text only | RED (2) |
| G3 | `isCreditNote` by stored type only | RED (1) |
| G4 | gate: ignore the reconciliation warning | RED (2) |
| G5 | gate: allow a zero total | RED (1) |
| G6 | gate: allow a null VAT | RED (1) |
| G7 | gate: allow a negative VAT | RED (1) |
| G8 | gate: skip net + VAT = total | RED (1) |
| G9 | gate: allow no printed total | RED (1) |
| G10 | gate: allow several printed totals | RED (1) |
| G11 | gate: allow a total the text does not print | RED (1) |
| S1 | `selectTotalAmount` never warns on several totals | RED (2) |
| P1 | `VAT_PATTERNS[1]` separator back to round 9 | RED (5) |
| P2–P6 | `VALUE_SEP` reverted at Amount Due / Incl VAT / Tax Amount / Excl VAT / Nett Excl | RED (1) each |
| P7 | `parseAmount` keeps `-0` | RED (1) |
| A1 | `isPlausibleVatAmount` compares signed values | RED (2) |
| W1 | post-expense hands the gate figures, not the document | RED (1) |
| W2 | receipt-to-journal hands the gate figures, not the document | RED (1, integration) |
| W3 | `ai-invoice-pipeline` approves a credit note | RED (1, integration) |
| W4 | `capture/[id]/post` approves a credit note | RED (1, integration) |

The round-9 mutations N1/N2 (the endorsement rule) have no code left to mutate: the endorsement
is gone. Three integration fixtures carried `rawText: ''`, which the gate now refuses; they print
their figures instead, because they test the fence, not the gate.

---

## Round 11 (review of `0545d19e3`: 2 HIGH · 1 MEDIUM · 1 LOW)

### HIGH-1 — the candidate LOOP, not the vocabulary, dropped the payable

`extractTotalCandidates` returned the candidates of the FIRST `TOTAL_PATTERNS` entry that hit and
never consulted the others, so on any slip printing a plain `Total` above its payable,
`TOTAL_PATTERNS[1]` (`Amount Due` / `Balance Due` / `Payable`) and `[2]` (`Amount Incl VAT`) were
unreachable — labels the vocabulary has always known. Measured, `Sub Total 200.00 / VAT 15% 30.00 /
Total 230.00 / Gratuity 23.00 / Amount Due 253.00` yielded ONE candidate, 230.00, equal to the total
read: no warning, `autoPost = true`, R230.00 credited to the bank against a payable of R253.00.

**Fixed** by collecting across every pattern and ordering the hits by MATCH POSITION, so
`selectTotalAmount`'s "the bottom one" still means the figure printed lowest, whichever pattern read
it. Measured after (`<scratchpad>/agents/fix-k072i/probe-vocab.txt`, real `extractFromText` + real
`shouldAutoPostReceipt`): U1–U8 all flip from POST to refuse; the eight realistic ordinary receipts
(Woolworths, Engen, Uber, Mugg & Bean, Spar, Takealot, Pick n Pay, Builders) are byte-identical to
before, and the corpus that existed before this round still passes unchanged.

**The out-of-vocabulary labels were re-checked**, as the round required, and three still posted
R230.00 after the loop fix. They are now in the vocabulary, which can only ever ADD a candidate and
therefore only ever move a slip towards refusal:

| spelling | where it went |
|---|---|
| `TOTAAL`, `SUB TOTAAL` | `TOTAL_WORD = Totaa?l`, one alternation used by every guard, every pattern and `SUMMARY_LINE_START` — the failure this file keeps having is one half of a pair learning a spelling |
| `TO PAY`, `TE BETAAL`, bare `Balance`, `TTL` | `PAYABLE_LABEL`, extracted from `TOTAL_PATTERNS[1]` and shared with `SUMMARY_LINE_START` |

**Deliberately NOT admitted**, because the cost falls on honest documents and is larger than the
buy — both remain a disclosed limit, and a slip printing its payable under one of them with a plain
`Total` above still posts the `Total`:

- `Amount Paid` is a paid-TO-DATE figure, not a payable. An ordinary invoice printing
  `Amount Paid 0.00` above `Balance Due 1150.00` would gain a second candidate and stop posting.
- a bare `ZAR 253.00` carries no label at all; every currency-marked line item would become a
  candidate. `Purchase` is the same shape — `Purchase Order 1234` would read 1234 as a total.

### HIGH-2 — the invoice paths approved a wrong number, worse than master on three layouts

`ai-invoice-pipeline.ts` and `capture/[id]/post.ts` took only the credit-note refusal and ignored
the ambiguity the reader already computes. Measured over the corpus: A1/A2/A4 auto-approved at
R230.00 against a payable of R253.00 where master read 253.00 — a REGRESSION, and a branch that
ships worse behaviour than master on a money path cannot merge.

**Fixed** with `isAmbiguousTotal(doc)` (new, in `unattendedPostingGate.ts`): the stored
reconciliation warning, OR more than one distinct total in `rawText`. Both routes send such a
document to `manual_review` / `draft`, and in `capture/[id]/post.ts` that overrides `auto_publish`
as well, whose rules judge the supplier and the duplicate history rather than whether the amount is
legible. The reported `approvalRoute` and the written `invoiceStatus` now come from one variable, so
the response cannot say `auto_approve` over a draft invoice.

The routes do NOT take the whole gate, and the reason is measured rather than asserted: a PDF
invoice the VLM read carries `rawText: ''`, which `unattendedPostingRefusal` refuses outright, so
the full gate would send every VLM-read invoice to a person. `isAmbiguousTotal('')` is false, so
that path is untouched.

**Cost, measured** (`<scratchpad>/agents/fix-k072i/probe-inv.txt`, supplier match 1.0, the routes'
own `DEFAULT_THRESHOLDS`): 27 corpus rows move `auto_approve` → `manual_review`, six of which were
approving a wrong figure (A1–A4, r8 `Cash Total`, X3) and 21 of which are adversarial multi-total
layouts where the guess happened to be right. On seven ordinary invoice layouts — Woolworths,
Engen, a description-first Takealot header, a qty-first header, a PDF invoice with a remittance
slip below, a plain supplier invoice and Builders — **nothing changed at all**; the qty-first header
was already `manual_review` on its warning penalty. No corpus row still auto-approves a wrong
number. This replaces the round-10 claim above that the candidate check "would refuse most PDF
invoices": that was never measured, and it is wrong.

### MEDIUM-1 — the gate re-read the total and trusted the VLM's net and VAT

`unattendedPostingRefusal` re-read only the total. Measured: a zero-rated slip whose text prints
`Maize Meal 1 100.00 100.00 / Total 100.00`, stored by the VLM as net 86.96 / VAT 13.04 / total
100.00, satisfied every check — the arithmetic adds up, the total agrees with the text — and posted
`EXP 86.96 / VAT-in 13.04 / bank 100`, R13.04 of input tax the document does not state. That is the
X2 defect ("no VAT figure was read") reached through the VLM instead of the regex reader.

**Fixed** by re-reading with `extractAmounts(rawText)` — the reader's own function, so the re-read
is identical BY CONSTRUCTION to what a regex-extracted document already holds, and the corpus does
not move — and refusing when the text prints no VAT figure, or one that disagrees. Corroborating the
VAT is sufficient for the net as well: with the total corroborated and `subtotal + VAT === total`
already checked, the net is determined; where the net is null the builder derives `total − VAT`,
which is now corroborated too.

Measured (`<scratchpad>/agents/fix-k072i/probe-vlm.txt`): M1 (the case above) and M5 (same, null
net) now refuse with "no VAT figure is printed on the document"; M2 (VLM 13.04, text prints
`VAT 0.00`) and M4 (VLM 100, text prints 150) refuse with "not the VAT the document prints"; M3, a
VLM extraction that agrees with the printed VAT, still posts `EXP 1000 / VAT 150 / BANK 1150`. The
over-refusal cost on the corpus is **zero rows** — 58/58 unchanged — because every corpus row is
regex-extracted and its stored VAT is what the re-read produces.

### LOW-1 — the corpus could not fail the HIGH-1 class

Every row came from a previous reviewer, so none printed its payable under a second label. 21 rows
added: eleven `U` rows printing the payable under `Amount Due` / `Balance Due` / `Amount Payable` /
`Amount Incl VAT` / `Grand Total` / `TOTAAL` / `TO PAY` / `TE BETAAL` / `Balance` / `TTL` /
`NETT PAYABLE` below a plain `Total`, two more with the payable ABOVE a VAT-analysis block, and
eight `N` rows of ORDINARY receipts in the proportion a real till roll prints them — a corpus of
nothing but counter-examples cannot show an over-refusal. Corpus 53 → 74 rows; the gate test 58 →
79 assertions. Three of the eight ordinary receipts refuse, and each for a pre-existing reason the
round did not introduce: N1 Woolworths prints its VAT as `VAT INCLUDED` (a label gap — it refuses
rather than inventing 15%), N2 Engen and N7 Pick n Pay by the 0.85 confidence floor, on master too.

### Mutations, round 11 (file copies, restored byte-identical; `<scratchpad>/agents/fix-k072i/mutate.py`)

Baseline `tests/unit/services/k076* k072*`: 437 tests green.

| # | Mutation | Outcome |
|---|---|---|
| G1 | candidate loop returns on the first productive pattern | RED (12) |
| G2 | candidates not ordered by match position | RED (1) |
| G3 | `PAYABLE_LABEL` loses `Balance` / `TO PAY` / `TE BETAAL` / `TTL` | RED (4) |
| G4 | `TOTAL_WORD` loses the Afrikaans spelling | RED (1) |
| G5 | gate stops refusing a VAT the text does not print | RED (1) |
| G6 | gate stops comparing the re-read VAT | RED (1) |
| G7 | `isAmbiguousTotal` ignores the stored warning | RED (1) |
| G8 | `isAmbiguousTotal` treats any candidate as ambiguous | RED (1) |
| W1 | `ai-invoice-pipeline` drops the ambiguity check | RED (1, integration) |
| W2 | `capture/[id]/post` drops the ambiguity check | RED (1, integration) |

Confirmed by the round-10 reviewer and not touched: `VAT-0.00`/`VAT-150.00`, the five `VALUE_SEP`
pins, photo receipts refused on `rawText: ''`, and the four-path credit-note census.

### Historical impact

Not measured — production must not be queried from here. The SQL Hein can run to size it:

```sql
-- Documents auto-posted or auto-approved whose stored text prints a payable
-- under a second label. Read `extracted_data->>'rawText'` and re-run the gate.
SELECT cd.id, cd.company_id, cd.posted_at,
       cd.extracted_data->>'totalAmount' AS stored_total,
       cd.extracted_data->>'rawText'     AS raw_text
  FROM captured_documents cd
 WHERE cd.posted_at IS NOT NULL
   AND cd.extracted_data->>'rawText' ~* '(amount|balance)[^a-z]{0,3}(due|owing|payable)|totaal|te betaal|to pay'
   AND cd.extracted_data->>'rawText' ~* '(^|[^a-z])total'
 ORDER BY cd.posted_at DESC;
```

## Round 13 (review of `43f114aae`: 1 HIGH · 1 MEDIUM · 1 LOW)

### Why the gate now measures AMOUNTS, not labels — read this before adding a label anywhere

Rounds 8–12 each closed the second-label defect by adding the labels the last reviewer found to
`TOTAL_PATTERNS` / `PAYABLE_LABEL`, and each next reviewer found more that posted a wrong number. The
reason is structural: the gate measured "unambiguous" as "one distinct total CANDIDATE", and the
candidate set is defined by LABELS. A payable printed under a label the vocabulary lacks is not a
candidate, so the slip looks as if it prints one total and posts it. The label set has no end — this is
the census-by-spelling failure applied to receipt labels. The gate now also asks a question that needs
no vocabulary: **is any figure printed on the document larger than the total read?** The payable of a
purchase is the largest figure it prints, so a larger one is a figure the reader did not account for,
whatever it is labelled. It is a REFUSAL only; nothing it finds is ever offered as the payable. The one
ordinary exception is cash, and it is the only vocabulary left in the decision: a tender whose NEXT
printed figure is on a change line (`Change`/`Chg`/`Wisselgeld`/`Kleingeld`) with tender − change =
total. A change spelling it lacks can only refuse. **Do not close a posting defect by adding a label:
`PAYABLE_LABEL` now only improves the guess on the capture screen.**

### HIGH-1 — a payable under an unknown label posted the `Total` above it

**Fixed** in new `ocrLargerFigure.ts` (`unexplainedLargerFigure`), consumed by
`unattendedPostingRefusal` and `isAmbiguousTotal` (so the AP routes hold the same slips), and surfaced by
the reader as a warning under `UNRECONCILED_WARNING` (`largerFigureWarning`) so the person on the
capture screen is told and a stored document carries it. A figure needs a decimal part (registration,
card, slip and phone numbers stay out); a date run (`01.09.2026`) and a rate (`15.00%`) are refused; a
space-grouped figure (`1 265.00`) is read as thousands only at the END of its line, because mid-line the
same shape is an item row's quantity and unit price (`USB Cable 1 149.00 149.00`).

Measured (real `extractFromText` + `shouldAutoPostReceipt`, and the AP routes' own
`computePipelineConfidence` / `determineApprovalRoute` / `isAmbiguousTotal`, supplier match 1.0): on
`Sub Total 200 / VAT 30 / Total 230 / Gratuity 23 / <label> 253`, all 14 labels — `AMT DUE`, `BAL DUE`,
`TOT DUE`, `Please Pay`, `Payment Due`, `Outstanding`, `Balance Outstanding`, `Verskuldig`, `Te Betale`,
`Card Amount`, `SALE`, and the three former exclusions `Amount Paid`, `ZAR`, `PURCHASE` — plus
`Tip 23 / CARD 253`, went from **post R230 / auto_approve R230** at `43f114aae` to **refuse /
manual_review**. The reviewer's three counter-checks hold: N5 (`CASH 50 / CHANGE 27` on 23) posts, N1
(`CARD 142.98` equal) is not refused by this rule (it still refuses on its VAT label), and
`Amount Paid 0.00` above `Balance Due 1150.00` is not refused — all pinned in
`k076-larger-figure.test.ts`.

**Deliberate widening, by measurement.** The brief specified figures printed BELOW the total. That
rule was run (gate restricted to the text after the total, reader warning removed) and two corpus rows
then post **R230.00 of R253.00**: a payable under an unknown label ABOVE a VAT-analysis block
(`SALE 253.00 / CARD 253.00 / VAT ANALYSIS / Sub Total 200 / VAT 30 / Total 230`), and the same with
`CASH 300 / CHANGE 47` — the A1 layout with the `TOTAL` label spelled differently. So the scan covers
the whole document. Its extra cost is exactly the rows listed under "over-refusal" below that print a
larger figure above the total.

### MEDIUM-1 — the round-12 vocabulary made the guess R0.00 / R45.00

- Bare `Balance` is **removed** from `PAYABLE_LABEL` rather than scoped: HIGH-1 no longer depends on the
  vocabulary, and bare `Balance` was the only round-12 addition that produced a regression (`BALANCE
  0.00`, `Smart Shopper Balance 45.00`, `Balance 500.00` brought forward). `TOTAAL`, `TO PAY`,
  `TE BETAAL` and `TTL` stay: measured, none moved any row the wrong way, and each makes the guess the
  printed payable where a plain `Total` is above it. The one row that loses is `U "Balance"`, whose guess
  is now 230 (as at `0545d19e3`) — it refuses, and the reader's new warning names 253.00.
- `extractTotalCandidates` drops a zero or negative figure beside a positive one. All-negative
  documents keep their figures: a credit note's sign is what the reader reports and the gate refuses on.
- `validateReceiptExtraction` refuses a total of zero or less ('totalAmount must be positive'); it runs
  before any write in `receipt-to-journal`, so the 400 commits nothing.

Measured, `43f114aae` → now: P1 paid invoice (`… Total 1150 / Amount Paid 1150 / Balance Due 0.00`)
total **0 → 1150**, refuse → post; P2 `TOTAL 23 / CARD 23 / BALANCE 0.00` **0 → 23**, refuse → post; P3
`Balance 500.00` above the invoice refuse → post at 1150; P4 `Smart Shopper Balance 45.00` **45 → 23**,
still refuses (45.00 is a larger figure — see the over-refusal list). On the AP routes P1–P3 move
manual_review → auto_approve at the right figure, so paid invoices no longer override `auto_publish`.

### LOW-1 — the corpus

Recounted from the file: at `43f114aae` the corpus had **71 rows** (not 74), and on the AP routes 40
rows moved to review (not 27; 6 of them wrong figures). This round adds 67 rows — **138 rows** now:
18 `L` (unknown labels, above and below), 4 `T` (tender/change both directions), 4 `P` (paid invoice,
zero balance, balance b/f, loyalty balance), 4 `Z` (pinned over-refusals), 3 `D5b–D7b` twins, and 34
`R` ordinary receipts and invoices (card, cash and change, `Cash Tendered / Change Due`, comma
decimals, space-grouped thousands, `TOTAL (VAT INCL)`, `Amount Excl/Incl VAT`, `VAT @ 15%`, fuel with
litres, loyalty points, bank details, remittance slip, delivery line, a zero tip line). Ordinary
documents (N, R, P, and the two posting T rows) are now 48 of 138 — still a minority, stated rather than
dressed up; the adversarial rows are the history of this item and are kept.

**Measured over the corpus, `43f114aae` → now:** receipt gate 27 rows post → refuse, **18 of which
posted a wrong figure at `43f114aae`**; 3 rows refuse → post (P1–P3, each posting its payable); **0 wrong
posts now** (18 before). AP routes: 30 rows change — 27 to manual_review (18 were approving a wrong
figure) and P1–P3 to auto_approve. Posting now 55 / 138 (was 79), AP auto-approve 59 / 138 (was 83).

**Over-refusal, all of it** (the 9 post → refuse rows that were not wrong at `43f114aae`):
- D5–D7: OCEAN's R200.00 line item printed on a R100.00 slip — an impossible fixture; outcome flipped to
  refuse and consistent twins D5b–D7b added, which post, so every `VAT-0.00` spelling is still pinned
  posting.
- T tender with no change line, T change that does not net: refused by design.
- Z promotion (an item dearer than the slip), Z invoice with a line discount (`Widget 1200.00 /
  Discount -200.00 / Total 1150.00`), Z two-column item `Chicken Braai Pack 1 200.00` (quantity + a
  3-digit price at line end reads 1 200.00), and P4/Z "you saved" or loyalty balances larger than the
  total. Each refuses; none posts wrong. Of the 34 `R` ordinary rows, 33 post; R28 (a tip inside the
  total) refuses on the pre-existing reconciliation rule, unchanged by this round.

### Round-13 limits, disclosed

- A figure printed WITHOUT a decimal part (`CARD 253`) is not seen; tills print cents, and admitting
  integers would count registration, card, slip and phone numbers.
- A space-grouped payable in the MIDDLE of a line (`Please Pay 1 265.00 Tip 115.00` on one OCR line) is
  read as 265.00.
- A slip that prints a figure under a change label that is not the change given (`Amount Due 253.00 /
  Change 23.00` beneath `Total 230.00`) is explained away; tender-then-change must be adjacent figures,
  which is the tightest shape an honest cash slip satisfies.

### Mutations, round 13 (file copies, restored and byte-compared; `<scratchpad>/agents/fix-k072j/mutate.py`)

Suite per mutation: the eight k076 unit files + `receipt-to-journal.test.ts`, 516 tests, green at rest.

| # | Mutation | Outcome |
|---|---|---|
| M1 | gate drops the larger-figure check | RED (1) |
| M2 | reader drops the larger-figure warning | RED (1) |
| M3 | `isAmbiguousTotal` drops the larger-figure check | RED (1) |
| M4 | no tender/change exemption | RED (11) |
| M5 | change may be ANY later figure, not the next | RED (1) |
| M6 | change label not required | RED (1) |
| M7 | no space-grouped reading at line end | RED (3) |
| M8 | space grouping read mid-line too | RED (24) |
| M9 | decimal part optional | RED (56) |
| M10 | a negative figure kept beside a positive | RED (1) |
| M10b | a zero figure counted as positive | RED (3) |
| M11 | negatives always dropped (credit notes) | RED (3) |
| M12 | validation accepts a total ≤ 0 | RED (1) |
| M13 | bare `Balance` restored | RED (2) |
| M14 | a figure EQUAL to the total counted as larger | RED (83) |

### Historical impact

Not measured — production must not be queried from here. Documents already auto-posted or
auto-approved whose stored text prints a figure larger than the posted total are the population; the
SQL below lists candidates for Hein to re-run through `unexplainedLargerFigure`:

```sql
SELECT cd.id, cd.company_id, cd.posted_at,
       cd.extracted_data->>'totalAmount' AS stored_total,
       cd.extracted_data->>'rawText'     AS raw_text
  FROM captured_documents cd
 WHERE cd.posted_at IS NOT NULL
   AND cd.extracted_data->>'rawText' IS NOT NULL
   AND cd.extracted_data->>'rawText' <> ''
 ORDER BY cd.posted_at DESC;
```

## Round 14 (review of `14e979376`: 2 HIGH · 2 MEDIUM · 1 LOW) — the policy changes

### DECISION — the text fallback never posts or approves unattended (orchestrator, recorded for Hein)

**Decision.** Figures recovered by the regex/OCR FALLBACK never auto-post and never auto-approve, on
any path. The fallback still produces a best-guess total for a person to confirm. Unattended posting
and approval stay possible only for a structured VLM extraction (`extractionMethod === 'vlm'`) that
also passes the existing unambiguity gate. A stored extraction with no method, or `'vlm+regex'`, is
treated as fallback.

**Reason.** This is the fifth round in which the "is this free text unambiguous" classifier was beaten
by a realistic slip: section totals, a VAT analysis under the tender, unknown payable labels, a `Chg`
read as change, split tenders under a tip, a trailing-minus refund. Each fix closed the named layouts
and the next reviewer found another, so the patching stopped.

**Cost.** `VLLM_BASE_URL` is set in production, so the fallback runs only when the VLM fails or returns
nothing (`ocrService.extractFromPdf`). Those documents now go to manual review or stay a draft instead
of posting. Image receipts were already refused unattended, because they have no text to re-read. On
the corpus the fallback path goes from 87 auto-posts and 94 auto-approvals to 0 and 0. The same
figures read by the VLM post 62 and approve 66, with 0 wrong.

**Paths changed** (census from every consumer of `extracted_data` / `extractFrom*`. The routes that
decide without a person are the four below; `doc-auto-invoice`, `document-capture(-action)`,
`vlm-extract` and `captureRouterService` only read, store or prefill):

| Path | Decides via | Change |
|---|---|---|
| `receipt-to-journal` (auto-post journal) | `shouldAutoPostReceipt` → `unattendedPostingRefusal` | fallback refused |
| `capture/[id]/post-expense` (petty-cash journal) | `pettyCashJournalService` → `shouldAutoPostReceipt` | fallback refused |
| `ai-invoice-pipeline` (AP auto-approve) | `refusesUnattendedApproval` (new) | fallback → `manual_review` |
| `capture/[id]/post` (AP auto-approve and `auto_publish`) | `refusesUnattendedApproval` (new) | fallback → `draft`, overriding `auto_publish` |

### HIGH-2 — credit, refund and return documents, VLM path included

`isCreditNote` now also refuses when either of these holds:
- the total is negative, whatever read it;
- `creditIndicators.hasCreditIndicator` finds a credit indicator in the text.

Each indicator is anchored where it can only describe the DOCUMENT:
- a `CREDIT (NOTE)` / `KREDIETNOTA` / `REFUND (SLIP)` / `RETURN(S) (SLIP)` / `TERUGBETALING` header on
  a line of its own;
- `REFUND(ED)` / `TERUGBETAL…` on a line that carries a money figure;
- a figure the size of the total printed with a trailing minus, a glued minus or parentheses. A spaced
  dash stays a label separator, as `VALUE_SEP` reads it.

Both AP routes and both receipt paths take it. On the VLM path, a document with no text can still be
refused by the stored `documentType` and a negative total.

Guards fail in both directions, all pinned in `k076-round14-policy.test.ts` and posting in the corpus:
- `Credit card surcharge 15.00`
- `VISA CREDIT 23.00`
- `NO REFUND WITHOUT SLIP`
- a refund-policy footer with no figure
- `Acc Type: CREDIT`
- a spaced-dash invoice
- `Delivery Note No:`

On the reviewer's 16 ordinary receipts, 0 moved.

### HIGH-1 — zeros only

`extractTotalCandidates` drops a zero beside a non-zero figure and KEEPS negatives. `TOTAL -499.00 /
Refund Total 499.00` now yields `[-499, 499]` and refuses. As the reviewer measured, 0 corpus or
ordinary rows moved. The overpaid-invoice assertion is inverted: `[1150, -50]`, which refuses.

### MEDIUM-1 — `Chg` removed. MEDIUM-2 and LOW-1 closed rather than left to the policy

Under the policy these only matter for a VLM extraction. The reviewer's inputs were run as a VLM
extraction holding the same figures as the reader, and some still posted, so they are closed:
- `Chg` is removed from `CHANGE_LABEL`.
- Change now explains a figure only after a CASH tender (`Cash`/`Tender(ed)`/`Kontant`): a card gives
  no change (H4).
- The space-group `\s*$` anchor is dropped: a grouped figure is read as thousands when it is the last
  figure on its line.
- New `adjustmentAfterTotal`: after the printed total, a positive tip / gratuity / `Fooi` / service or
  delivery charge, or any figure printed NEGATIVE, refuses. It is taken by the gate and
  `isAmbiguousTotal`. This closes the split tender under a tip (H15–H17), a tip from cash change (H14),
  a discount after the total (H19), and the integer / `253 00` / `253.OO` / mid-line `1 265.00` payables
  (G1–G5), because each prints its gratuity or delivery after the total.

**Every reviewer input, does it auto-post or auto-approve on any path now?**
- Fallback path: **no, all 70**.
- The same figures as a VLM extraction:
  - all 5 refund variants (R2, R3, R5, R6, R9), R10 and S4/S6/S7/S8: refuse on both routes;
  - the Svc Chg slips H1–H3: refuse;
  - split tender plus tip H15–H17: refuse;
  - `AMT DUE 1 265.00 ZAR` (G6 and G7/G9/G10 likewise): refuse;
  - `253 00` (G3) and `253.OO` (G4): refuse;
  - still posting: **H8, H9, S14, each at its correct payable**.

**Before → after, measured** (real `extractFromText`, `shouldAutoPostReceipt`, and the AP routes'
`computePipelineConfidence` / `determineApprovalRoute` / `refusesUnattendedApproval`, supplier
match 1.0; `<scratchpad>/agents/fix-k072j/r14-{before,now}.jsonl`):

| Input set | `14e979376` post / approve / wrong | now fallback | now as VLM post / approve / wrong |
|---|---|---|---|
| corpus, 177 rows | 87 / 94 / 25 posts, 28 approvals | 0 / 0 | 62 / 66 / 0 |
| reviewer probes, 44 | 24 / 25 / 20, 21 | 0 / 0 | 3 / 3 / 0 |
| reviewer refunds, 10 | 5 / 7 / 5, 7 | 0 / 0 | 0 / 0 / 0 |
| reviewer ordinary, 16 | 4 / 8 / 0 | 0 / 0 | 4 / 8 / 0 (gate passes 10, unchanged) |

Over-refusal of the new rules:
- On the 138 rows that existed at `14e979376`, as a VLM extraction: **0 moved**.
- On the reviewer's ordinary 16: 0.
- Two slips now refuse by design:
  - H13, `CASH 207.00 / CHANGE -23.00`: a negative figure after the total;
  - my own guard V6, `Staff Discount -23.00` after the total.

The corpus gains 39 rows:
- F1–F14: refunds, returns and Kredietnota.
- M1–M18: charges and deductions around the total.
- V: 7 ordinary purchases carrying credit/charge words, which post.

### Tests pin the policy

- The corpus test asserts, on EVERY row, that the regex extraction neither posts nor approves.
- `k076-round14-policy.test.ts` pins that a fallback read passing every other check still refuses,
  while the same figures read by the VLM post.
- Integration covers all four paths:
  - `receipt-to-journal`: structured `posted`, fallback `draft`;
  - `post-expense`: structured `posted`, fallback `draft`;
  - `capture/[id]/post`: fallback `draft` against the structured `approved`;
  - `ai-invoice-pipeline`: fallback `draft` against the structured `approved`.
- Three gate-arithmetic unit helpers and the post-expense unit fixture now declare `extractionMethod:
  'vlm'`: their subject is the arithmetic, not the method.

### Mutations, round 14 (file copies, restored byte-identical; `<scratchpad>/agents/fix-k072j/mutate14.py`)

| # | Mutation | Outcome |
|---|---|---|
| P1 | gate drops the fallback refusal | RED (64) |
| P2 | `refusesUnattendedApproval` drops the fallback check | RED (68) |
| P3 | only an explicit `'regex'` counts as fallback | RED (1) |
| P4 | `ai-invoice-pipeline` approves fallback reads | RED (1, integration) |
| P5 | `capture/[id]/post` approves fallback reads | RED (1, integration) |
| C1 | `isCreditNote` drops the text indicators | RED (5) |
| C2 | `isCreditNote` drops the negative total | RED (1) |
| C3 | credit header not anchored to its own line | RED (9) |
| C4 | no refund word on a figure line | RED (1) |
| C5 | trailing minus not a sign | RED (1) |
| C6 | parentheses not a sign | RED (1) |
| C7 | spaced dash read as a sign | RED (3) |
| N1 | negatives dropped beside a positive | RED (2) |
| L1 | `Chg` restored as change | RED (1) |
| L2 | change accepted after any tender | RED (2) |
| L3 | space group anchored to line end | RED (1) |
| A1 | no charge-after-total check | RED (10) |
| A2 | no deduction-after-total check | RED (2) |
| A3 | AP ambiguity ignores adjustments | RED (10) |
| A4 | adjustment read from the whole document | RED (2) |

### Round-14 limits, disclosed

- The VLM path is only as corroborated as its `rawText`. A VLM-read image has none, and is refused on
  the receipt paths as before. On the AP routes, only the stored `documentType`, a negative total and
  the stored warnings can refuse it.
- `adjustmentAfterTotal` names its additions, so a vocabulary gap is possible here: a split-tender slip
  whose tip is printed under a name outside `Tip`/`Gratuity`/`Fooi`/`Service …`/`Svc`/`Delivery`
  still posts the pre-tip total as a VLM extraction. The fallback path refuses it by policy.
- Production impact is not measured; the round-13 SQL still applies, plus
  `extracted_data->>'extractionMethod' IS DISTINCT FROM 'vlm'` for fallback documents already posted.

---

## Round 15 — the two vocabularies of `review-k072-r14.md`, replaced by rules

The round-14 policy itself survived the blind review intact: fallback figures reach none of the four
paths, there is no fifth path, the `'vlm'` marker cannot be spoofed, and all ten mutations were caught.
What was still broken was the part that runs ON the VLM path — the two vocabularies. This is the sixth
round in which adding words has failed, so neither is extended. Each is replaced by a rule.

### HIGH-1 — a charge after the total, found by ARITHMETIC (`ocrLargerFigure.ts`)

`SERVICE 10% 23.00 / VISA 126.50 / MASTERCARD 126.50` under a total of 230.00 asks for 253.00.
`ADDITION_LABEL` did not know bare `Service` (nor `Waiter`, `Freight`, `Shipping`, `Handling`,
`Courier`, `Surcharge`, `Levy`), and because the payment was SPLIT no single printed figure exceeded
the total, so `unexplainedLargerFigure` found nothing either.

New `unsettledTender(text, total)`: **what the document was paid must equal the total it prints.**
Tenders printed after the total are SUMMED; change is subtracted only where a CASH tender is printed
(only cash gives change — `CARD 253.00 / Change 23.00` stays a mislabelled tip); a cent of rounding is
allowed. Where no payment is printed at all, any non-zero figure after the total that is not the total
is unexplained, which is what catches the same slip with no tender line. The gate refuses on it, and
`isAmbiguousTotal` refuses the AP routes on it.

The one vocabulary this needs is `TENDER_LABEL` — the ways a country pays, a closed set, where the
names of a charge have no end. `Account` is deliberately outside it: `Account Balance 12 345.67` on a
trade slip is not a payment. **Disclosed limit:** a payment spelling missing from `TENDER_LABEL`
UNDER-refuses (the figure is simply not counted), which is the opposite direction from the rest of
this file. `unexplainedLargerFigure` still covers the single-figure case.

`ADDITION_LABEL` is KEPT, unextended and no longer load-bearing. Deleting it would regress a pinned
case — `Total 230.00 / Gratuity 23 / AMT DUE 253`, whole rands, which `FIGURE` does not read — and it
only ever refuses. Every input the reviewer measured is now caught by the arithmetic, not by it.

### HIGH-2 / MEDIUM-1 / MEDIUM-2 — a credit word anywhere, by COST ASYMMETRY (`creditIndicators.ts`)

Rounds 12–14 anchored each indicator to a position where it could only describe the document. Every
anchor was beaten on the first attempt: `REFUND SLIP 0012` and `KREDIETNOTA Nr KN00123` print the
number BESIDE the word so the line is not the header alone and carries no cents; `TERUGBETAL\w*` never
matched *terugbetaal*; `VOID`, `REVERSAL`, `CANCELLED SALE` and `GOODS RETURNED` were not in the
vocabulary; `CRED1T NOTE` is what the scanner made of it.

A refusal costs a person a few seconds; a wrong-direction post moves money silently. So a credit word
ANYWHERE, as a whole word, case-insensitive, Afrikaans included, refuses. The scanner substitutions
(0/O, 1/I/l, 5/S) are applied MECHANICALLY by `ocrTolerant` to each plain word, so nobody hand-spells
`CRED[I1l]T` and gets one of them wrong — which is exactly how `TERUGBETAL` came to miss its second A.

The carve-back is `BENIGN_PHRASES` — never a bare word, because a bare word is the anchor that failed.
Each was measured on the ordinary corpus before it was added: `credit card`, `visa/master credit`,
`credit limit|application|controller|terms|account|balance`, `Acc Type: CREDIT` (a card slip; the r8
corpus row `V5`), `on credit`, a no-refund footer, a refund/returns policy sentence, `goods may be
returned`, `exchange rate`, `Less credit note … applied` (the review's LOW-1), and a bare `RETURNS`
heading immediately above a policy line (the review's other over-refusal). The phrases are scrubbed out
and the words looked for in what is left; the `RETURNS` heading is scrubbed FIRST because the policy
sentence its lookahead reads would otherwise already be blank. `CREDITOR` is deliberately not a credit
word — a supplier statement heading is not a credit note.

### Measured, before and after (extraction stamped `'vlm'`, the path in play)

| Set | rows | auto-posts | auto-approvals | WRONG posts | WRONG approvals |
|---|---|---|---|---|---|
| `k076-slip-corpus.ts` | 177 | 62 → **62** | 66 → **66** | 0 → 0 | 0 → 0 |
| r13 reviewer probes | 44 | 3 → **2** | 3 → **2** | 0 → 0 | 0 → 0 |
| r13 refund probes | 10 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 |
| r13 ordinary receipts | 16 | 4 → **4** | 8 → **8** | 0 → 0 | 0 → 0 |
| r14 reviewer credit probes | 29 | 13 → **1** | 15 → **1** | **13 → 1** | **15 → 1** |
| r14 reviewer charge probes | 33 | 18 → **0** | 18 → **0** | **18 → 0** | **18 → 0** |
| r14 reviewer ordinary probes | 12 | 8 → **9** | 9 → **10** | 0 → 0 | 0 → 0 |
| r15 charge probes (9 names × 4 tenders) | 36 | 9 → **0** | 9 → **0** | **9 → 0** | **9 → 0** |

**The over-refusal cost of this round is zero, and it gives one back.** The 16 ordinary receipts are
unchanged at 4 auto-posts and 8 auto-approvals (12 of 16 still refuse to post, 16 of 16 on the
fallback, both unchanged from round 14 and still Hein's call); the corpus is unchanged at 62/66; the
r14 ordinary probes gain one, the `RETURNS` policy footer that round 14 over-refused. The only
regression in either direction is r13 probe `H9` — `CASH 250 / CHANGE 20 / REPRINT / CASH 300 /
CHANGE 70`, a reprinted duplicate tender block, which the sum now refuses. That is the cheap direction.

The one remaining WRONG row is the r14 probe `C negative stored total only`, whose text is an ordinary
positive purchase (`Kettle 499.00 / VAT 65.09 / TOTAL 499.00`) with no credit signal in it at all; the
credit is only in the VLM's stored NEGATIVE total, which `isCreditNote` refuses on and the probe
harness never sets. It is a harness artefact, not a defect.

### Mutations — 7, all caught, files restored byte-identically (`md5sum -c`)

| # | mutation | result |
|---|---|---|
| M1 | the tender sum never disagrees with the total | RED (29) |
| M2 | a tender label printed AFTER its figure is ignored | RED (9) |
| M3 | no tender printed means nothing to explain | RED (9) |
| M4 | `ocrTolerant` returns the word unchanged (no OCR damage) | RED (3) |
| M5 | the credit word must be the whole line (the r14 anchor) | RED (14) |
| M6 | no benign phrase is carved back | RED (17) |
| M7 | the `RETURNS` heading phrase is scrubbed LAST, not first | RED (1) |

### Gates

`env -u DATABASE_URL bun run ci` → 15 checks PASS, `Test Files 806 passed | 36 skipped (842)`,
`Tests 10105 passed | 234 skipped (10339)`, component 62/418, build PASS, `all checks passed`,
`CI_EXIT=0`. Integration `tests/integration/k072-*.int.test.ts` → 7 files / 58 tests passed,
`INT_EXIT=0`.

**Migration:** none. **Historical data:** unchanged — these defects mis-READ documents at capture time
and leave no marker, so the round-13 impact SQL is still the only detection available. **Rollback:**
revert the commit.

---

## Round 16 — auto-posting becomes a WHITELIST, measured over the whole document

Seven rounds have now been beaten, and every one of them by a rule that read a POSITION. Round 15's
tender arithmetic read only `text.slice(end)` — the text below the printed total — so the round-15
review beat it three ways with that fact alone, and the credit rule was still a word list. **This round
does not add a rule; it changes the shape of the decision.** A VLM extraction may auto-post or
auto-approve only when the document RECONCILES END TO END, and anything else goes to a person.

`unreconciledFigure(text, total, {subtotal, vatAmount})` replaces `unsettledTender` and is measured over
the WHOLE document:

1. **the payments sum to the total**, wherever on the page they are printed, less change and only where
   a CASH tender is printed — only cash gives change;
2. **no figure is larger than the total** except one exactly equal to it (a repeated total, an
   amount-due box) or one the payment sum already accounted for (`CASH 300.00` / `CHANGE 47.00`);
3. **nothing below the total block is unexplained** — not a payment, not change, not zero, not the
   total again, and not the net or the tax the reader itself extracted (a VAT recap or a tax-analysis
   block, which is what an ordinary supplier invoice prints there).

The gate's existing conditions stand in front of these: `subtotal + VAT = total`, one printed total, a
positive total, a VAT figure the text corroborates, no credit signal, and the round-14 fallback policy.

**Rule 3 is what makes `TENDER_LABEL` non-load-bearing in the dangerous direction.** A payment rail this
file has never heard of leaves the CHARGE beside it unexplained below the total, so the document refuses
whether or not the rail was recognised — verified on all 18 of the review's rails (MEDIUM-2 under) and
all 14 of its charge names (LOW-1). The vocabulary now only ever buys an ordinary slip back.

| Finding | Disposition |
|---|---|
| HIGH-1 split tender printed ABOVE the total | FIXED. `VISA 126.50 / MASTERCARD 126.50 / Sub Total 200 / VAT 30 / Total 230` → `paid 253.00`. Position-independence is the fix, as the review said. |
| HIGH-2 13 of 14 credit abbreviations posted | FIXED. `CREDIT_ABBREVIATIONS`: `CR[\s./-]*N(OTE)?`, `C/N`, `CRN`, `RTN`, `CANX`, `R/A`, `ADJUSTMENT NOTE`, `DEBIT NOTE`, plus `RETOUR`/`RETOURE` as words and `(CR)` bracketed. All 18 credit probes refuse. |
| MEDIUM-1 fix.md's "cost is zero" was false off the corpora | FIXED — the cost is measured and stated below, and it is no longer the round-15 number. |
| MEDIUM-2 `TENDER_LABEL` gaps, both directions | FIXED. The rails are added (`Ozow`, `PayShap`, `SCode`, `Scan to Pay`, `Capitec/Apple/Samsung/Google/FNB/Nedbank/Absa/Standard Bank/Mobile/Instant Pay|Money|EFT`, `Points`, `Loyalty`, `eBucks`, `UCount`, `Miles`) AND rule 3 makes the list non-load-bearing. |
| LOW-1 a charge printed BELOW the tender line | FIXED by rule 3 — the stray check no longer stops once a tender is found. |
| r14 `C negative stored total only` | Round 15 called it a harness artefact and the reviewer agreed; the orchestrator ruled it a real bug and it is fixed at source. See below. |

### ~~Why the abbreviation set is closed~~ — WITHDRAWN in round 17

This subsection argued that the credit abbreviations form a closed set because each contracts a word
already listed. **That claim was false and is withdrawn.** The round-16 review posted 20 of 36 credit
markings, half of which contract nothing (`OMRUIL`, `TERUGGAWE`, `KORREKSIE`, `ALLOWANCE NOTE`,
`NEGATIVE SALE`, `NO SALE`), and the Sage/Pastel bare `CR` was missing despite being the most common
contraction of all. See round 17. `DEBIT NOTE` stays in, for the reason given there.

### Two structural carve-backs, not more phrases

- **The vendor identity is scrubbed first.** `Credit Solutions SA`, `Refund Recovery Services` and
  `Shop 5, The Exchange, Sandton` were all read as credit notes. The extracted `vendorName` and
  `vendorAddress` are blanked out of the text before the words are looked for, so a credit word inside
  the supplier's own name says nothing about the document — while a `CREDIT NOTE` header printed by that
  same supplier still refuses (pinned).
- **A payment word must be LABELLING the figure beside it.** `TENDER_CONNECTOR` allows only separators,
  a currency mark and the handful of nouns a till prints inside a tender line (`Card Amount 449.50`).
  Without it, `Credit card surcharge 5.00`, `points balance 1 250.00` and a mouse called `MX Master 3S
  1 899.00` were each summed as payments, and refused three ordinary slips. Its failure direction is
  safe: an unlisted connector only stops a figure counting as a payment, and rule 3 then refuses.

### The negative VLM total, fixed at source

`parseVlmResponse` stored the model's figures with their sign. Round 15 relied on that sign reaching
`isCreditNote`, and it does — but a negative total also reaches the journal builders, where it posts a
purchase backwards rather than refusing, and every capture screen shows a negative payable. The sign is
a CLASSIFICATION, so it is converted into one, once: `documentType = 'credit_note'` and the figures are
stored positive. The credit refusal is kept — by the type now, not by the sign. Pinned end to end
through `extractWithVlm` with a stubbed model (`k072-vlm-negative-total.test.ts`).

### THE COST, stated plainly — head vs its two parents, extraction stamped `'vlm'`

`r14` = `cd1d2b452`, `r15` = `8cda2e5e4`, `r16` = this commit. WRONG = auto-posted at an amount that is
not the payable.

| Set | rows | posts r14 → r15 → **r16** | approvals r14 → r15 → **r16** | WRONG posts |
|---|---|---|---|---|
| `k076-slip-corpus.ts` | 177 | 62 → 62 → **61** | 66 → 66 → **64** | 0 → 0 → **0** |
| r13 ordinary receipts | 16 | 4 → 4 → **4** | 8 → 8 → **6** | 0 → 0 → **0** |
| r13 reviewer probes | 44 | 3 → 2 → **2** | 3 → 2 → **2** | 0 → 0 → **0** |
| r13 refund probes | 10 | 0 → 0 → **0** | 0 → 0 → **0** | 0 → 0 → **0** |
| r14 credit probes | 29 | 13 → 1 → **1** | 15 → 1 → **1** | 13 → 1 → **1** |
| r14 charge probes | 33 | 18 → 0 → **0** | 18 → 0 → **0** | 18 → 0 → **0** |
| r14 ordinary probes | 12 | 8 → 9 → **9** | 9 → 10 → **10** | 0 → 0 → **0** |
| r15 own charge probes | 36 | 9 → 0 → **0** | 9 → 0 → **0** | 9 → 0 → **0** |
| **r15 reviewer — under-refusal** | 40 | 35 → 32 → **0** | 35 → 32 → **0** | **35 → 32 → 0** |
| **r15 reviewer — credit** | 18 | 14 → 13 → **0** | 17 → 13 → **0** | **14 → 13 → 0** |
| **r15 reviewer — ordinary** | 24 | 22 → 8 → **19** | 22 → 8 → **19** | 0 → 0 → **0** |

**The whitelist does NOT refuse most ordinary receipts, and it gives back most of what round 15 took.**
On the reviewer's 21+3 ordinary documents, round 15 refused 14 that had posted on round 14; round 16
posts 19 of 24, recovering 11 of those 14 — because the phrase list is no longer doing the work
(identity scrub) and a payment word no longer captures a figure it is not labelling. The remaining
round-16 cost against round 15 is **1 corpus post, 2 corpus approvals and 2 of the 16 ordinary receipts'
approvals** (no ordinary receipt lost an auto-POST). Every one of those is rule 3.

**The shapes that now refuse, named:**

| shape | example | refusal |
|---|---|---|
| a loyalty savings line below the total | `CARD 69.98 / ClubCard Points Earned 7 / You saved R5.00` (corpus `R3`) | `prints 5.00 below its total, which nothing explains` |
| a MIXED-basket VAT analysis whose recap figures are not the net | `VAT ANALYSIS / Std Rated Incl 137.98 / Zero Rated 52.98` on a 190.96 total (`O1`) | same |
| a rewards line below the total | `WRewards savings 12.00` (`O2`), `You saved 10.00` (`O14`) | same |
| a foreign-currency line below the total | `USD 12.50 @ 18.40` | same |
| SA cash rounding without a change line | `TOTAL 24.97 / ROUNDING 0.03 / CASH 25.00` | `paid 25.00, not the total read` |
| a credit word in the vendor identity the READER failed to extract | address `The Exchange`, vendor `Refund Recovery Services` | credit note |

The last row is a measurement artefact of the probe harness, not of the path in play: the carve-back
scrubs the EXTRACTED identity, the probes run the regex reader (which extracts no address at all and
mis-read that vendor as `Receipt No: 004512`), and on the VLM path — the only path that can auto-post —
both fields are populated by the model. Pinned directly: with the identity supplied, both are ordinary
purchases; without it, both are credits.

A single corpus row changed its pinned outcome, `R3 Clicks, points and savings`, from `post` to
`refuse`, annotated in place. The corpus invariant — a slip either refuses, or posts exactly its payable
— still holds on all 177.

### Mutations — 9, all caught, files restored byte-identically (`md5sum -c`)

Two survived the first sweep and are recorded because the tests that kill them were written afterwards:
N2 (the larger-than-total arm) was masked by `unexplainedLargerFigure`, which the gate still calls, and
N5 (last vs first printed total) needed a two-item basket under a header amount-due box.

| # | mutation | result |
|---|---|---|
| N1 | the payment sum reads only the text BELOW the total (round 15) | RED (2) |
| N2 | no figure may be larger than the total | RED (1) |
| N3 | nothing below the total block is checked | RED (27) |
| N4 | the net and the tax do not explain a figure below the total | RED (1) |
| N5 | the FIRST printed total ends the block, not the last | RED (1) |
| N6 | any payment word before a figure labels it | RED (2) |
| N7 | the credit abbreviations are dropped | RED (11) |
| N8 | the vendor identity is not scrubbed | RED (4) |
| N9 | a negative VLM total keeps its sign and its type | RED (2) |

### Gates

`env -u DATABASE_URL bun run ci` → 15 checks PASS, `Test Files 808 passed | 36 skipped (844)`,
`Tests 10186 passed | 234 skipped (10420)`, component 62/418, build PASS, `[ci] all checks passed`,
`CI_EXIT=0`. Integration `tests/integration/k072-*.int.test.ts` → 7 files / 58 tests passed,
`INT_EXIT=0`.

**Migration:** none. **Historical data:** unchanged — these defects mis-READ documents at capture time
and leave no marker; the round-13 impact SQL is still the only detection available. **Rollback:** revert
the commit.

**Limits, disclosed.** `unexplainedLargerFigure` and `adjustmentAfterTotal` are kept alongside the
whitelist. Both only ever refuse, so they cannot make a document postable; they are retained because
deleting them would drop pinned cases the whitelist reads differently (a whole-rand `Gratuity 23`, and a
tender/change pair separated by another figure). Rule 3's exemption list is the extracted net and tax
only, so a mixed-basket VAT analysis whose recap figures are neither will refuse — that is the largest
single share of the measured cost, and widening it is the first knob to turn if Hein wants the rate back.

---

## Round 17 — the whitelist failing OPEN, closed five ways

Every round-16 finding was the whitelist letting something through because a rule could not SEE it.
This round makes each of them fail closed. No rule was widened to recover an ordinary slip without a
measurement showing no wrong post returned.

| Finding | Disposition |
|---|---|
| HIGH-1 a charge printed without cents | FIXED. `WHOLE_RAND` (`ocrPrintedFigures.ts`) reads a figure printed in whole rands, with or without thousands separators, so all three rules see `SERVICE 23 / AMT DUE 253`. `ADDITION_LABEL` is no longer the only guard on that shape: all 28 of the review's probes refuse with `ADDITION_LABEL` still in place, and the round-17 tests pin the arithmetic, not the label. |
| HIGH-2 20 of 36 credit markings posted | FIXED. Bare `CR` (the Sage/Pastel `TOTAL 499.00 CR`, `Doc Type: CR`), `CN`, `KN`, `K/N`, `OMRUIL`, `TERUGGAWE`, `TERUGSTUUR`, `GOEDERE TERUG`, `KORREKSIE`, `ALLOWANCE NOTE`, `REBATE (NOTE)`, `CLAIM NOTE`, `CORRECTION SLIP`, `NEGATIVE SALE`, `MINUS SALE`, `NO SALE`. Every marking now goes through the SAME mechanical OCR map as the words (`ocrTolerantMarking`), so `CR N0TE` refuses as `CRED1T N0TE` does; `N`/`H` join the map (measured free on every ordinary set, and it closes `RETURH SLIP`). The "closed generator" claim is withdrawn above. All 44 credit probes refuse. |
| HIGH-2, the other way | Bare `CR` does not refuse where it means a card: `CR CARD`, `CARD DR`, `Acc Type: CREDIT` stay ordinary (pinned). The phrase is ONE LINE only — with `[\s./-]` it crossed the newline in `TOTAL 499.00 CR\nCARD 499.00` and scrubbed the Pastel marking it sits beside (measured, then fixed). |
| MEDIUM-1 rule 3 explained by VALUE | FIXED. A figure below the total is explained only by its ROLE: a payment or change line, a zero, a line beginning with the reader's own net/tax/total/payable vocabulary (`SUMMARY_LINE_START`), or a row of a VAT/tax recap block **whose rows add up to the total**. `SERVICE 15.00` (= the VAT), `Car Guard 100.00` (= the net) and `Second table 115.00` (= the total) all refuse. |
| MEDIUM-2 no readable total auto-approved | FIXED. `isAmbiguousTotal` distinguishes "no text" (the VLM image, still let through) from "text with no total candidate" (now ambiguous). A document naming a currency other than the rand refuses on BOTH the AP route and the gate; the pinned case has nothing else wrong with it, so only the currency check can be what refuses it. |
| LOW-1 rule 2's tender exemption wider than its comment | FIXED by narrowing the predicate: a payment or change figure larger than the total is forgiven only when rule 1 RAN AND BALANCED. A `Change 300.00` with no tender now refuses. |

### What the whole-rand reader had to be taught — each item measured, not assumed

The first cut read a whole number anywhere and **refused every document on the branch** (corpus 177 →
1 post): `Invoice No: 88123` and the `2026` of a date were read as amounts larger than the total. So it
is confined to where the hole is — rule 3, below the total block — and to a line that carries no cents
figure. Within that: no leading zero (`Till 04`, `Receipt No: 004512`), at most five digits (`Branch
250655`, `Odometer 145230` — a whole-rand payable above R99 999 is not read here; it prints cents in
practice), no neighbouring `:`/`/`/`-` (dates, times), no document-number label or letter prefix in
front (`Delivery Note No: 4471`, `DN4471`), and it must END its line (`Goods may be returned in 7
days` is prose). Every one of those was a measured over-refusal first.

### Two structural recoveries — and why the loyalty line is not one of them

- **A mixed-basket VAT analysis now posts, recovered by ARITHMETIC.** `VAT ANALYSIS / Std Rated Incl
  137.98 / Zero Rated 52.98` under a total of 190.96 decomposes it exactly, and that sum — not the header
  — is what explains the rows. A charge printed inside the block breaks the sum and refuses (`VAT ANALYSIS
  / Std Rated Incl 230.00 / SERVICE 23.00`, pinned). No wrong post returned on any probe set.
- **Payments that were being read as charges:** `VISA CREDIT 115.00` (a card type between the tender word
  and its figure), `Fleet card R 1 140.47` (the thousands group), `Staff Account`, `On Account`, `Debit
  Order`, `Stop Order`, `Please remit 1148.85`. The tender vocabulary only buys a slip back; a remittance
  for a DIFFERENT amount is a disagreeing payment and refuses (pinned).
- **The loyalty-savings line is NOT recovered, and is left refusing.** `You saved R5.00` and `WRewards
  savings 12.00` carry no role a structural rule can read: a line's arithmetic cannot tell a saving from a
  charge, only its wording can, and a savings vocabulary is exactly the kind of list that failed seven
  times. **This is the shape that will cost volume on grocery till slips, and whether to accept a savings
  vocabulary to recover it is Hein's decision.**

### THE COST — head vs `3a1014154`, extraction stamped `'vlm'`, same harness, both measured this round

"Newly refused" = auto-posted or auto-approved correctly on `3a1014154` and now goes to a person.

| Set | rows | posts | approvals | WRONG posts | WRONG approvals | newly refused | newly passes |
|---|---|---|---|---|---|---|---|
| `k076-slip-corpus.ts` | 177 | 61 → 61 | 64 → 65 | 0 → 0 | 0 → 0 | 0 | 1 |
| r13 ordinary receipts | 16 | 4 → 4 | 6 → 6 | 0 → 0 | 0 → 0 | 0 | 0 |
| **r16 reviewer's 24 ordinary documents** (O1–O24) | 24 | **19 → 20** | 20 → 21 | 0 → 0 | 0 → 0 | 0 | 1 |
| r16 reviewer — all ordinary rows | 34 | 24 → 25 | 25 → 26 | 0 → 0 | 0 → 0 | 0 | 1 |
| **r16 reviewer — under-refusal** | 53 | 39 → 1 | 40 → 1 | **38 → 0** | **39 → 0** | 0 | 0 |
| **r16 reviewer — credit** | 44 | 25 → 0 | 25 → 0 | **25 → 0** | **25 → 0** | 0 | 0 |
| r15 reviewer — under / credit / ordinary | 40 / 18 / 24 | 0 / 0 / 19 → same | 0 / 0 / 19 → same | 0 → 0 | 0 → 0 | 0 | 0 |
| r14 ordinary probes | 12 | 9 → 8 | 10 → 9 | 0 → 0 | 0 → 0 | **1** | 0 |
| r14 credit / charge, r15 own, r13 probes / refunds | 29 / 33 / 36 / 44 / 10 | unchanged | unchanged | unchanged (1 / 0 / 0 / 0 / 0) | unchanged | 0 | 0 |

**One document in 570 is newly refused:** `Refunds within 30 days with this slip 115.00` — a policy
footer that prints the total's amount. It is the direct price of MEDIUM-1: the figure equals the total
and nothing on its line says what it is, which is precisely the shape of `Second table 115.00`. The one
remaining WRONG row is the r14 `C negative stored total only`, whose credit lives only in a negative VLM
total the probe harness never sets; round 16 fixed it at source (`vlmInvoiceService`), pinned end to end.

**The shapes that refuse on the reviewer's 24 ordinary documents (4 of 24):** loyalty savings below the
total (left for Hein, above); SA cash rounding / a rounded total then cash (`ROUNDING 0.03 / CASH 25.00`
— the payments are 25.00 against a total of 24.97, a real 3c disagreement); a discount line above the
total and a zero-rated basket (both refused by the reader's own reconciliation, pre-existing, not by this
file). Round 16's 19 of 24 is now 20 of 24.

### Mutations — 17, all RED, files restored byte-identically (`md5sum -c`)

| # | mutation | result |
|---|---|---|
| R1 | whole rands are never read | RED (29) |
| R2 | whole rands are read everywhere, header included | RED (2) |
| R3 | a whole-rand figure need not end its line | RED (3) |
| R4 | the markings skip `ocrTolerant` | RED (1) |
| R5 | bare `CR` is not a marking | RED (3) |
| R6 | the `CR`/card phrase crosses a newline | RED (1) |
| R7 | `N`/`H` are not lookalikes | RED (2) |
| R8 | a figure equal to the total is explained by value again (round 16) | RED (1) |
| R9 | the recap block is ignored | RED (3) |
| R9b | a recap header explains its rows without their sum | RED (1) |
| R10 | text with no total is unambiguous again | RED (1) |
| R11 | the AP route does not refuse a foreign currency | RED (1) — survived the first sweep; the test that kills it (currency the ONLY defect) was added |
| R12 | rule 2 forgives every payment figure (round 16) | RED (1) |
| R13 | a digit run may not sit between a tender word and its figure | RED (2) |
| R14 | a summary line does not explain its figure | RED (2) |
| R15 | the gate does not refuse a foreign currency | RED (2) |
| R16 | a debit order is not a payment | RED (1) |

### Gates

`env -u DATABASE_URL bun run ci` → 15 checks PASS, `Test Files 809 passed | 36 skipped (845)`,
`Tests 10262 passed | 234 skipped (10496)`, component 62/418, build PASS, `[ci] all checks passed`,
`CI_EXIT=0`. Integration `tests/integration/k072-*.int.test.ts` → 7 files / 58 tests passed,
`INT_EXIT=0`.

**Files.** `ocrPrintedFigures.ts` is new: the figure READER split out of `ocrLargerFigure.ts`, which the
whole-rand and role work took to 371 lines against the 300 cap. A pure move — the 570-row probe set gives
identical results before and after the split. `ocrLargerFigure.ts` 209 lines, `ocrPrintedFigures.ts` 172.

**Migration:** none. **Historical data:** unchanged. **Rollback:** revert the commit.
