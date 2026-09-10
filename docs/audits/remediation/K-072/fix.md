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

**Round-6 limits.** The backfill treats "has a journal, a supplier invoice, or a
`matched_invoice_id`" as posted; a document whose ledger row was later deleted outright becomes
postable again. The unique index does not cover the supplier-invoice path — `capture/[id]/post` and
`ai-invoice-pipeline` both insert `supplier_invoices.source_document_id`, and only the application
claim stops a second invoice there; a partial unique index on `supplier_invoices(company_id,
source_document_id)` is the follow-up, deferred because its production duplicate risk has not been
measured. `expenses/[id].tsx` is still over the 300-line cap.
