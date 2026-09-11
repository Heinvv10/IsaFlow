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

## Master merge — `origin/master` `bfc5c442e` into `37c699635` (401 commits)

Merge only: no posting-gate logic changed beyond what a conflict forced. Six textual conflicts, plus
one SEMANTIC conflict in a file git merged cleanly (master's `r058` integration test).

### The two capture posting routes (`capture/[id]/post.ts`, `capture/[id]/post-expense.ts`)

- **Master wanted (R-058, #419):** a `FOR UPDATE` row lock on `capture_events` before the status
  check; lock contention (55P03 **and** 40P01) answered **409** as retryable; the 5s `lock_timeout`
  **reset to DEFAULT once the lock is granted**, so a downstream wait is not bounded by it; and an
  **allow-list** of postable statuses (`isCaptureEventPostable`) instead of `=== 'posted'`, so a
  discarded event cannot be posted. R-075 (#420) touched neither route.
- **The branch wanted (K-072):** lock the DOCUMENT then the event (`captureRowLock.
  lockCaptureEventForPosting`), refuse on `posted_at` / `'rejected'`, claim the document before the
  first ledger write, and — `post.ts` — `refusesUnattendedApproval` forcing `draft`.
- **Resolution keeps both.** The routes take the branch's two-row lock (document-then-event, so
  the cross-route fence survives) and then apply master's allow-list to `event.eventStatus`, with
  master's wording. Lock contention answers **409** (`apiResponse.conflict`) as R-058 did. The
  branch's `captureRowLock.ts` adopts R-058's lock contract for BOTH acquisitions — 40P01 joins
  55P03 as retryable, and `lock_timeout` is reset after each granted lock (`lockWithTimeout`, the
  same shape as `captureEventLock.ts`). The other `captureRowLock` callers (`receipt-to-journal`,
  `ai-invoice-pipeline`, `document-capture-action`) keep answering 400; only the reset and the
  40P01 mapping reach them. The unattended gate, the claim and `computeFingerprint` /
  `supplierVatNumber` (master) all sit in `post.ts` unchanged relative to their own side.
- `captureEventLock.lockCaptureEventForPosting` (master) has no caller after the merge and is
  removed; the module keeps the allow-list, `CaptureEventLockedError` and `lockCaptureEventRow`
  (discard). Its header no longer says `captured_documents` must not be locked — K-072 locks it.

**Semantic conflict — `r058-capture-post-double-post.int.test.ts` "a downstream lock wait
outlives the 5s".** It proved the reset by holding the DOCUMENT row 7s from another
transaction, on the premise that the post routes never lock `captured_documents`. On the merged
tip they lock it FIRST, so that hold is an acquisition, bounded by design, and the route answers
409 at 5s — the test failed 409 ≠ 200. The test now holds the company's **fiscal period** row
(the journal INSERT's FK check takes FOR KEY SHARE on it), which is a genuine downstream wait.
Mutation: removing `SET LOCAL lock_timeout = DEFAULT` from `captureRowLock.ts` turns it RED
(500 at 5051 ms); restored, `md5sum -c` OK.

**Proved by outcome on the merged tree:** `r058-*` + `r075-*` 36/37 (the one failure is the
r075 test below, identical on master); mutations
— post-expense `conflict`→`badRequest` RED ("answers 409 when another transaction holds the
event"), post.ts allow-list→`=== 'posted'` RED ("a DISCARDED event is refused", "discard
CONCURRENT with post"); files restored, `md5sum -c` OK. K-072's 7 files 58/58 green.

### `journalEntryPostingService.ts`
The branch did not touch `resolveReversalDate`; master's move to `journalEntryReversalDate.ts`
(with its re-export) is taken as is. The branch's one change — `reverseJournalEntry` releasing
the captured document's posting claim — is kept, inside master's `withReversalTransaction`
callback (ALS-bound, so the release commits or rolls back with the contra), before master's
`{ ...reversalEntry, foreignDimensionDroppedLines }` return. 306 lines (master 300, branch 355).

### `postExpenseZeroVatLine.test.ts` / `capturePostFingerprint.test.ts`
Both sides stubbed `@/lib/als` identically; the branch's block is kept. `capturePostFingerprint`
(new on master, merged clean) stubbed only master's single SELECT, so K-072's claim UPDATE got
`[]` and the route refused before its INSERT (5/5 red) — a stale stub in untyped `tests/**`, the
lesson in the brief. Its stub now answers the claim.

### Docs
`core/.claude.md`: both sides' recent-change entries kept (branch 2026-09-10 above master's
2026-09-09). `agent-docs:generate`, then `agent-docs:check`: "OK: 74 agent document mirror(s)".

### `tests/**` census
Branch tests naming anything master moved or re-signed in these files
(`journalEntryPostingService`, `reverseJournalEntry`, `resolveReversalDate`, `captureEventLock`,
`periodStatusService`, `captureDeduplicationService`, `autoPublishGateService`,
`captureRouterService`): `postExpenseZeroVatLine` (mocks `journalEntryPostingService`; green),
`k072-draft-claim-release` (calls reversal through routes; green). Master tests reaching the
branch's routes: `capturePostFingerprint` (fixed above), `r058-*`, `r075-*`.

### Gates (merged tree)
- `env -u DATABASE_URL bun run ci`: exit 0, `[ci] all checks passed` — unit 877 files /
  10962 passed, component 530 passed, build PASS.
- Integration, full suite, `--no-file-parallelism`, 292 files in 6 chunks, each chunk also run on
  a clean `git archive origin/master` (`bfc5c442e`): 1513 passed / 16 failed / 201 skipped on the
  merge; the 16 failures (34 files, mostly file-level) are **the same FAIL lines on master**
  (`comm` of the sorted FAIL lines empty in both directions, every chunk).
- `r075-route-event-after-commit` "routeEvent writes on its own connection after COMMIT" fails
  **identically on the master archive** (write order `extracted, pending` vs expected
  `pending, extracted`) — master's test disagrees with master's R-058 r2 reorder of
  `routeEvent`. Not touched here; reported to the orchestrator.
- Line counts over the 300 cap after the merge: `post.ts` 337 (master 296, branch 299), `post-expense.ts` 310 (branch 300),
  `captureRowLock.ts` 304, `journalEntryPostingService.ts` 306 — each side's comments merged;
  not condensed further to keep both sides' text reviewable.

---

## Round 18 — one figure reader for all three rules, counters by role, and the file-size breach

Hein decided at 17:13 to keep the strict reconcile-end-to-end rule. This round closes the round-17
review's five findings, all of them the whitelist failing open, and the cost finding with them. It
starts from the master merge `b53754e8e` and adds commits only.

### The 300-line breach from the merge — separate commit `0886e7417` (behaviour-neutral)

The merge left `post.ts` 337, `post-expense.ts` 310, `captureRowLock.ts` 304 and
`journalEntryPostingService.ts` 306 lines. Each lost one cohesive piece, verbatim with its reasons:
the `posted_at` claim → `capturePostingClaim.ts`; the closed-period / inactive-account refusals →
`journalEntryPostingGuards.ts` (both re-exported from their old module, so the many tests that
`vi.mock` it still stub what they stub); everything after the supplier invoice is written →
`capturePostFollowUps.ts`, same order, same error handling; the GL-expense-account resolution →
`captureExpenseAccount.ts`. Now 285, 278, 208, 257. Proven by the same suites before and after:
unit `877 passed | 40 skipped` files / `10962 passed | 248 skipped` tests, and integration `k072-*` +
`r058-*` 9 files / 84 tests — identical.

### The findings

| Finding | Disposition |
|---|---|
| HIGH-1 rule 3 alone read whole rands, and excused a whole-rand PAYMENT unsummed | FIXED. `ocrWholeFigures.ts` finds every whole number on every line — beside cents figures too, every one, not the last — and `printedFigures` gives it a role; all three rules read that one list. `Paid by card 253`, `Paid 253`, `Waiter 23 CARD 253`, `Waiter 23 CASH` and `EFT 1500` are SUMMED by rule 1 (`paid 253.00`). `SERVICE:23`, `Service:R23`, `23,-`, `23=`, `23.-`, `R23-` and `SERVICE 23 ZAR` are read. A whole-rand charge beside a cents payment refuses. A whole-rand charge printed as a LINE ITEM with nothing paid (`Waiter 23` over the sub total) refuses on the item column's own sum. fix.md's round-17 sentence "all three rules see it" was false; it is true now. |
| HIGH-2 `TOTAL 499.00CR`, `CR … CARD` on one line, 21 more markings | FIXED. `AMOUNT_CR` reads a `CR` against its figure with or without the space; the `CR`/card carve-back may not start after a figure on its line. Words match by STEM (`OMRUIL` → `OMRUILING`, `TERUGBETA` → `TERUGBETAALDE`, `KREDIT` → `KREDITNOTA`), never followed by `OR` (a creditors heading is not a credit). `RFND`, `RFD`, `CANC`, `CNCL`, `RTRN`, `RMA`, `C/M`, `CRD NOTE`, `CRED NOTE`, `KRED NOTA`, `C R`, `STORNO`, `GUTSCHRIFT`, `AVOIR`; `CM`/`REV` only NUMBERED and not after a number (`Ruler 30 CM 115.00`, `Rev B` stay ordinary). `TOTAL -R 499.00` is read as signed. All 50 of the reviewer's credit probes refuse. |
| MEDIUM-1 23 of 26 footer counters refused; Q29 passes fell 26 → 14 | FIXED, by role. A whole number no role claims (no payment, change or summary label beside it, no currency mark) is a COUNT only where rule 1 has proven what was paid and no money figure shares its line; with no payment, or beside money, it refuses (fail closed). Excluded by SHAPE, never by a label list: dates and times, a leading zero, `%`, `N of M`, "No"/"Nr"/`#`, masked card digits, a following unit or prose word (`30 days`, `23 pp`), 4–6 bare digits with no role (`Terminal 12345`, `Store 1234`), and 7+ digits whatever labels them (`VAT-4123456789`). A loyalty word labels a whole number as a count, not a payment (`Smart Shopper points 5`). A summary word claims a whole number only when adjacent (`Total Items 5` is a count). |
| MEDIUM-2 `€`/`£` after the figure, spelled-out currencies | FIXED. `\d\s*[$€£¥]` and `Dollars`, `Euros`, `Pounds Sterling`, `Sterling`, `Yen`, `Yuan`, `Renminbi`, `Naira` (a bare `Pound` is a weight). The EU reverse-charge invoice and every FX probe refuse. |
| LOW-1 a summary label explained any value | FIXED. A summary line explains its figure only when the figure IS the total, the extracted net or the extracted tax — label AND value. Recap blocks tightened the same way: every row labelled only by a band word (`Std`, `Zero Rated`, `Incl`, a band letter), and the block either names a band or prints the tax — so `Std Rated 207.00 / SERVICE 23.00`, `200.00 / 7.00 / 23.00` and `Waiter 23.00 / Std Rated Incl 207.00` all refuse, while the honest mixed-basket analysis still posts. |

### THE TRADE-OFF, stated and pinned

`Table 12`, `Pump 5` and `Car Guard 23` have one shape, and no spelling separates them. Under a
payment that equals the total, all three read as a count, so **`CARD 230.00 / Car Guard 23` (whole
rand, its own line) auto-posts 230.00.** The round-16 reviewer scored the same shape (`Car Guard 23 /
… / VISA 230.00`, M8) as payable 230 — the card proves what was paid. The same line with cents is money
by its format and still refuses; with no payment on the document, or beside a cents figure, it refuses.
Pinned in `k076-round18-policy.test.ts`. If Hein wants that shape refused too, the price is every
footer counter on every settled slip — the 23 of 26 the round-17 review measured.

### THE COST — head vs `37c699635`, extraction stamped `'vlm'`, identity supplied as the VLM stores it

Both sides measured this round on the same harness over 591 probe rows + the 177-row corpus, including
all of `rev-k072q`'s probes. "Newly refused" = passed correctly at `37c699635`, now goes to a person.

| Set | rows | posts | approvals | WRONG posts | WRONG approvals | newly refused | newly passes |
|---|---|---|---|---|---|---|---|
| `k076-slip-corpus.ts` | 177 | 61 → 61 | 65 → 64 | 0 → 0 | 0 → 0 | 1 | 0 |
| r13 ordinary receipts | 16 | 4 → 4 | 6 → 7 | 0 → 0 | 0 → 0 | 0 | 1 |
| **rev-k072q ordinary documents** (Q1–Q18 + S1–S12) | 30 | **11 → 16** | **14 → 27** | 0 → 0 | 0 → 0 | 0 | 13 |
| rev-k072q footer counters | 26 | 3 → 25 | 3 → 25 | 0 → 0 | 0 → 0 | 0 | 22 |
| **rev-k072q under-refusal** | 77 | 31 → 0 | 32 → 0 | **31 → 0** | **32 → 0** | 0 | 0 |
| **rev-k072q credit** | 50 | 27 → 0 | 27 → 0 | **27 → 0** | **27 → 0** | 0 | 0 |
| rev-k072q over-refusal probes (OC/FX/MR) | 15 | 2 → 2 | 2 → 2 | 0 → 0 | 0 → 0 | 0 | 0 |
| r16 reviewer ordinary / under / credit | 34 / 53 / 44 | 27 / 0 / 0 → same | 28 / 0 / 0 → same | 0 → 0 | 0 → 0 | 0 | 0 |
| r15 / r14 / r13 probe sets, r15 own | 246 | unchanged | unchanged | unchanged (r14 artefact 1) | unchanged | 0 | 0 |

**One row in 768 is newly refused:** the corpus's `N1 Woolworths` loses the AP approval round 17 gave
it. Its VAT is printed under a label the reader cannot read, so there is no extracted tax for `VAT
INCLUDED 18.65` to agree with, and LOW-1 now refuses a summary line it cannot confirm. Its pinned
corpus outcome was already `refuse`. **The reviewer's ordinary documents pass 27 of 30 unattended (was
14); the three that refuse are the two loyalty-savings lines (`Xtra Savings 5.00`, `WRewards savings
3.30` — still Hein's call) and Q8, which the reader's own reconciliation refuses (pre-existing).**
Full till slips S1–S12: 12 of 12 approve. Footer counters: 25 of 26 pass; `Batch 123` on a R115 slip
refuses, because a count larger than the total always does.

The one remaining WRONG row is the r14 `C negative stored total only` harness artefact, fixed at source
in round 16.

### Mutations — 22, all RED, restored byte-identically (`md5sum -c` OK on all five files)

S1 whole numbers never read (47) · S2 a whole-rand payment is not a payment (5) · S3 loyalty words
label a whole number as a payment (2) · S4 a summary word anywhere claims a whole number (1) · S5 a
counter licensed with no payment (3) · S6 a counter licensed beside money (1) · S7 a summary label
explains any value (2) · S8 no item-column check (1) · S9 a recap row may carry any label (2) · S10
unlabelled recap rows need neither band nor tax (1) · S11 masked card digits are an amount (1) · S12
no trailing money suffix (5) · S13 seven digits may be an amount (1) · S14 prose after a number does
not exclude it (2) · S15 no glued `CR` (2) · S16 the CR-card carve-back may start after a figure (1) ·
S17 stems match whole words only (16) · S18 `CREDITOR` is a credit (1) · S19 `CM`/`REV` count after a
number (1) · S20 a spaced `-R` is not a sign (1) · S21 a currency after its figure is the rand (2) ·
S22 a spelled-out currency is the rand (3).

### Gates

`env -u DATABASE_URL bun run ci` → 15 checks PASS, `Test Files 878 passed | 40 skipped (918)`,
`Tests 11052 passed | 248 skipped (11300)`, component 84/530, build PASS, `[ci] all checks passed`,
`CI_EXIT=0`. Integration `tests/integration/k072-*.int.test.ts` + `r058-*.int.test.ts` → 9 files /
84 tests passed, `INT_EXIT=0`.

**Files.** `ocrWholeFigures.ts` (new, 95), `ocrPrintedFigures.ts` 188, `ocrLargerFigure.ts` 270,
`creditIndicators.ts` 231, `unattendedPostingGate.ts` 212. **Migration:** none. **Historical data:**
unchanged. **Rollback:** revert the two commits.

**Not mine, mentioned not changed:** `captureEventLock.ts:47` has a pre-existing lint warning
(`CAPTURE_EVENT_STATUSES` used only as a type).

### Round 18, addition — the merge review's LOW-1: `post.ts`'s 409 is now pinned

The merge review of `b53754e8e` (0H/0M/1L) found that nothing tested `capture/[id]/post.ts`'s own 409
on lock contention: changing its `conflict` to `badRequest` left every r058/k072 capture test green.
`r058-capture-post-double-post.int.test.ts` gains `post: answers 409 when another transaction holds
the event`, adapted from the reviewer's PROBE7 and shaped like its post-expense twin: hold the event
row, post the bill → 409, no supplier invoice, `captured_documents.posted_at` still NULL (the claim did
not leak on the refusal), and once the holder lets go the retry posts one invoice.

- **At head** (`fdef9416e` + this test): 19/19 green. Mutation `conflict` → `badRequest` at
  `post.ts:75`: **RED** (`expected 400 to be 409`), file restored (`md5sum -c` OK).
- **Before the 300-line split** (a `git archive` of `b53754e8e`, post.ts at 337 lines, the same test
  file copied in): 19/19 green, and the same mutation there is **RED** too. The split preserved that
  line's behaviour, proven on both sides of it.

Gates after the addition: `env -u DATABASE_URL bun run ci` → `[ci] all checks passed`, `CI_EXIT=0`
(878 files / 11052 tests passed, component 84/530, build PASS); integration `k072-*` + `r058-*` →
9 files / **85** tests passed, `INT_EXIT=0`.

---

## Round 19 — every vocabulary in the gate fails closed

The round-18 review (`fdef9416e`) was 2H/2M/1L; its LOW-1 was already closed by `1c319e5eb`. The
orchestrator's principle for this round: **a list is acceptable only where a missing entry causes a
refusal, never a post.** Round 18 had two lists pointing the wrong way, and this round inverts them.

| Finding | Disposition |
|---|---|
| HIGH-2 (regression) a handwritten tip on the printed blank posted the pre-tip total, 47 of 59 | FIXED by INVERTING the counter rule. A whole number is a count ONLY when a closed list of counter/reference labels names it (`Items`, `Qty`, `Pieces`, `Till`, `Op`, `Pump`, `Table`, `Cashier`, `Page`, `Batch`, `Store`, `Terminal`, `Receipt`, `Order`, `Ref`, `Auth Code`, `Address`, …, `ocrPrintedFigures.ts`), or it has one of the excluded shapes. Any other whole number no payment, change or summary label claims is unexplained money and refuses — wherever printed, whatever was paid. A counter label missing from the list costs a refusal, never money. All 59 tip probes refuse. **Round 18's pinned trade-off is withdrawn:** `CARD 230.00 / Car Guard 23` now refuses too — the card proves what was paid, but nothing on the document explains the 23, and keeping it would have been a carve-out, not arithmetic. The item-column check lost its "payment proven" licence for the same reason. |
| HIGH-1 a number followed by any word was dropped before its label was read | FIXED. `ocrWholeFigures` no longer drops a number for a trailing word; the label decides. `Paid 253 by card`, `CARD 253 APPROVED`, `Paid R253 thank you`, `EFT 1500 received`, `Payment received: 1500` are summed; `Call-out fee 350 (after hours)` on an unpaid invoice refuses. Excluded by SHAPE only: dates, times, leading zeros, `%`, `N of M`, "No"/`#`, masked card digits, 7+ digits, a reference code (`TAL-998877`), a street number (`12 Main Road`), a unit glued to the digits (`2L`) and a following UNIT word (`30 days`, `5 kg`) — the unit and road-word lists fail closed (a missing unit leaves the number read, and the document refuses). |
| MEDIUM-1 39 of 72 credit markings posted | FIXED. Afrikaans VERBS are generated with their past participle (`GE` in front, or after a separable particle: `GEKANSELLEER`, `GEKREDITEER`, `OMGERUIL`, `TERUGGEGEE`, `UITRUIL`); `AMOUNT_CR` is case-insensitive and reads the Afrikaans `KT`; a Pastel number glued to its prefix (`CRN00045`, `CN0012`, `KN00123`) is a marking; the separator admits an apostrophe (`RET'D`); plus `RVSL`, `REVSL`, `RETD`, `REFD`, `CXL`, `CNX`, `RTV`, `ADJ NOTE`, `KR NOTA`, `REVERSE`/`NEG`/`-VE SALE`, `MONEY BACK`, `KANS`, `MINUS`, `Reimburs…`, `Annul…`, `Rückgabe`, and numbered `RET`/`RA`/`VD`/`GRV`. `Money back guarantee` stays ordinary. **All 72 refuse.** This list is still the one open direction left in the credit rule — a credit document that prints no signal the list knows, AND no negative figure, AND whose model did not classify it — and fix.md says so rather than calling it closed. |
| MEDIUM-2 `US$`, `MZN`, `MT`, `Pula`, `Kwacha` after the figure posted | FIXED by INVERTING the currency test (`documentCurrency.ts`, new). A document passes only when every currency mark beside an amount is the rand: beside a cents figure, any symbol, any `X$` and any uppercase code of two or three letters refuses unless it is on `NOT_A_CURRENCY`, a closed list of words a till prints beside an amount (`VAT`, `EFT`, `QTY`, `CR`…) — a missing entry refuses. A single letter (a VAT-band mark, `32.99 A`) and a code glued to a digit (`50PPM`) are left alone. **Spelled-out names cannot be inverted** (any word may sit beside an amount) and remain a list, now with `Pula`, `Kwacha`, `Metical`, `Rupees`, `Dirham` and others; that is the one open direction left in this file, disclosed in its header. All 18 FX probes refuse. |

### What the inverted counter rule costs — stated plainly

Measured head vs `1c319e5eb`, extraction stamped `'vlm'`, identity supplied, 990 rows (the 177-row
corpus + 813 probes, including all of rev-k072s's). **Across every ordinary set, the inverted rule refuses
3 documents that passed before, and all three are the shape it is meant to refuse:**

- `M8` (r16) and `B1` (r18): `Car Guard 23` under a card equal to the total — the withdrawn trade-off.
- `C1` (r18): an invoice paid in full by `EFT 1150.00` that then prints `Deposit 500` — a whole number
  under a label that is not a counter; a person decides what the deposit was.

Everything else held, because the counter list covers the labels that actually print: the 16 ordinary
receipts 4 posts / 7 approvals (unchanged), rev-k072q's 30 ordinary documents 16 / 27 (unchanged),
rev-k072q's footer counters **26 of 26** (`Batch 123` recovered: a counter is a count at any size), the
reviewer's 15 ordinary documents 7 / 14 (unchanged — 14 of 15 still pass unattended), the corpus 61 / 64
(unchanged). Four counter labels were added only after a measured over-refusal each (`Op`, `Pieces`,
`Address`, and the street-number shape), and two shapes (`TAL-998877`, `50PPM`) likewise.

| Set | rows | posts | approvals | WRONG posts | WRONG approvals | newly refused |
|---|---|---|---|---|---|---|
| `k076-slip-corpus.ts` | 177 | 61 → 61 | 64 → 64 | 0 → 0 | 0 → 0 | 0 |
| r13 ordinary receipts | 16 | 4 → 4 | 7 → 7 | 0 → 0 | 0 → 0 | 0 |
| rev-k072q ordinary (Q1–Q18, S1–S12) | 30 | 16 → 16 | 27 → 27 | 0 → 0 | 0 → 0 | 0 |
| rev-k072q footer counters | 26 | 25 → 26 | 25 → 26 | 0 → 0 | 0 → 0 | 0 |
| **rev-k072s ordinary** | 15 | 7 → 7 | 14 → 14 | 0 → 0 | 0 → 0 | 0 |
| **rev-k072s tip probes** | 59 | 47 → 0 | 47 → 0 | **47 → 0** | **47 → 0** | 0 |
| **rev-k072s payment probes** | 19 | 11 → 0 | 11 → 0 | **11 → 0** | **11 → 0** | 0 |
| **rev-k072s credit probes** | 72 | 39 → 0 | 39 → 0 | **39 → 0** | **39 → 0** | 0 |
| **rev-k072s FX probes** | 18 | 8 → 0 | 8 → 0 | **8 → 0** | **8 → 0** | 0 |
| rev-k072s mixed probes | 39 | 18 → 0 | 19 → 0 | 16 → 0 | 17 → 0 | 2 (`B1`, `C1`) |
| r16 reviewer ordinary | 34 | 27 → 26 | 28 → 27 | 0 → 0 | 0 → 0 | 1 (`M8`) |
| every other r13–r17 set | 485 | unchanged | unchanged | unchanged (r14 artefact 1) | unchanged | 0 |

The one remaining WRONG row is still the r14 `C negative stored total only` harness artefact, fixed at
source in round 16.

Two round-18 tests were rewritten, not weakened, because the rule they pinned was deliberately reversed:
the pinned `Car Guard 23` trade-off now asserts refusal, and "a counter with no payment refuses" became
"a counter label makes a count whatever was paid; an unknown label refuses either way".

### Mutations — 17, all RED, restored byte-identically (`md5sum -c` OK on all six files)

T1 an unroled number is a count when payments balance (16) · T2 every unroled number is a count (38) ·
T3 no counter labels at all (36) · T4 a trailing word drops the number (12) · T5 unit words ignored (4)
· T6 a reference code is an amount (1) · T7 a street number is an amount (1) · T8 no Afrikaans `GE`
participle (6) · T9 glued `cr` case-sensitive (1) · T10 no glued Pastel number (3) · T11 a code glued to
a digit is a currency (1) · T12 an unknown code beside a figure is the rand (2) · T13 no word known not
to be a currency (57) · T14 `Kwacha` unknown (1) · T15 a symbol after the figure is the rand (2) · T16 a
money-back guarantee is a refund (1) · T17 an apostrophe is not a marking separator (1).

### Gates

`env -u DATABASE_URL bun run ci` → 15 checks PASS, `Test Files 879 passed | 40 skipped (919)`,
`Tests 11141 passed | 248 skipped (11389)`, component 84/530, build PASS, `[ci] all checks passed`,
`CI_EXIT=0`. Integration `k072-*` + `r058-*` → 9 files / 85 tests passed, `INT_EXIT=0`.

**Files.** `documentCurrency.ts` (new, 50), `ocrWholeFigures.ts` 82, `ocrPrintedFigures.ts` 194,
`ocrLargerFigure.ts` 268, `creditIndicators.ts` 258, `unattendedPostingGate.ts` 196 — all under 300.
**Migration:** none. **Historical data:** unchanged. **Rollback:** revert the commit.

---

## Round 20 — every exemption answers "can this ever let money through?"

The round-19 review (`7c7c15af0`) was 3H/3M/1L, and two of the HIGHs were regressions round 19 itself
introduced: an exemption that could let money through. This round puts that question to every exemption
in the reader, removes or narrows each one that failed it, and adds a second gate that fails closed.

| Finding | Disposition |
|---|---|
| HIGH-1 (regression) `COUNTER_LABEL` matched the END of a label: `Admin fee per Invoice 50`, `Tip for Server 23`, `Function Room 500` were counts | FIXED. A counter label must BE the whole label (`ocrWholeFigures.isCounterLabel`): anchored at the line start or the previous figure (a skipped id counts — `Till 04 Cashier 12`), the counter noun first after at most one fixed lead word (`Customer copy`, `Your points balance`, `Benefit points earned`), then only a number word and a code prefix. The `Sold/Earned/Copy` qualifiers stay; `Total`/`Balance`/`Count` do not (`Order Total 253` is money). A label that merely ends in a counter word is money. Added only after a measured over-refusal each: `Class`, `Waybill`, `Duration`, `Weight`, `Warranty`, `Payment Terms`, `Ticket`, the loyalty leads. |
| HIGH-2 (regression) the reference-code shape swallowed `TIP-23`, `FEE-350`, `CARD-253`, `EFT-1500` | FIXED by REMOVING the shape. A code prefix (`TAL-998877`) is exempt only behind a counter/reference label (`Invoice No: TAL-`, `Waybill: TCG-`); anywhere else the number is read and its label decides. Measured cost of the removal: zero — every ordinary `XXX-NNNN` in the sets sits behind such a label. |
| HIGH-3 a figure glued to leader dots was invisible to all three rules | FIXED. `blankFillers` blanks a run of 2+ dots, dashes, underscores, tildes or middots before a figure (and SA phone numbers) before either reader runs, keeping every index. `Call-out fee..........350.00`, `Paid EFT............1500.00` and `Waiter..........23.00` refuse; an honest leader-style slip that reconciles passes. |
| MEDIUM-1 the `of`, masked-card, unit and street shapes dropped money | FIXED — each is exact. `of` exempts only `N of M`; a mask only `****`+ then EXACTLY four digits; a street number only at the START of its line; a glued measure (`2L`, `700G`, `3S`, `9h`) is one token, but a glued word (`253APPROVED`) is not in the list, so its label decides; a DURATION (`30 days`) is never a rand amount and exempts anywhere; a MEASURE (`150 km`, `23 x`) exempts only in a row that prices it in cents — `Travel 150 km` alone is the charge; and `pp` is never a unit. A role always wins: `Paid 253 x` is a payment. |
| MEDIUM-2 `SR` on the till-word list; mixed-case codes; codes away from a figure; 18 names | FIXED. `SR`, `KGS`, `KM` removed. After a figure, a code of ANY case and up to four letters refuses unless on the closed till-word list (`Rs`, `kr`, `FCFA`, and a lone `P` closing the line); before a figure it stays uppercase-only, because an item name sits there (`Tea 18.00`). A currency DECLARED anywhere (`Currency: MUR`, `Currency code: ZWG`, `Currency: ZiG`) refuses unless it is the rand. ISO list broadened to SADC, the Indian Ocean and the majors; `zł`/`Kč`/`₵`… symbols; the 18 names added (`Won`/`Som` only after a figure — `som` is Afrikaans for "sum"). **Spelled-out names still fail OPEN**: a name missing from the list is the one open direction left, stated in the file and here. |
| MEDIUM-3 25 of 32 credit markings posted | FIXED. `OMKEER`, `TERUGNEEM`, `TERUGBRING`, `TERUGBOEK`, `TERUGSKRY` join the generated Afrikaans verbs; `OMKER`, `RESCIND`, `NULLIF`, `CHARGEBACK` stems; `GELD`/`KONTANT TERUG`, `NIETIG`, `CONTRA`/`KONTRA` (whole word — `Contract` is not a credit), `UNDO SALE`, `VOUCHER ISSUED`, `ROLLBACK`, `WITHDRAWN`, `AFGETREK`, `UITBETALING*`, `OORBETALING*`, `RECALL*`, `TERUGNA*`, and `GOEDERE TERUG*` now inflects. All 32 refuse. |
| MEDIUM-3, the second gate | ADDED, fail-closed (`purchaseTitle.ts`). A document posts or auto-approves only when its HEADER — every line above its first money figure — has a line that IS a purchase title (`TAX INVOICE`, `INVOICE`, `RECEIPT`, `TILL SLIP`, `CASH SALE`, `BELASTINGFAKTUUR`, `KWITANSIE`, `BILL`, optionally `(COPY)`). A reference line (`Original Invoice No: 88123`) is not a title. A text-less image passes only on a model type of `invoice` or `receipt`. So a credit note titled with a word the credit list lacks carries no purchase title and refuses — the credit list is no longer load-bearing for it. It runs LAST in `unattendedPostingRefusal` so every other reason keeps its wording, and on both AP routes. SA's VAT Act requires the words "Tax Invoice" on a tax invoice, so the title is what the documents this gate should pass already print. |
| LOW `KANS`, `MINUS`, `GRV`, `MONEY BACK`, `Class 1` over-refused | FIXED where a narrower match holds: `KANS` and `MINUS` count only as a HEADER alone on its line (`Staan 'n kans om R1000 te wen`, `Minus 10% vir pensioenarisse` are ordinary); `GRV` removed (a Goods RECEIVED Voucher is a purchase); `100% money back` and `Money back if/guarantee/…` carved back; `Class` is a counter. |

### Tests changed because the RULE changed, not weakened

The purchase-title gate is a new condition for every document that posts, so every POSITIVE fixture that
expects a post now carries `TAX INVOICE` in its re-read text: the `read`/`gate`/`stored` helpers of six
k076 unit files, `receipt-to-journal.test.ts`, `postExpenseZeroVatLine.test.ts`, and the default
fixtures of three K-072 integration files. The NEGATIVE fixtures in those integration files (ambiguous
totals, a credit note, a fallback read) got the title too, deliberately, so that each still refuses
for its OWN reason and not merely for lacking a title — otherwise a mutation of its own rule would stay
green. The round-19 test that pinned `GRV 0012` as a credit now pins it as ordinary (LOW), and corpus row
`X1` changed its pinned outcome to `refuse`, annotated: it prints `Invoice No: 55123` but no title.

### THE COST AND THE WRONG POSTS — head vs `7c7c15af0`, 1 312 rows

Extraction stamped `'vlm'`, identity supplied, corpus + 1 135 probes (every set, all of rev-k072t's).

| Set | rows | posts | approvals | WRONG posts | WRONG approvals | newly refused |
|---|---|---|---|---|---|---|
| `k076-slip-corpus.ts` | 177 | 61 → 60 | 64 → 63 | 0 → 0 | 0 → 0 | 1 (`X1`, no title) |
| r13 ordinary receipts | 16 | 4 → 4 | 7 → 7 | 0 → 0 | 0 → 0 | 0 |
| rev-k072q ordinary | 30 | 16 → 16 | 27 → 27 | 0 → 0 | 0 → 0 | 0 |
| rev-k072q footer counters | 26 | 26 → 26 | 26 → 26 | 0 → 0 | 0 → 0 | 0 |
| rev-k072s ordinary | 15 | 7 → 7 | 14 → 14 | 0 → 0 | 0 → 0 | 0 |
| **rev-k072t ordinary** | 20 | 7 → 7 | 11 → 12 | 0 → 0 | 0 → 0 | 0 |
| **rev-k072t counter-suffix (A/X)** | 101 | 73 → 0 | 73 → 0 | **73 → 0** | **73 → 0** | 0 |
| **rev-k072t shape** | 62 | 56 → 0 | 56 → 0 | **56 → 0** | **56 → 0** | 0 |
| **rev-k072t payment** | 26 | 24 → 0 | 24 → 0 | **24 → 0** | **24 → 0** | 0 |
| **rev-k072t leaders** | 8 | 0 → 0 | 6 → 2 | 0 → 0 | **4 → 0** | 0 |
| **rev-k072t credit** | 32 | 25 → 0 | 25 → 0 | **25 → 0** | **25 → 0** | 0 |
| **rev-k072t FX** | 73 | 35 → 0 | 35 → 0 | **35 → 0** | **35 → 0** | 0 |
| rev-k072s credit | 72 | 0 → 1 | 0 → 1 | 0 → 1 | 0 → 1 | 0 |
| every other r13–r18 set | 654 | unchanged | unchanged | unchanged (r14 artefact 1) | unchanged | 0 |

**One ordinary document in 1 312 is newly refused** (`X1`, by the title gate). The reviewer's 20 ordinary
documents pass unattended 12 of 20 (was 11 of 20); the four Afrikaans slips they note refuse on the
reader's own `BTW 15%`-after-`Subtotaal` VAT read, pre-existing and not touched here.

**The one row that got worse is deliberate:** rev-k072s's credit probe `GRV 0012` was scored a credit by
the round-18 reviewer and now posts, because the round-19 reviewer and this round's brief identify a GRV as
a Goods Received Voucher — a purchase. It is counted above as a wrong post by its original label. The
only other WRONG row is the r14 negative-stored-total harness artefact, fixed at source in round 16.

### Mutations — 21, all RED, restored byte-identically (`md5sum -c` OK on all seven files)

Three survived the first sweep and are recorded: U9 (the priced-rows check), U12 (the currency
declaration — masked because every declared code in the tests was also on the ISO list) and U15 (the
title gate on the AP routes). Each got a test that isolates it (`Cake cutting per Table 30`, `Currency:
ZiG`, `refusesUnattendedApproval` on an untitled letter); all three are now RED.

U1 counter matched at the END (17) · U2 label not restarted after a skipped id (5) · U3 no leader
blanking (6) · U4 `of` after any word (5) · U5 a 2-char mask (4) · U6 street anywhere (3) · U7 a measure
without a priced row (5) · U8 a code prefix anywhere (10) · U9 priced rows adding up ignored (1) · U10
`SR` a till word (1) · U11 codes after a figure uppercase-only (4) · U12 no declaration check (1) · U13
the 18 names missing (13) · U14 no title gate on posting (1) · U15 no title gate on the AP routes (1) ·
U16 a reference line is a title (1) · U17 an untyped image passes (1) · U18 new Afrikaans verbs missing
(2) · U19 `KANS`/`MINUS` anywhere (3) · U20 `GRV` a credit (1) · U21 a money-back promise a refund (1).

### Gates

`env -u DATABASE_URL bun run ci` → 15 checks PASS, `Test Files 880 passed | 40 skipped (920)`,
`Tests 11286 passed | 248 skipped (11534)`, component 84/530, build PASS, `[ci] all checks passed`,
`CI_EXIT=0`. Integration `k072-*` + `r058-*` → 9 files / 85 tests passed, `INT_EXIT=0`. (The first CI run
of this round failed 3 tests in `receipt-to-journal.test.ts` and `postExpenseZeroVatLine.test.ts`,
positive fixtures without a title; they were given one, and the run above is the re-run.)

**Files.** `purchaseTitle.ts` (new, 40), `ocrWholeFigures.ts` 131, `ocrPrintedFigures.ts` 188,
`ocrLargerFigure.ts` 274, `creditIndicators.ts` 274, `documentCurrency.ts` 74, `unattendedPostingGate.ts`
200 — all under 300. **Migration:** none. **Historical data:** unchanged. **Rollback:** revert the commit.

---

## Round 21 — `44339ae18` (reconstructed in round 22; the round-21 fixer died before writing it)

The round-20 review (`7c7c15af0` → `13a26ba1e`) asked every exemption "can this ever let money through?".
Round 21's own commit message is the only first-hand record; this section restates it and adds what the
round-21 review (`review-k072-r21.md`, scoring `8caf5cf19` = round 21 + the `3797f001e` master merge) measured.

| Round-20 finding | What round 21 did |
|---|---|
| HIGH-1 twelve counter nouns named money (`Mileage 350` posted R1 150 against R1 500) | Removed them. `Receipt`, `Order`, `Account`, `Room`, `Server`, `Covers`, `Code`, `Copy`, `Waybill` needed a number word or a long code; `Address` and a generic `Points` went. A dimension label with its own unit (`Weight 5 kg`) became a measurement. Each surviving count noun got a "money-beside" probe — but the probe put `fee` or cents beside the noun, not a bare number (round-21 review HIGH-2). |
| MEDIUM-1 a duration was exempt anywhere, so a RATE posted | A duration exempts only after a terms/prose lead (`within`, `Terms:`). |
| MEDIUM-2 refund words under a TAX INVOICE header | 26 words added; the list stays fail-open by nature. |
| LOW-1/2 titles with a number or a second language refused | A title line could carry its number, a second language, `ORIGINAL` and a page marker; its number was the document's in the header. **This is what the round-21 review's HIGH-1 beat** — `Invoice No: 55123` became a title. |
| LOW-4 currency shapes | `Rs` before a figure, `Zimbabwe Gold`, "amounts in" declarations refuse. |

The commit claims "21 mutations RED"; the list was never written down and cannot be recovered. The round-21
reviewer re-ran eleven of its own (V1–V11, `review-k072-r21.md`), all RED except V11, an equivalent mutant.
The round-21 review: **2 HIGH, 1 MEDIUM, 4 LOW, CI red** (`CAPTURED_DOCUMENT_ALREADY_POSTED` unclassified after
the master merge).

---

## Round 22 — the counter becomes structural, a number line is never a title

Review: `review-k072-r21.md` (2H/1M/4L). Orchestrator's decision this round, on the counter exemption:
listing nouns cannot be made safe, so replace the noun-based exemption with a STRUCTURAL condition.

| Finding | Disposition |
|---|---|
| HIGH-1 (regression) `Invoice No: 55123` was a purchase title; 15 credit titles, 30/30 reprints and 39/39 non-purchase documents posted | FIXED, two rules (`purchaseTitle.ts`). (1) A title LINE is the title words only — bilingual (now also space-joined, `TAX INVOICE BELASTINGFAKTUUR`), `ORIGINAL`, a page marker. **A line carrying a number is a field, never a title**; `titleNumberIsDocument` and its call in `printedFigures` are deleted, so `TAX INVOICE: 12345` is read as money again. `STATEMENT` is no longer a title. (2) `NOT_A_PURCHASE`: any HEADER line naming COPY, REPRINT, DUPLICATE, PRO FORMA, QUOTE/QUOTATION, ESTIMATE, STATEMENT, NOTE/NOTA (delivery, discount, credit, bonus… note), ORDER CONFIRMATION, PURCHASE ORDER, GRV/GRN/GOODS RECEIVED, SETTLEMENT, SHORT DELIVERY/SHORTAGE, CLAIM, DAMAGES, ADJUSTMENT, ALLOWANCE, INCENTIVE, BONUS, REBATE, SWOP/SWAP, EXCH…, ACCEPTED BACK refuses, title or not. Each names a DOCUMENT: bare `Discount` heads a price column on ordinary invoices (O8), so only `DISCOUNT SLIP/VOUCHER/ADVICE/MEMO` count (`DISCOUNT NOTE` is caught by NOTE). The vendor's own name/address is scrubbed first (`Copy Shop Rosebank`), as the credit rule does. All reviewer probes: a-title 79 → 0, a-credit-title 40 → 0, g-credit 15 → 0, F15 refuses. |
| HIGH-2 170/174 bare `noun 350` probes posted | FIXED by the orchestrator's rule. `counterLabel` now answers `'reference'` (a number word or a long code — never money), `'count'` (a bare count noun — only a CANDIDATE) or null. `unreconciledFigure` keeps a count only when **(a)** the payments sum exactly to the total (rule 1 balanced — `settled`) **and (b)** the number is ≤ 99 and < total / 10. Every other reader (`unexplainedLargerFigure`, the extraction warning) keeps counts as money, which is consistent: a count larger than the total fails (b). On a document with no payment lines there is no count at all. `Covers` moved back to the count nouns (the reviewer's `Covers 2` LOW). A second hole the probes exposed is also closed: the item-column check started its block at the first line *opening with a summary word*, so `Total Items 350`, `Tax Class 350` and `VAT Units 350` above the sub total were never read; it now starts at the first line printing a SUMMARY figure. c-count 174 → 24, c-real 8 → 0 (`Operator 800` refuses). |
| MEDIUM-1 `bun run ci` red — census test | FIXED. **Two** codes were missing, not one: `CAPTURED_DOCUMENT_ALREADY_POSTED` (two fixed messages, no id, raised after a company-scoped read) and `CAPTURE_ROW_LOCK_TIMEOUT` (says "retry", names only the caller's own id, row locked by id AND company_id — the same shape as `BANK_TX_LOCK_TIMEOUT`, already a refusal). Both classified as refusals in `REFUSAL_CODES`; the census goes red with either one removed (H1, H2 below). |
| LOW-1 `SHOWER GEL`/`HAIR GEL`/`AMD` matched ISO | FIXED. ISO codes that are also words (`GEL AMD TRY MAD RON RUB CAD PHP KGS LAK`) left `ISO_ANYWHERE`; they refuse only BESIDE a number (`WORD_CODE_BESIDE`, whole or cents, either side) or in a declaration. A code that is no word still refuses anywhere. |
| LOW-1 `Payable in full` read as a declaration | FIXED. The word after "in" refuses unless it is the rand or on `NOT_DECLARED` (`full`, `advance`, `words`, `instalments`…) — a closed list that fails CLOSED. `Curr` no longer matches inside `Current`. |
| LOW-1 `Covers 2` on five slips | 3 recovered (r17 `Covers 2`, r17 S5, u-ord U3 Wimpy). The other two refuse for another reason: r18 R4 prints bare `Order 45` (money without a number word), k-ord O4 prints `Table 12` on R114 (≥ a tenth — rule (b)). |
| LOW-2 title-number rule not confined to the header on whole-rand documents | CLOSED by deleting the rule (HIGH-1). `CASH SALE: 350` and `TAX INVOICE: 1500` are money wherever printed. |
| LOW-3 no round-21 section | Written above. |
| LOW-4 17 refund words posted | FIXED: stems `REMBOURS`, `RIMBORS`, `RÜCKERSTATT`, `ANULA`, `ABONO`, `REKLAMASIE`; markings `REFND`, `RETRN`, `EXCH`, `XCHG`, `REV SALE`, `RUIL`, `NEG`, `R/N`. `Exch rate` and Afrikaans exchange-policy lines (`Ruil binne 7 dae…`) are carved back as phrases. **The credit list stays fail-OPEN for a refund printed under a TAX INVOICE header** — the one direction no structural rule covers; b-credit 17 → 0. |
| LOW-4 `Prices in ZiG` posted | FIXED: `prices`, `figures`, `values`, `rates`, `pryse` and "shown/stated/quoted in" are declarations. e-fx 4 → 0. |
| (re-verify each shape with money beside it) | Dates, times, masked card (exactly 4), `N of M`, measurements with their own unit: unchanged, probes pinned in `k076-round22-policy.test.ts`. **A duration exempted `Storage for 350 days`, `Hire for 450 day`, `Rental period 1500 month`**, so a duration now exempts only ≤ 2 digits (`30 days`). Measured cost: zero. |

### What stays open, deliberately — for the orchestrator

1. **Number-word references stay exempt at any size, anywhere** (`Order No 350`, `No 350`, `# 350`,
   `Receipt No 350`) — the 24 c-count rows still posting. A number word is a shape a charge is not printed in,
   and an invoice's own `Invoice No: 55123` must not be money. Tried and rejected: header-only references —
   the per-line and below-the-total readers lose the header, and courier invoices print `Waybill TCG-998877` on
   item rows. If you want them structural too, the cheapest version is "a reference below the first money figure
   is money unless the document is paid in full"; not built.
2. **The item column is checked only when a loose whole number is present** (pre-existing since round 17;
   the reviewer's own `h-item` set, 6 rows, posts at all three SHAs): `Labour 1000.00 / Delivery 350.00 / Sub
   Total 1000.00 / TOTAL 1150.00` posts 1150 although the rows sum to 1350. Checking every document's item
   column was measured: it closes h-item and costs **13 ordinary documents** (fuel slips with `@ 23.45`, surcharge
   rows, tip-inside, balance brought forward). Not built — a policy call.
3. The glued `Labour 450hrs` / `Hire 450h` (6 d-dur rows): the round-21 review accepted them as quantities.
4. The vendor-identity scrub is fail-open if the model puts a disqualifying word inside `vendorName` AND the
   document also prints a pure title line — the same exposure the credit rule has had since round 16.

### THE COST — head vs `13a26ba1e` and `8caf5cf19`, 2 220 rows, extraction stamped `'vlm'`

Harness: rev-k072v's `run2.ts` (identity supplied, supplier match 1.0) over `every.json` (corpus + 1 462 probes,
rev-k072u's sets included) and `r21`, `r21o`, `r21c`, `r21r`, `r21h`. Unattended = posted or auto-approved.
WRONG = unattended on a credit, a must-refuse probe or a null payable, or at an amount not the payable.

| Set | rows | unattended 13a26 → 8caf5 → **head** | WRONG 13a26 → 8caf5 → **head** |
|---|---|---|---|
| corpus | 177 | 63 → 63 → **60** | 0 → 0 → 0 |
| ordinary16 | 16 | 7 → 7 → **5** | 0 |
| rev-k072u u-ord | 16 | 8 → 8 → **5** | 0 |
| rev-k072v f-ord | 16 | 10 → 8 → **8** | 0 |
| r16 / r17-Q29 / r17-footer / r18 / k-ord ordinary | 125 | 106 → 98 → **72** | 0 |
| m-title (rev-k072u) | 27 | 2 → 27 → **14** | — (9 of the 13 lost are COPY/REPRINT/PRO FORMA/STATEMENT/DELIVERY NOTE, correctly refused) |
| a-title / a-credit-title / g-credit | 273 | 5 → 134 → **0** | 5 → 134 → **0** |
| c-count / c-real | 189 | 178 → 182 → **24** | 178 → 182 → **24** (number-word references, open item 1) |
| b-credit / e-fx / d-dur | 97 | 44 → 41 → **12** | 40 → 37 → **8** (6 glued hours, 2 = open item 2) |
| h-item | 6 | 6 → 6 → 6 | 6 → 6 → 6 (open item 2) |
| every other set (probes, credit, FX, tip, shape, r14/r15/r17 ordinary, n-grv) | 1 278 | 213 → 41 → **38** | 174 → 4 → **3** (probes44 ×2, the r14 artefact ×1; r18 `GRV 0012` 1 → 0) |
| **all** | **2 220** | **642 → 615 → 244** | **403 → 363 → 41** |

**What the counter decision costs on till slips, stated plainly.** Isolated by re-running head with counts
always exempt (the only difference): **37 ordinary documents lose unattended posting — 234 → 197 of the
ordinary documents that passed.** 31 are paid till slips: the id beside a count noun is over two digits
(`Odometer 145230` on every fuel slip, `Auth Code 123456`, `Op 3456`, `Store 1234`, `Terminal 12345`, `Trans
99881`, `Batch 123`, `Seq 4521`, `Your points balance 1250`), or a small count is a tenth of a small total or
more (`Table 12` on R114, `Cashier 12` on R115, `Lane 3` on R23, `Smart Shopper points 25` on R115). Five are
UNPAID supplier invoices printing `Branch 250655` in their banking details (R27, O7, Q6, R9, U4) — nearly
every SA supplier invoice does, so in production this is the larger cost. One is a courier invoice with
`Parcels 2`. The title rules cost 4 more (`TAX INVOICE No 88123`/`#12345`/`: 12345`, `ACME (PTY) LTD TAX INVOICE`),
GRV 2 (`n-grv`, by decision), and F10 (`BELASTINGFAKTUUR Nr 5521`). Recovered: U3 Wimpy, S5, F6 Clicks, F8
`Payable in full`. Tests pinning the reversed behaviour were rewritten to assert the new rule, each marked
"round 22": r15 (1), r17 (1), r18 (15 → split), r19 (2), r20 (6), r21 (8 titles, GRV, the title-number test,
`Covers 50`), corpus X1, R12, R27 → `refuse`.

### Mutations — 25, 24 RED, restored byte-identically (md5 checked per mutation)

W1 payment not required (2) · W2 no two-digit cap (1) · W3 no tenth-of-total cap (4) · W4 bare count noun a
reference (5) · W5 default reader keeps counts (1) · W6 item block starts at a summary word (1) · W7 `Covers`
not a count (1) · W8 duration any length (1) · T1 a title may carry a number (2) · T2 no disqualifier (2) · T3
no vendor scrub (1) · T4 no space-joined bilingual title (1) · T5 bare `DISCOUNT` disqualifies (1) · C1 word
codes anywhere (1) · C2 word codes never beside (1) · C3 any declared word but the rand (1) · C4 prices/figures
not declarations (1) · C5 `Curr` matches `Current` (1) · R1 new refund stems (1) · R2 new refund markings (1) ·
R3 Afrikaans exchange-policy phrase (1) · R4 `Exch rate` not benign (1) · H1/H2 each refusal code removed (1
each). **T6 (`STATEMENT` a title again) stays GREEN — an equivalent mutant: `NOT_A_PURCHASE` refuses STATEMENT
on the same line.**

---

## Round 23 — the item column over-sums, reprints anywhere, branch codes, citing fields

Review: `review-k072-r22.md` (1H/1M/2L, all pre-existing, no regressions; the reviewer accepted the 24
number-word references as unrealistic charges). Harness as in round 22 plus the reviewer's `w22.json` (84
probes): 2 304 rows.

| Finding | Disposition |
|---|---|
| HIGH-1 item rows that do not reconcile posted the lower total (`Labour 1000.00 / Delivery 350.00 / Sub Total 1000.00 / TOTAL 1150.00`, `Hire 1 day 450`) | FIXED with the reviewer's rule (`unexplainedItem`): with no loose whole number, the item rows' last figures must not sum to MORE than both the total and the net. Under-summing rows (a dropped line, `40.00L` on a fuel slip) leave the printed total the payable and pass. Payment/change rows are not items; a NAMED prior balance (`Balance brought forward`, `b/f`, `Previous/Opening balance`, `Vorige saldo`) is left out, because it belongs to a prior document. A bare `Balance 500.00` is NOT left out — it may be owed on top of this document — so corpus `P3` now refuses (pinned, annotated). All 8 rows refuse (h-item 6 → 0, d-dur wrong 8 → 6). |
| MEDIUM-1 a reprint marked in the footer, or in Afrikaans, posted twice | FIXED. `REPRINT` is checked on EVERY line: `RE-PRINT/REPRINTED/RE PRINT`, `RE-ISSUED`, `DUPLICATE…`, `DUPLIKAAT`, `HERDRUK`, `KOPIE`, `AFSKRIF`, a spaced `C O P Y`, `COPY` ending a line (`*** COPY ***`), `COPY OF`, `IS A COPY`, and `TRAINING MODE` (no sale at all). Nothing downstream of receipt-to-journal or petty cash checks for a duplicate, so this is the only net. `LAY-BY`, `SALES ORDER`, `JOB CARD` and `REMITTANCE` join the header disqualifiers (the reviewer's w-title probes; cost 0). w-title wrong 20 → 0. |
| MEDIUM-1, `Customer Copy` — decided | **Not a reprint marker.** `CUSTOMER/MERCHANT/CARDHOLDER/CLIENT COPY` (and `KLANT/KLIËNT KOPIE`) names which of a card machine's two prints this is, and both are printed on every ORIGINAL slip; a reprint says REPRINT or DUPLICATE, which refuses on any line of the same slip. The phrase is blanked before either check, so it neither disqualifies the header nor counts as `COPY`. Recorded risk: a device that marks a reprint ONLY with "CUSTOMER COPY" would pass — none in any probe set does. |
| LOW-1 `Branch 250655` refused every supplier invoice | FIXED (`counterLabel`): a label ending `Branch`/`Br` (with `Code`/`No`) on exactly six digits, 100 000–999 999, is a reference. Six digits is at least R100 000, so it can only hide a figure LARGER than the total, and no document prints its payable as a branch code. Recovers R27, O7, Q6, R9, U4 and 16 of the reviewer's 20 bank rows (`Branch Code: 250655`, `Br Code 632005`, `Branch Code: 250 655` included); `Branch 350` and `Branch 25065` stay money. |
| LOW-2 header fields citing another document refused ordinary B2B invoices | FIXED (`FIELD`): `Delivery Note`, `Purchase/Sales/Your/Customer Order`, `Job Card`, `Quote/Quotation`, `Kwotasie` and `Statement` followed by a number word/date and a value, or a colon/`#` and a value, plus a `Note:`/`Settlement:` label, are blanked before the disqualifier runs. A field NAMES another document; the title rule still requires this one to be a purchase. `DELIVERY NOTE`, `PURCHASE ORDER`, `QUOTATION`, `STATEMENT`, `SETTLEMENT DISCOUNT` and `ORDER CONFIRMATION No: 55` as lines still refuse. **GRV/GRN fields are deliberately NOT carved out**: a RECEIPT beside a GRV is the buyer's own voucher (round 21), so `GRV No:` keeps refusing. w-hcost 2 → 9 of 11 pass (`Our Ref: Quotation 2231` and `GRN: 5521` still refuse). |

### Re-measured — head vs `440adf223`, 2 304 rows

| | `13a26ba1e` | `8caf5cf19` | `440adf223` | **head** |
|---|---|---|---|---|
| unattended / WRONG, all rows | 700 / 433 | 673 / 393 | 281 / 63 | **279 / 35** |
| h-item + d-dur (36) | 27 / 23 | 26 / 22 | 18 / 14 | **10 / 6** |
| w-title reprints (26) | 25 / 25 | 25 / 25 | 20 / 20 | **0 / 0** |
| w-bank (20) | 8 / 0 | 8 / 0 | 2 / 0 | **18 / 0** |
| w-hcost (11) | 9 / 0 | 9 / 0 | 2 / 0 | **9 / 0** |

Newly correct: 28 (the 5 bank documents, 16 bank rows, 7 citing fields). Newly refused: **2** — corpus `P3`
(bare `Balance 500.00` above the items) and m-title's `Time 14.32` above the title, read as a figure. **Newly
wrong: 0.** The 35 WRONG left: 24 number-word references (accepted by the reviewer), 6 glued hours (accepted),
2 w-cnt probes with no payable label that post the correct total (`CARD 1915.00 / Store Card 85` on R2 000;
`Paid 2000.00 / Units 50 COD`), and the 3 known artefacts.

### Mutations — 12 new, all RED; the round-22 title set re-run on the changed file

X1 no over-sum check (2) · X2 prior balance summed (1) · X3 payment rows summed (2) · X4 reprint header-only
(1) · X5 Afrikaans reprint words gone (1) · X6 card copy not blanked (1) · X7 no field carve-out (1) · X8 no
branch code (5) · X9 branch code any size (3) · X10 GRV fields carved out (3) · X11 spaced `C O P Y` gone (1) ·
X12 lay-by/sales order/job card/remittance gone (1). X11 and X12 were GREEN on the first run — the probes put the
word on the title line, where the title rule refused first — and the test was changed to print the word on its
own line under a pure title. Round-22 T1–T5 re-run: all RED; T6 still equivalent.

---

## Round 24 — change, prior balance and the summary block, by structure; COPY footers

Review: `review-k072-r23.md` (3H/2M/0L, no regressions; the `Customer Copy` decision accepted). Harness as in
round 23 plus the reviewer's `x23`, `y23`, `z23` and `o23` sets (175 probes): **2 479 rows**. `ocrLargerFigure.ts`
would have passed 300 lines, so the item column and the summary block moved to `ocrItemColumn.ts` (new, 82).

| Finding | Disposition |
|---|---|
| HIGH-1 a label CONTAINING "change" was exempt with no cash tender (`Oil change 350.00`, 21 of 21) | FIXED twice over. (1) `CHANGE_LABEL` must BE the label — `Change`, `Change Due/Given/Returned`, `Wisselgeld`, `Kleingeld` and separators, nothing else. (2) A change figure is explained only where a CASH tender's change entered a balanced rule 1 (`cashChange = settled && hasCash`), in the item column and in the below-the-total rule. (1) is what stops `CASH 1500.00 / Oil change 350.00` netting to the total as "change" (pinned). An oil change INSIDE the sub total still posts. |
| HIGH-2 the prior-balance exclusion had no anchor (`Interest on previous balance 350.00`, 9 rows) | FIXED. `PRIOR_BALANCE` matches only a line that IS the label and its figure (`^…label…[:=-]* R? figure$`). The five true forms still post the right total. |
| HIGH-3 a charge smaller than the VAT, or one inside the summary block, posted on an unpaid invoice | FIXED with the reviewer's two conditions, only where NO payment settles the total: the item rows landing between the net and the total refuse, and any non-summary figure between the first summary line and the total line refuses. A paid document is spared both — its payment proves what was owed, and a card surcharge or rounding inside a paid total is ordinary (pinned; measured, applying either to paid slips costs 3 ordinary documents). Closes 13 of 15. **The other 2 stay open by construction:** `Travel 149.99` sums to 1 149.99, within the cent of rounding every VAT-inclusive item column needs, and `Delivery 150.00` equals the VAT, so the rows sum exactly to the total — the shape of an honest VAT-inclusive item column. Both are pinned as open. |
| MEDIUM-1 `COPY RECEIPT`, `COPY TAX INVOICE`, `Copy 2 of 2`, `** DUP **`, `RPRNT` posted twice | FIXED: `COPY` followed by `INVOICE`/`TAX INVOICE`/`RECEIPT`/`SLIP`/`No`/a digit, `COPY -`/`COPY:`, `DUP`/`DUPL`, `RPRNT`, and the Afrikaans `HERUITREIKING`/`KOPIEER` (from the reviewer's set) refuse on any line. `CUSTOMER/MERCHANT/CARDHOLDER COPY` stays exempt as decided in round 23; `Copy Paper` is not matched. x-rp 11 → 0 (the reviewer's "COPY - not a tax invoice" closes too). |
| MEDIUM-2 the same slip uploaded three times posts three journals | **Not this branch — registered as R-088**, to be fixed on its own branch after K-072 merges. Recorded here because it is the REAL double-post exposure: an identical re-upload or re-sent WhatsApp photo carries no marker, so no rule in this file can close it. Neither receipt path (`receipt-to-journal`, `post-expense`) de-duplicates by content (`raw_bytes_sha256`, or vendor + reference + date + total); `findDuplicate` covers only `capture/[id]/post.ts` and the AI invoice pipeline. |

### Re-measured — head vs `591193edb`, 2 479 rows

| | `591193edb` | **head** |
|---|---|---|
| unattended / WRONG, all rows | 371 / 102 | **314 / 45** |
| change probes (z-above, z-below, z-below-card, y-chg; 23) | 21 / 21 | **0 / 0** |
| prior-balance and label-exclusion probes (x-excl, y-int; 30) | 11 / 11 | **0 / 0** |
| under-VAT and summary-block probes (x-under, x-in, y-mid; 20) | 16 / 15 | **3 / 2** (the 2 open above) |

*(Regrouped in round 25, LOW-3: this table first counted the z-\* CHANGE probes under "under-VAT" and x-excl
under "change + prior balance". The all-rows line and every per-row outcome are unchanged.)*
| reprint footers (x-rp; 23) | 11 / 11 | **0 / 0** |

**Newly refused: 0. Newly wrong: 0.** 57 wrong rows close. The 45 left: the 35 of round 23 (24 number-word
references and 6 glued hours, both accepted; 3 artefacts; 2 correct w-cnt posts), the 8 x-br six-figure branch
rows the reviewer ruled not a finding, and the 2 open HIGH-3 rows.

### Mutations — 12, all RED, restored byte-identically

Z1 the change label may CONTAIN change (1 — GREEN on the first run: every probe had no cash tender, so the
`cashChange` gate masked it; `CASH 1500.00 / Oil change 350.00` added) · Z2 the stray rule forgives change
without cash (1) · Z3 the item rows forgive change without cash (1) · Z4 prior balance unanchored (1) · Z5 no
summary-block check (1) · Z6 no between-net-and-total check (1) · Z7 the between check on paid slips too (2) ·
Z8 the summary-block check on paid slips too (1) · Z9 `COPY RECEIPT/INVOICE/No/digit` gone (1) · Z10
`DUP`/`RPRNT` gone (1) · Z11 `HERUITREIK`/`KOPIEER` gone (1) · Z12 `COPY -` gone (1).

---

## Round 25 — the net survives a null subtotal, the summary block is read by value, the tax row

Review: `review-k072-r24.md` (2H/0M/3L, no regressions; the item-column move changed no output). The reviewer
supplied a combined diff (`agents/rev-k072y/v6.diff`); it was read, not pasted. Two of its lines were rewritten
and both are covered below. Harness as in round 24 plus the reviewer's `y24`, `y24b`, `y24c` (228 probes):
**2 707 rows**, run twice — as stored, and with EVERY row's `subtotal` nulled (the reviewer's `run3.ts`).

| Finding | Disposition |
|---|---|
| HIGH-1 the item-column checks took the net from the stored subtotal; with `subtotal: null` 9 of 10 r23 HIGH-3 rows posted again, and `Labour 1000.00 / Delivery 100.00 / VAT 15% 150.00 / TOTAL 1150.00` (no sub total line) posted | FIXED. `unreconciledFigure` passes `known.subtotal ?? total − VAT`; the gate has already refused a null VAT. The honest twin without a sub total line posts (pinned). With every subtotal nulled the table is identical to the stored run (below). |
| HIGH-2 a figure on a summary-labelled line in the block explained itself by its first word (`Total Freight 350.00`, `VAT on delivery 52.50`, 13 of 13) | FIXED. A summary figure in the block is explained only by VALUE: it is the net, or the tax (total − net), or it and another summary figure add up to the total — the role-and-value rule rule 3 already applies below the total. **Changed from the diff:** the diff did not accept a figure equal to the tax, so a block of just `VAT 15% 150.00 / TOTAL 1150.00` (no sub total line) refused its own VAT line; it passes now (pinned). The diff's pairing test excluded the first index holding the value, not the figure itself — rewritten to compare indexes. 13 of 13 refuse with and without a stored net; `Sub Total / VAT / TOTAL` and `Total Excl / VAT / Total Incl` post with a stored net, a derived net, and no `known` at all. |
| the two cases pinned open in round 24 (`Delivery 150.00`, `Travel 149.99`) | CLOSED. On a document no payment settles, where the item rows sum to the total and more than one row prints, a row equal to the tax (total − net, within a cent) refuses. A label cannot decide it — `Burger 100.00 / Sauce 15.00` is honest and has the same shape — so a PAID slip is spared (pinned). `Travel 150.01` closes too. The round-24 "still open" test now asserts refusal. |
| LOW-1 12 reprint markings posted; `COPY\s+\d` refused a copy shop | FIXED: `COPY ONLY/RCPT/INV…`, `RE-PRT/REPRT/REPR.`, `RPT`, spaced `R E P R I N T`/`D U P L I C A T E`/`K O P I E`, `NOT AN ORIGINAL`, `SECOND PRINT`, `PRINTED AGAIN`. `Copy 2 of 2`/`Copy No 2` now refuse only as a line of their own, so `A4 COPY 50` and `Colour copy 10 x 2.50 25.00` are items and the Minuteman invoice posts again at R115 (pinned). The list still fails open for a spelling it lacks; **R-088 remains the real double-post exposure.** |
| LOW-2 the prior-balance END anchor and the whole-number skip in the block were unpinned (mutants GREEN) | PINNED: the reviewer's four "label + figure + more" rows, and `Sub Total / Delivery 350 / VAT / TOTAL`. The `CHANGE_LABEL` end anchor is pinned too, with the reviewer's `CASH 1850.00 / CHANGE 350.00 / Change brake pads 350.00`. |
| LOW-3 the round-24 table grouped the change probes under "under-VAT" | CORRECTED above. |

Tests changed because a second defence now refuses first (each still refuses): `k076-ocr-subtotal-reconciliation`
"refuses auto-post when the amounts were rebased" (the warning is no longer the ONLY defence; the block is the
second) and `k076-unattended-posting-gate` "refuses a VAT figure that disagrees" (its old text now refuses in the
block, so the VAT-disagreement check is pinned with a text whose block reconciles, and the old text is pinned as
refused).

### Re-measured — head vs `45e49cb48`, 2 707 rows

| | `45e49cb48` stored | **head** stored | `45e49cb48` subtotal null | **head** subtotal null |
|---|---|---|---|---|
| unattended / WRONG, all rows | 378 / 84 | **338 / 43** | 401 / 107 | **338 / 43** |
| summary role probes (e-sumrole; 15) | 15 / 13 | **2 / 0** | 15 / 13 | **2 / 0** |
| null-subtotal item rows (x-under/x-in/y-mid-vlmnull; 20) | 10 / 9 | **1 / 0** | 10 / 9 | **1 / 0** |
| x23 under-VAT (x-under; 10) | 2 / 2 | **0 / 0** | 9 / 9 | **0 / 0** |
| pinned-open tax rows (c-open; 3) | 3 / 3 | **0 / 0** | 3 / 3 | **0 / 0** |
| reprint markings (d-rp; 84) | 12 / 12 | **0 / 0** | 12 / 12 | **0 / 0** |
| ordinary controls (d-ok, o-ord; 29) | 17 / 0 | **18 / 0** (copy shop) | 17 / 0 | **18 / 0** |

**Newly refused: 0. Newly wrong: 0** — in both modes. The 43 WRONG left are the accepted classes only: 24
number-word references, 6 glued hours, 8 six-figure branch rows (ruled not a finding), 3 harness artefacts and
2 w-cnt probes that post their correct total.

### Mutations — 13, all RED, restored byte-identically

A1 no total − VAT net (1) · A2 the block explained by role alone (2) · A3 no pair rule (5) · A4 no tax-row rule
(2) · A5 the tax-row rule on paid slips (1) · A6 the prior-balance END anchor removed (1) · A7 the block skips
whole numbers (1) · A8 the change label's END anchor removed (1) · A9 `COPY RCPT/INV/ONLY` gone (1) · A10
`REPRT/RE-PRT/REPR./RPT` gone (1) · A11 spaced letters gone (1) · A12 `NOT AN ORIGINAL`/`SECOND PRINT` gone (1) ·
A13 `COPY` + digit anywhere again (1).

---

## Round 26 — the tax is explained once; `Copy N of M` anywhere; six VAT spellings

Review: `review-k072-r25.md` (1H/1M/3L). The reviewer's `agents/rev-k072z/v1.diff` was read and applied
deliberately; its two changes are kept as written, and three LOWs are closed beyond it. Harness as in round 25
plus the reviewer's `z25`/`z25b` (118 probes): **2 825 rows**, run as stored and with every subtotal nulled.

| Finding | Disposition |
|---|---|
| HIGH `Sub Total 1000 / Total Delivery 150.00 / VAT 15% 150.00 / TOTAL 1150` posted and approved (42 of 42) | FIXED (v1). A figure equal to the tax passed the block twice — as the tax (round 25's addition) and through the pair `150 + 1000` (v6's) — so a summary-labelled charge that coincides with the VAT hid in both. The tax is ONE figure: a second figure in the block equal to total − net refuses. 42 of 42 refuse on both routes, stored and with subtotal null (pinned, every label × three layouts plus the 2000 + 300 variants). **Stated fail-closed cost:** an honest block printing the VAT twice (`VAT 15% 150.00 / Total VAT 150.00`) refuses (2 of the reviewer's probes). |
| MEDIUM `TAX INVOICE COPY 2 OF 2`, `Invoice copy 2 of 2`, `Page 1 of 1  Copy 2 of 2` posted twice (a round-25 regression) | FIXED (v1): `COPY [No] N OF M` matches anywhere on a line; bare `Copy N` still only opening its line. `COPY #2` (posting at every SHA, the one z-rp wrong row) added too. The copy shop still posts R115 (pinned). z-rp 4 → 0. |
| LOW the re-pinned rebase test no longer pinned the warning | FIXED: the paid twin (`… Total Due 1160.00 / CARD 1160.00`) is the warning's own test — a paid document is spared the block check, so the warning is its only defence. Deleting `isUnreconciled(doc.warnings)` (`unattendedPostingGate.ts:105`) turns that test red (verified in isolation). |
| LOW the pair rule's `j !== i` was unpinned | PINNED: `Total Delivery 575.00` (half the total) refuses as `stray 575`. |
| LOW 6 honest VAT spellings refused on unpaid invoices | FIXED. `Plus VAT`, `Add: VAT`, `15% VAT`, `Add 15% VAT`, `Value Added Tax` open a tax line (`TAX_LINE_START`, `ocrPrintedFigures.ts`), so their figure is a summary figure explained by value, not an item row tripping the tax-row rule. **`Tax 15%` was different:** it was already a summary line; the regex VAT reader's generic `Tax` form read the RATE (15) as the amount, so the re-read VAT disagreed. That form now takes the optional rate and the same `(?![\d.,]*\s*%)` guard the bare VAT column has (`ocrAmountPatterns.ts`, still 299 lines). All six post at R1 150. The list fails closed and is pinned both ways for each spelling: `<spelling> 350.00` refuses (not the tax), and the same prefix before a non-tax word (`Plus Delivery 150.00`) is an item row and refuses. `BTW` was left out deliberately: added, it turned two BTW-only probes that the approval route passed into refusals, because the regex reader reads no VAT from `BTW` and a lone summary figure with no net is unexplained. |

**Correction to the reviewer's LOW-3 baseline:** `Tax 15% 150.00` did not post at `45e49cb48` on the auto-post
route — it refused there with "the VAT figure read is not the VAT the document prints" (the rate misread above).
Only the approval route passed it.

### Re-measured — head vs `5923eaf3c`, 2 825 rows (stored ≡ subtotal-null, row for row)

| | `5923eaf3c` | **head** |
|---|---|---|
| unattended / WRONG, all rows | 414 / 89 | **372 / 43** |
| tax-valued summary charges (z-taxsum; 42) | 42 / 42 | **0 / 0** |
| reprint markings (z-rp; 24) | 4 / 4 | **0 / 0** |
| VAT spellings and tax rows (z-taxrow; 18) | 9 / 0 | **15 / 0** |
| the reviewer's ordinary documents (z-ord; 14) | 9 / 0 | **9 / 0** |

Newly refused: **2**, both the stated double-VAT cost (zb-dbltax). Newly wrong: **0**. The 43 WRONG left are the
accepted classes only (24 number-word references, 6 glued hours, 8 six-figure branch rows, 3 artefacts, 2 correct
w-cnt posts). R-088 remains the real double-post exposure.

### Mutations — 8, all RED, restored byte-identically

B1 no second-tax check (1) · B2 a third tax figure needed (1) · B3 a figure pairs with itself (1) · B4 no tax-line
vocabulary (1) · B5 the `Tax` form reads the rate (1) · B6 `Copy N of M` only on its own line (1) · B7 `COPY #2`
gone (1) · B8 the rebase warning ignored (2 — the paid twin, and corpus R28).

---

## Round 27 — the round-26 tax spellings stay in the block; the tax is one value below the total too

Review: `review-k072-r26.md` (2H/0M/1L; the VAT-reader change and leaving `BTW` out both accepted). The reviewer's
`agents/rev-k072aa/fix.diff` was read; hunk 1 is kept, hunk 2 is replaced by a narrower rule that closes all 16.
Harness as in round 26 plus the reviewer's `aa26`/`aa26b` (145 probes): **2 970 rows**, stored and nulled.

| Finding | Disposition |
|---|---|
| HIGH-1 (regression of round 26) `Painting of lounge 1000.00 / Total R1 000.00 / Plus VAT 150.00` posted and approved R1 000 against R1 150 (16 of 16) | FIXED at the cause. Round 26's `TAX_LINE_START` spellings (`Plus VAT`, `Add: VAT`, `15% VAT`, `Add 15% VAT`, `Value Added Tax`) were meant for the summary BLOCK, and they made a summary line of themselves everywhere. Below the total, a line opening with one of them (`opensWithBlockOnlyTax`) now refuses: it says the total read is the pre-tax figure. The classic inclusive recap (`TOTAL 115.00 / VAT @ 15% 15.00`) is not one of them and still posts. **Hunk 1 kept** (`Plus`/`Add` after the total is an adjustment): it measured equivalent on all 2 970 rows, but it is the only rule that sees the pre-tax total printed AGAIN after the Plus line (`Total 1000.00 / Plus VAT 150.00 / Amount Due 1000.00` — rule 3 reads below the LAST print); pinned, and its mutant is RED. Closes aa-plus2 16 → 0 and the `15% VAT` / `Value Added Tax` after-total twins the reviewer did not list. |
| HIGH-2 `TOTAL 1150.00 / Total Freight 150.00` posted — the tax counted once only inside the block (16 of 39) | FIXED, 16 of 16, not 14. Below the total a summary figure equal to the stored VAT is explained only on a line that IS the tax (`TAX_ONLY_LINE`: `VAT`, `Total VAT`, `VAT INCL`, `Output Tax`, `VAT Summary`… with a rate and separators, nothing else). `Tax on levy` and `VAT on delivery` name a tax and are not one, so they refuse — the two hunk 2 left open. **Cost 0**: all four of the reviewer's honest double-VAT layouts and the corpus SPAR `CARD 115.00 / VAT @ 15% 15.00` still post; the recap nouns (`VAT Summary 15% 1000.00 150.00`) are allowed on the tax line after a measured refusal without them. |
| LOW-1 `Copy 2/2`, `Copy (2 of 2)`, `Print 2 of 2`, `Copies: 2 of 2` posted | FIXED: `COPY`/`COPIES`/`PRINT` `[:] [(] [No] N (of|/) M` anywhere. `Page 2 of 2`, `Pg 2/2` and the copy shop post (pinned). The reviewer's `Copies: 2 of 2` header on the copy-shop probe now refuses (a fail-closed cost on a probe with no payable). |

### Re-measured — head vs `a2c0cf028`, 2 970 rows (stored ≡ subtotal-null, row for row)

| | `a2c0cf028` | **head** |
|---|---|---|
| unattended / WRONG, all rows | 441 / 88 | **394 / 46** |
| after-total tax additions (aa-plus2; 16) | 16 / 16 | **0 / 0** |
| after-total tax-valued charges (aa-below; 39) | 14 / 14 | **0 / 0** |
| `Plus`/`Add` readings (aa-plus; 18) | 12 / 6 | **2 / 1** |
| honest double-VAT layouts (aa-dbl; 8) | 4 / 0 | **4 / 0** |
| the reviewer's ordinary documents (aa-ord; 14) | 8 / 0 | **8 / 0** |

**Newly wrong: 0.** **Newly refused: 5**, all the same deliberate shape: the model chose 1 150 on a document whose
printed total is `Total 1000.00` with `Plus VAT` / `Add: VAT` / `Add 15% VAT` / `15% VAT` / `Value Added Tax 150.00`
under it. The approval route used to approve the unprinted 1 150 (the correct payable, by luck); the gate now refuses
both readings, which is what the reviewer asked for ("the gate accepts whichever of the two totals the model
picked"). The 46 WRONG left: the 43 accepted classes, plus `Total 1000 / VAT 150.00` (the ordinary inclusive recap,
payable unknown by construction) and the reviewer's 2 `VAT line absent` rows that only the approval route approves,
at the correct R1 150 — the approval route never corroborates the VAT, by design (the reviewer did not score them).

### Mutations — 6, all RED

C1 no `Plus`/`Add` adjustment (1 — GREEN until the "printed again" probe was added) · C2 block-only tax lines
explain themselves below the total (1) · C3 no below-total tax-once check (1) · C4 any line naming a tax may carry
its value (1) · C5 no recap nouns on a tax line (1) · C6 the `Copy` siblings gone (1).

---

## Round 28 — the VAT must fit inside the total; approval needs a printed VAT

Review: `review-k072-r27.md` (1H/0M/3L, every round-27 claim reproduced). Harness as in round 27 plus the reviewer's
`ab27`, `ab27b`, `abord` (348 probes): **3 318 rows**, stored and nulled.

| Finding | Disposition |
|---|---|
| HIGH-1 `Total (excl. VAT) 1000.00 / VAT 15% 150.00`, no grand total, posted and approved R1 000 against R1 150 (42 rows) — round 27 called its own `Total 1000 / VAT 150.00` row ambiguous; it is not | FIXED, by arithmetic, on BOTH routes: refuse when `vat > total × 15/115 + 0.05` (`vatExceedsInclusiveTotal`, `unattendedPostingGate.ts`). The tax inside an inclusive total T is at most T × 15/115, and zero-rated lines only lower it, so a larger VAT means the total read is pre-tax (or the document contradicts itself). It needs no text, so it covers the image-only approval path too. The rate is a local `SA_VAT_RATE = 0.15`, not imported from `reports/vatBoxBasis` (that module reaches the DB client); holding a rate put the gate in scope of the `vat-guard-coverage` CI check (first CI run RED), and it is allowlisted there under NO CLAIM DECIDED with the reason — the rate only bounds a refusal, it computes, picks and forwards no claim. ab-xlbl 28 → 0, ab-h1 12 → 0, ab-incl 2 → 0. **Cost: 1** — r16 `O7 mixed basket VAT analysis`, whose own VAT (25.60 on R190.96) is inconsistent with its analysis (18.00 at the standard rate). Tolerance pinned: 130.48 on 1 000 passes, 130.49 refuses. |
| DECISION (lead): the approval-only rows that claim a VAT the document never prints | BUILT: unattended APPROVAL refuses when the document has text and its VAT is not printed AS the tax — the regex re-read the posting gate already uses must find the same VAT (`vatNotPrinted`). A 150.00 printed as `Total Delivery 150.00` is printed, but not as VAT, so "any printed figure" was rejected as the test. A zero VAT and a document with no text are not judged. aa-onlytax 2 → 0. **Cost: 3** — approval-only rows `BTW 150.00`, `Belasting 150.00` and `BTW @ 15% 150.00` (z-taxrow): the regex reader reads no VAT from `BTW`/`Belasting` (round 26 left `BTW` out for the same reason), so they now go to a person. Their auto-post route already refused them. |
| LOW-1 `Print: 05/09/2026 14:32` and `Print 05/09/26` refused (new in round 27) | FIXED: `N of M` / `N/M` / `N-M` may not run on into another digit or a separator and a digit, so a date is not a copy count. `Copy 2 of 2 14:32` still refuses (pinned). The reviewer's copy-shop item `Copies 2/3 A4` still refuses — fail closed, and indistinguishable from `Copies: 2 of 2`. |
| LOW-2 `Copy [2/2]`, `Copy 2-2` posted | FIXED: a `[` opens the form, `-` separates N and M. ab-copy wrong 2 → 0. |
| LOW-3 `Total Freight 1000.00` / `1150.00` under `TOTAL 1150.00` explained by value | FIXED: below the total, a summary figure equal to the total or the net is explained only on a line that IS a summary label (`isSummaryOnlyLine`: the summary vocabulary plus `Due/Amount/Payable/Incl/Excl/of/VAT/Tax/ZAR` qualifiers, or the round-27 tax line) — the role, not the value. Cost 0. Note: a reprint of the TOTAL is itself the last print of the total, so it never reaches rule 3; the net reprints (`Sub Total Excl VAT 1000.00`) are what exercise the qualifiers, and they are pinned. |
| `SET` / `LIQ` read as currency codes | FIXED narrowly: added to `NOT_A_CURRENCY` (neither is an ISO code). The reviewer's Builders `DRILL BIT SET` and Kwikspar `DISHWASHING LIQ` slips now pass (ab-ord 8 → 10 of 14). |

### Re-measured — head vs `edbcffb46`, 3 318 rows (stored ≡ subtotal-null, row for row)

| | `edbcffb46` | **head** |
|---|---|---|
| unattended / WRONG, all rows | 479 / 99 | **426 / 46** |
| pre-tax totals (ab-xlbl, ab-h1, ab-incl; 169) | 44 / 42 | **2 / 0** |
| approval-only derived VAT (aa-onlytax; 15) | 2 / 2 | **0 / 0** |
| rev-k072aa's ordinary documents (aa-ord; 14) | 8 / 0 | **8 / 0** |
| rev-k072ab's ordinary documents (ab-ord; 14) | 8 / 0 | **10 / 0** |

**Newly wrong: 0. Newly refused: 4** — the inconsistent O7 probe and the three `BTW`/`Belasting` approvals, as
stated above. 53 wrong rows close. The 46 left are the accepted classes (24 number-word references, 6 glued hours,
8 six-figure branch rows, 3 artefacts, 2 correct w-cnt posts) and the reviewer's 3 `Freight` / next-line `VAT
150.00` rows, which it scored unrealistic.

### Mutations — 10, all RED

E1 no VAT-capacity check on posting (1) · E2 … on approval (1) · E3 no 5-cent tolerance (2) · E4 no VAT-printed
check on approval (1) · E5 the VAT counted printed as any figure (1) · E6 a print date is a copy count (1) · E7 no
bracket or dash (1) · E8 a below-total summary explained by value alone (1) · E9 no qualifiers on a summary-only
line (1 — GREEN until the net-reprint probes were added; the total-reprint probes cannot reach rule 3) · E10
`SET`/`LIQ` currencies again (1).

---

## Round 29 — pre-tax totals by label and by position; approval never books an invented VAT

Review: `review-k072-r28.md` (2H/1M/2L, neither HIGH a regression). Harness as in round 28 plus the reviewer's
`ac28`–`ac28f` (280 probes): **3 598 rows**, stored and nulled. The run records the approved `taxAmount` too.

| Finding | Disposition |
|---|---|
| HIGH-1 the 15/115 bound cannot see a pre-tax total when ≥ 13% of the net is not standard-rated (`Consulting 800 / CIPC fee (no VAT) 200 / Total (excl. VAT) 1000.00 / VAT 15% 120.00`, 66 of 112 wrong) | FIXED with the lead's two structural rules, in a new `ocrPreTaxTotal.ts` called from `unreconciledFigure` (so both routes): **(a)** a line printing the total that says it excludes the tax (`excl…`, `exclusive`, `ex VAT`, `before VAT`, `nett of VAT`, `pre-tax`) refuses whenever a VAT is read — paid or not; **(b)** on a document NO payment settles, a tax line printed below the last print of the total is an ADDED tax and refuses — unless that line or the total's own line says the tax is included (`incl…`, `inclusive`, `included`, `portion`), the tax is already printed above the total, or the arithmetic proves it inclusive (VAT within 5 cents of total × 15/115 — `TOTAL 147.40 / VAT 19.23`, `Total 1000.00 / VAT 130.43`; without it two honest unpaid slips refused). Paid slips' recaps are not judged. **ac-mixpre 66 → 0** — nothing of the 66 is left. The rate and both 15/115 helpers now live in `ocrPreTaxTotal.ts`, so the gate holds no rate. |
| HIGH-2 approval passed a NULL VAT, and `buildInvoiceFromExtraction` (`aiInvoicePipelineService.ts:140`) invented 15/115 of the total as `taxAmount` | FIXED: `refusesUnattendedApproval` refuses a null VAT, text or no text (the builder invents the same figure on an image-only invoice). A zero VAT is not refused — it claims nothing. **What the invented figure feeds, and who relied on it:** both approval routes (`ai-invoice-pipeline.ts:120`, `capture/[id]/post.ts:135`) insert `invoiceInput.taxAmount` into `supplier_invoices.tax_amount`, and `approveSupplierInvoice` posts one VAT line from that header. With the refusal, a null-VAT invoice is never `approved` unattended on either route — both force `draft`/`manual_review` when the gate refuses, including `auto_publish` — so the fabricated figure now reaches only a DRAFT that a person approves in the attended workflow (the vat-guard allowlist's own "attended" entry for `supplierInvoiceWorkflowService`). No unattended caller relies on it; the builder is left as is for the attended draft, as the lead allowed. ac-null 5 → 0 and ac-nullvat 2 → 0 approvals; corpus X2 now refuses on the approval route as its pinned outcome says. |
| MEDIUM-1 the vat-guard allowlist entry exempted the whole gate file | FIXED: every `ALLOWED` entry now names the KINDS it is excused for (`AllowedEntry { kinds, reason }`, all 15 entries scoped to the kinds they show today), and the check fails on any kind outside its entry (`kindsNotExcused`, unit-tested in `vatGuardRules.test.ts`). **Proved by outcome:** appending the reviewer's `allocateTransaction(… { vatType: 'standard' })` poster to the rate-only file turns the check red (`not excused: vat_field_on_a_posting_path, allocate_call`, exit 1), then restored byte-identically. The rate-only entry moved with the rate from `unattendedPostingGate.ts` to `ocrPreTaxTotal.ts`. |
| LOW-1 the VAT-printed check cost ≥ 7 approvals | FIXED by teaching the VAT reader: leader dots are blanked before the VAT patterns (`blankFillers`, as the figure readers do), `=` is a value separator, `BTW` joins `VAT_WORD` and `Belasting` the `Tax` form and `TAX_WORD`. ac-sp-inv 31 → 37 of 37; the three `BTW`/`Belasting` rows refused on approval in round 28 now post; four ordinary Afrikaans slips (k-ord O13, O14, O17, u-ord U11) approve for the first time; 0 newly wrong. Money-beside probes pinned for each: `Delivery.........150.00`, `Delivery = 150.00`, `BTW No 4123456789` and `BELASTINGFAKTUUR Nr 5521` are not read as the VAT. |
| LOW-2 `Copy No: 2 of 2` posted | FIXED (`No` takes a colon). `Customer copy 2/2` still posts, by the round-23 decision (the one ac-copy row the harness counts, payable unknown). |

### Re-measured — head vs `19c4123b3`, 3 598 rows (stored ≡ subtotal-null, row for row)

| | `19c4123b3` | **head** |
|---|---|---|
| unattended / WRONG, all rows | 574 / 114 | **508 / 47** |
| mixed-rate pre-tax totals (ac-mixpre; 112) | 66 / 66 | **0 / 0** |
| null-VAT approvals booking an invented tax (ac-null, ac-nullvat; 13) | 7 approved | **0** |
| invoice VAT spellings (ac-sp-inv; 37) | 31 | **37** |
| the reviewer's ordinary documents (ac-ord; 13) | 5 / 0 | **5 / 0** |
| aa-ord / ab-ord (14 each) | 8 / 10 | **8 / 10** |

**Newly wrong: 0.** **Newly refused: 13**, all deliberate: corpus X2 and the 7 null-VAT approvals (HIGH-2), and 5
approval-only rows where the model chose an unprinted 1 150 over the printed `Total 1000.00` with a bare `VAT 150.00`
under it (the round-27 shape; rule (b) now refuses both readings). The 47 WRONG left: the 43 accepted classes, the 3
ab-h2 next-line `VAT` rows scored unrealistic, and `Customer copy 2/2` (correctly ordinary).

### Mutations — 13, all RED

G1 no pre-tax label rule · G2 no tax-line-below rule · G3 the below rule on paid slips (Kwikspar recap) · G4 no
inclusive arithmetic (2) · G5 no tax-above exemption · G6 no `incl` marker on the tax line · G7 a null VAT approved
· G8 no leader blanking · G9 no `=` separator · G10 `BTW` not a VAT word · G11 `Belasting` not a tax word · G12 `Copy
No:` without its colon · G13 the allowlist excuses the whole path.

---

## Round 30 — no VAT is ever invented; the arithmetic exemption narrowed

Review: `review-k072-r29.md` (0H/1M/3L, no regression). Harness as in round 29 plus the reviewer's `ad1`–`ad6`
and `cp` (2 206 probes; `ad3b` is a VAT-reader set, used directly): **5 804 rows**, stored and nulled.

| Finding | Disposition |
|---|---|
| MEDIUM-1 a null-VAT capture draft stored the invented `tax_amount` (130.43) and the MCP approve tools could post it | **DECISION applied: VAT is no longer invented.** `buildInvoiceFromExtraction` with no VAT read builds `taxAmount 0` at a **0% rate** (invoice and lines — the "As per invoice" line at the total), and `notes = VAT_UNREAD_NOTE` ("VAT was not read … carries NO VAT … cancel it and enter the bill with its VAT … an agent cannot approve this bill"). **Every consumer traced:** the builder has two callers, `capture/[id]/post.ts` and `ai-invoice-pipeline.ts`; both now write `notes` into `supplier_invoices` (and 0 line tax into `supplier_invoice_items`). The UI draft (`supplier-invoices/[invoiceId].tsx`) renders `notes`; **it has no field to edit a draft's tax** (`supplier-invoices-detail` PUT edits number, dates, terms and notes only), so the note tells the person to re-enter the bill rather than to type the VAT in — a tax-edit field would be a feature, flagged, not built. Approvers of that draft: the two human action routes (attended), `recurringTransactionInvoices` (its own template drafts only) and the two **MCP approve tools**, which now REFUSE it: `approve_supplier_invoice` answers a tool error, `bulk_approve_supplier_invoices` SKIPS it (dry run and live alike) — `capture/capturedVatUnread.ts` reads the captured document itself (`extracted_data.vatAmount` null or absent), so a LEGACY draft still carrying an invented 130.43 is refused too. **Proved against the DB** (`k072-capture-vat-unread.int.test.ts`, 4 tests): both routes store tax 0 / rate 0 / line tax 0 / the note; both MCP tools refuse the legacy draft and it stays `draft` with no journal; and the other direction — a captured bill whose VAT was read is approved by the same tool and its journal debits R150 to VAT Input. Mutating the builder back, or either tool's check, turns that file red. The vat-guard allowlist reason for `supplierInvoiceWorkflowService` now states the r30 facts. |
| LOW-1 rule (b)'s arithmetic exemption posted a pre-tax total when its VAT coincided with 15/115 of it (`Fee 1000.00 / Deeds fee (no VAT) 150.30 / Total 1150.30 / VAT 15% 150.00`) | FIXED: the exemption is void when any line is marked not standard-rated — `no VAT`, `non-VAT`, `exempt`, `zero rated`, `0%`, `vrygestel`, `geen BTW`, `nulkoers`, `(Z)`, and `disbursement` (the reviewer's suggestion; the lead's list plus it — a disbursements line is what the remaining "unmarked" probes carried). Rule (a) learns `Exc`, `Ex-VAT`, `w/o VAT`, `without VAT`, `Eks.`/`Eksklusief`, `sonder BTW`, and — only AFTER the total's figure, so `Nett Amount Due 1150.00` stays payable — the trailing net labels `Nett`/`Net Amount`/`Netto`, `Sub(total)`, `Subtotaal`, `Goods Value`, `Taxable …`, `uitgesluit`. **Of the reviewer's 125 (bare labels), 0 are left**; on my count, which also scores the `… Due` labels, ad-near 200 → 0, ad-nlbl 62 → 0, ad-coinc 15 → 0. |
| LOW-2 four green mutants | PINNED: the window's lower edge on 1 000 (130.39 inclusive, 130.38 not), `before VAT`, `nett of VAT` (each in a paid probe, where only rule (a) can catch it), and `incl` on the total's own line (a mixed-rate `Total Incl VAT 1000.00 / VAT 104.35` recap posts). All four mutants are RED now. |
| LOW-3 `VAT = 15%` read as a VAT of 15 | FIXED: `VAT_PATTERNS[1]` takes the same `(?![\d.,]*\s*%)` guard as the bare column. All 18 of the reviewer's legend slips re-read the real `VAT 2.61` — including `VAT: 15%`, which read 15 before round 29 too. |

### Re-measured — head vs `38a6a6b17`, 5 804 rows (stored ≡ subtotal-null, row for row)

| | `38a6a6b17` | **head** |
|---|---|---|
| unattended / WRONG, all rows | 1 118 / 324 | **845 / 47** |
| coincidence and near-inclusive pre-tax totals (ad-near, ad-nlbl, ad-coinc; 972) | 277 wrong | **0** |
| null-VAT drafts carrying an invented tax (ac-null, ac-nullvat) | 12 | **0** |
| VAT-registration letterheads (ad-reg, ad-regf; 392) | 326 / 0 | **330 / 0** |
| the reviewer's ordinary documents (ad-ord; 14) | 6 / 0 | **6 / 0** |

**Newly refused: 0. Newly wrong: 0.** The 47 WRONG left are exactly round 29's accepted classes.

### Mutations — 13 unit (H1–H13) + 3 integration, all RED

H1 the builder invents a VAT again (also RED in the integration file, 2 tests) · H2 zero-rated lines ignored · H3
`disbursement` not a marker · H4 no trailing net labels · H5 net labels anywhere on the line · H6 tolerance 1.00 ·
H7 no `before VAT` · H8 no `nett of VAT` · H9 `incl` on the total's line ignored · H10 a rate legend read as the VAT ·
H11 single MCP approve ignores unread VAT (RED in unit and integration) · H12 bulk MCP approve ignores it (RED in unit
and integration) · H13 the Afrikaans/abbreviated forms gone.

---

## Round 31 — every capture path, censused by pattern and by consumer: no VAT read, no VAT claimed

Review: `review-k072-r30.md` (0H/1M/3L, no regression). Round 30 walked only `buildInvoiceFromExtraction`'s two
callers — census failure mode 6 (a site that re-implements the rule is not a caller). This round censuses twice.

### Census 1 — BY PATTERN: every place in `src/` and `pages/` that derives a VAT from a total

`grep` for `15/115`, `/ 1.15`, `* 1.15`, `0.1304`, `* 15 / 115`, `/ 115`, `(100 + RATE)`, `/ (1 + rate/100)` and
`vatFromInclusive`/`inclusiveVat`:

| Site | What it derives | Reachable from capture? | Disposition |
|---|---|---|---|
| `aiInvoicePipelineService.buildInvoiceFromExtraction` | supplier-invoice `taxAmount` = 15/115 × total when VAT null | yes — `capture/[id]/post`, `ai-invoice-pipeline` | fixed r30 (0, 0%, note) |
| `receiptToJournalService.buildExpenseJournalFromReceipt:158` | VAT Input leg = total − total/1.15 when VAT **or the net** null | yes — `receipt-to-journal`, `pettyCashJournalService` (post-expense, anonymous) | **fixed r31** |
| `capture/[id]/post-expense.ts:165` (employee branch) | claim-line `vatAmount` = total/1.15 × 0.15 | yes | **fixed r31** |
| `provisionalPostingService.ts:231` | net/VAT from a bank line's guarded vat code | no — a bank transaction, `sourceDocumentId` undefined, the code resolved through `resolveRuleVatCode` | out of scope: the derivation IS what a standard-coded bank line means |
| `bankRuleAutoPostLine.ts:138`, `bankAllocationService.ts:186/590` | net/VAT from a rule's or a user's vat code | no — bank rules and allocations | out of scope, same reason (guarded / attended) |
| `sageSupplierInvoiceImportService.ts:67`, `sageCustomerImportService.ts:53` | `subtotal = total / 1.15` when the Sage row has none | no — Sage migration import | out of scope; **flagged**: an imported Sage bill with no subtotal gets a derived VAT the same way — a separate item for the lead |
| `ar/disputeResolution.ts:119` | credit-note net from gross at the invoice's own rate | no — AR output VAT, rate from the invoice | correct derivation |
| `customer-quotes/index.tsx:104`, `customer-sales-orders/index.tsx:108` | `subtotal × 1.15` for display | no — display only | none |

### Census 2 — BY CONSUMER: every writer of a VAT Input line or an input-VAT tax amount reachable from capture

Walked from the captured document outward (every file reading `extracted_data`/`ExtractedDocument`, then every
writer of `supplier_invoices.tax_amount`, `expense_claim_lines.vat_amount` or a `vat_input` journal line, then every
poster of what they write):

| Writer (from capture) | Writes | Posted by | Disposition |
|---|---|---|---|
| `capture/[id]/post`, `ai-invoice-pipeline` | `supplier_invoices.tax_amount` | `approveSupplierInvoice`: 2 attended routes, recurring (own drafts), **MCP `approve_supplier_invoice` / `bulk_approve_supplier_invoices`** | r30: 0 + note; MCP refuses unread capture |
| `receipt-to-journal` | draft/posted journal, VAT Input leg | auto-post (gate refuses null VAT), attended `journal-entries-action`, **MCP `post_journal`** | **r31**: no VAT leg + flag; **MCP `post_journal` refuses** a draft whose captured document's VAT was never read |
| `post-expense` anonymous → `pettyCashJournalService` | the same draft journal | the same | **r31**, same |
| `post-expense` employee → `expenseClaimService.createClaim` | `expense_claim_lines.vat_amount` / `vat_code` | `postClaim` via `expense-claims/[id]/post` (a person approves) — no MCP expense-claim tool exists | **r31**: VAT 0, code `none`, the line says so; the approver can enter it (`expense-claims/[id]/lines/[lineId]` PUT takes `vatAmount`) |
| `doc-auto-invoice` | nothing — returns proposed invoice data; `Number(vatAmount \|\| 0)` invents nothing | — | none |
| `document-capture-action` (confirm) | `captured_documents.vat_amount` (person-entered) | no posting route reads that column | none (fails closed, per the r30 review) |
| `multiDocMatch*`, `bank-tx-attachments`, `captureBankTxAttachService`, `evidenceAttachmentService`, `fourWayMatchService`, inbound email / WhatsApp | no tax amount, no journal | — | none |
| Other posters of an existing draft journal | `journal-entries-action` (attended); `closeRunService` — **corrected r32:** it proposes EVERY balanced draft journal in the period (`closeRunRepo.fetchDraftJournals` → `closeRunProposalBuilder`), capture drafts included, not only its own; each is posted only when a person approves that proposal (`decideProposal`, attended) | — | none (attended) |

| Finding | Disposition |
|---|---|
| MEDIUM-1 the receipt builder and the employee claim line invented VAT; MCP `post_journal` posted it | FIXED as above. `buildExpenseJournalFromReceipt`: a VAT that was read is kept (a missing net is now total − VAT, instead of re-deriving BOTH); no VAT read → VAT 0, the gross on the expense, `vatType 'no_vat'`, description suffix `— VAT not read from the document, none claimed`, and the route warning says no VAT is claimed. `post_journal` refuses via `journalHasUnreadCapturedVat`, read off the captured document as round 30's invoice check is, so a legacy draft carrying 130.43 is refused too. **Proved on the DB** (`k072-receipt-vat-unread.int.test.ts`, 5 tests): both journal paths write no VAT leg; `post_journal` refuses them, a legacy draft with a 130.43 VAT Input line, and a document with no `vatAmount` key — each stays `draft`; the employee claim line is VAT 0 / `none` / flagged; the other direction, a read VAT, keeps it and posts through `post_journal`. `k072-receipt-entertainment-vat` still holds (a denied meals slip is gross on the expense either way; its comment updated). The allowlist reason for `supplierInvoiceWorkflowService` now says r30–r31. |
| LOW-1 a legend or a `0%` term anywhere voided the exemption (16 of 18 honest slips) | FIXED: the not-standard-rated marker counts only on an ITEM line ABOVE the total that prints an amount. ae-legend 1 → 17 of 18 unattended (the 18th, `Geen BTW op uitbetalings`, reads as a refund at every SHA). A marked priced item line (`Bread (Z) 150.00`) still voids it, and a `Zero Rated 0.00` recap BELOW the total does not (both pinned). |
| LOW-2 an unmarked pre-tax total inside the 5-cent window posts | **DISCLOSED RESIDUAL, kept as the lead decided.** Measured: 6 of the reviewer's 15 `ae-nomark` rows post (R1 150.30 against R1 300.30; R920.24 against R1 040.24), identical at `38a6a6b17` and `eb7f54a5f`, stored and nulled; the other 9 fall outside the window and refuse. **Rate:** it needs a pre-tax mixed-rate invoice with NO grand total printed AND a no-VAT share that lands the VAT within ±5 cents of total × 15/115 — a window of about ±R0.33 of standard-rated value, so roughly 0.67/T of such invoices (under 0.1% at R1 000). **Why kept:** nothing in the text separates it from an honest inclusive document, and dropping the exemption refuses ordinary unpaid slips that print `Total / VAT` below (`TOTAL 147.40 / VAT 19.23`). Pinned as OPEN in `k076-round31-policy.test.ts`, so any change to it is seen. |
| LOW-3 "absent `vatAmount`" unpinned | PINNED on the DB for both helpers: a captured document with no `vatAmount` key is refused by `approve_supplier_invoice` (`k072-capture-vat-unread`) and by `post_journal` (`k072-receipt-vat-unread`). The reviewer's mutant (drop the `COALESCE`) is RED in each. |

### Re-measured — head vs `eb7f54a5f`, 5 852 rows (stored ≡ subtotal-null, row for row)

unattended / WRONG **859 / 53 → 875 / 53**: 16 newly correct (ae-legend), **0 newly refused, 0 newly wrong**. The 53
WRONG are the 47 accepted classes and the 6 disclosed ae-nomark residual rows. The receipt and claim changes do not
show in this harness (it scores the posting gate, not the draft's VAT); they are proved in the integration files.

### Mutations — 4 unit + 5 integration, all RED

K1 the receipt builder derives VAT again (3) · K2 an unread receipt keeps the `standard` vat type (2) · K3 legend
lines void the exemption (1) · K4 the whole document scanned for markers (1 — GREEN until the below-the-total `Zero
Rated 0.00` recap was pinned) · I1 the receipt builder derives again (integration, 2) · I2 the employee claim derives
again (1) · I3 `post_journal` ignores unread VAT (3) · I4 the journal check treats an absent key as read (1) · I5 the
invoice check treats an absent key as read (1).

---

## Round 32 — the draft's VAT must BE the document's VAT; a bare `Total` proves nothing on an unpaid bill

Review: `review-k072-r31.md` (0H/1M/3L, no regression). The round-32 fixer died in a reboot with this work
uncommitted; it was taken over, reviewed, extended and re-measured on a rebuilt harness (below).

| Finding | Disposition |
|---|---|
| MEDIUM-1 the r30–r31 check refused only a document whose VAT was NEVER read; the old builders also invented 15/115 when the VAT was read and the net was not, and `post_journal` posted such legacy drafts (R117.42 on a slip printing `VAT 0.00`, R18.26 on one printing 13.04) | FIXED by comparison, not by shape: `capture/capturedVatUnread.ts` → **`capturedVatEvidence.ts`**. `invoicesWithUnevidencedVat` refuses a supplier invoice whose `tax_amount` differs by more than a cent from `extracted_data.vatAmount` of the captured document it was raised from (null, absent or non-numeric = NONE = 0); `journalHasUnevidencedVat` does the same for a draft journal's net VAT Input (the net debit on `vat_input`-subtype lines — the subtype the receipt builders resolve the leg by). Used by `approve_supplier_invoice` (tool error), `bulk_approve_supplier_invoices` (SKIP, dry run and live alike) and `post_journal` (tool error). **Consequences, both directions:** the routes' own no-VAT draft of an unread document now posts/approves through the MCP tools as it stands, claiming none (it used to be refused outright); `VAT_UNREAD_NOTE` no longer says an agent cannot approve it. **Cost, stated:** a draft that claims LESS than the document's VAT is refused too — notably a denied-input receipt (`vat_input_denied`, entertainment) whose read VAT went to the expense: `post_journal` refuses it where r31 posted it; a person posts it (read from `buildExpenseJournalFromReceipt`, which puts a denied VAT on the expense leg — not exercised by a test). Documents not raised from capture (no `source_document_id`) are not judged. **Proved on the DB:** `k072-capture-vat-unread` — both tools refuse 117.42-on-0.00 and 18.26-on-13.04 legacy bills, which stay `draft` with no journal, and the pipeline's own no-VAT draft is approved with no VAT Input line; `k072-receipt-vat-unread` — `post_journal` refuses both legacy journal shapes, posts the same slip's draft carrying its read 13.04, and posts the routes' own no-VAT drafts claiming none. The vat-guard allowlist reason for `supplierInvoiceWorkflowService` states the r32 rule. |
| LOW-1 narrowing the marker to priced lines above the total made 5 inputs newly WRONG: bare legend tokens (`Z`, `*`, `D`, `E`) and the split-column layout | FIXED in `ocrPreTaxTotal.marksAnItem`: a LEGEND that defines a token as zero-rated/exempt/no-VAT (`Z = zero rated`, `* = zero-rated items`, `D = disbursement, no VAT`, `E = Exempt`, `(Z) Zero rated`, `Note: Z zero rated`, `Items marked with an E are exempt`, `gemerk V`, `unless marked Z`; read per `,`/`;`/column segment) voids the exemption when that token stands alone (not inside a word, not inside a `**` run) on any ITEM above the total. An item is a priced line OR a description whose price the layout split into a later figure-only line, for both the marker words and the tokens. The legend line itself is never an item. af-legend-bare 4 → 0, af-colsplit 1 → 0, and their `Amount Due` twins (ag-legend-bare 4, ag-colsplit 1) → 0. The round-30 legend slips: under `Amount Due` all 17 still post (ag-legend 17/17); under a bare `Total` they refuse — by the payable rule below, not by the legend (the LOW-1 fix alone, measured before the payable rule, kept them 17/17). |
| The residual, re-opened: ±R0.38 window, a fixed fee pair hits it on every invoice | **CLOSED as measured.** On a document no payment settles, the arithmetic exemption (VAT within 5 cents of total × 15/115) now also requires the total's own line to name it payable: `Amount/Balance/Total Due`, `Amount/Total/Balance Payable`, `Bedrag/Saldo/Totaal Verskuldig/Betaalbaar`. A bare `Total` with a VAT line below it and no payable label refuses. **The window, corrected:** with standard-rated net N and no-VAT share Z, a pre-tax total N + Z read against VAT 0.15N lands within 5 cents when \|0.15N − (N+Z)·15/115\| ≤ 0.05, i.e. Z within **±R0.38** of 0.15N (round 31 said ±R0.33). **Also closed, found while testing the Afrikaans labels:** rule (b) skipped a total no `TOTAL_PATTERNS` entry reads (`Bedrag Verskuldig`, `Faktuurbedrag`, `Invoice Amount`) — `end === null` exempted it. It now falls back to the end of the last line printing the total's figure (`lastPrintEnd`); cost 0 on the harness. **Remaining residual (disclosed, pinned as OPEN in `k076-round32-policy`):** a pre-tax figure the document ITSELF labels `Amount Due`, with the VAT added below and no marker, inside the ±R0.38 window — ag-nomark 2 of 10. The document then contradicts itself; nothing in the text separates it from an honest one. |
| R-090 `evidenceAttachmentService` vouches for a derived VAT | **Registered, not fixed here** (orchestrator's decision). Listed so the census of consumers is complete. |
| LOW-3 the census said `closeRunService` posts only its own proposals | CORRECTED in the round-31 consumer census: it proposes every balanced draft journal in the period, capture drafts included; each posts only when a person approves that proposal (attended). |

### Re-measured — head vs `79d3a99c7`, 4 460 rows (stored ≡ subtotal-null, row for row)

**Harness rebuilt after the reboot** (`<scratchpad>/agents/fix-k072p/{harness,mine}`): `run2.ts`/`run3.ts`,
`tab.py`'s scoring and 15 probe sets recovered verbatim from the session transcripts and replayed —
r21, r21o, r21c, r21r, r21h, w22, x23all … af32all, every row count equal to round 31's — plus the corpus (177)
and ag32due (39, the round-32 `Amount Due` relabels, rebuilt by the same snippet). **`every.json` (1 462 rows) was
NOT recovered**: its generator chain runs back through rounds 13–20. The pre-reboot run of this same change on
5 883 rows (every included, recorded in the fixer's transcript) found 0 `every` rows relying on the arithmetic
exemption, and the same 22 / 17 / 0 as below.

| | `79d3a99c7` | head | head without the payable rule |
|---|---|---|---|
| unattended / WRONG, all 4 460 rows | 764 / 63 | **725 / 46** | 754 / 53 |
| the 13 ordinary sets (corpus, f/x/x-vlm/a-chg/o/z/aa/ab/ac/ad/ae/af-ord; 351) | 125 | **125** | 125 |

**Newly wrong: 0. Closed wrong: 17** — ae-nomark 6 (the residual), af/ag-legend-bare 8, af/ag-colsplit 2, one ab-h2
next-line `VAT` row. **Newly refused: 22, all by the payable rule and all the one shape it targets** — an UNPAID
document printing a bare `Total` with an inclusive VAT line below it: ae-legend 17 and ae-legend-ctl 1 (bare `Total`,
legends irrelevant — their `Amount Due` twins all post), ab-incl 2 (`Total 1000 / VAT 130.43`), zb-incl 1, af-zzero 1.
**No ordinary document in any set lost unattended posting.** The kept choice: the unpaid bare-`Total`/VAT-below
honest slip (round 31's `TOTAL 147.40 / VAT 19.23`) now goes to a person, because on the text alone it is the fee-pair
pre-tax invoice. The 46 WRONG left are the accepted classes (24 number-word references, 6 glued hours, 8 six-figure
branch rows, 2 w-cnt, 1 d-ok, 2 ab-h2 scored unrealistic, 1 `Customer copy 2/2`) and the 2 ag-nomark residual rows.

### Mutations — 12 unit + 6 integration, all RED, restored byte-identically (md5)

L1 no payable label needed (8) · L2 no Afrikaans payable labels (3) · L3 legend tokens ignored (10) · L4 no split
column (1) · L5 a `**` run counts as `*` (1) · L6 a token inside a word counts (1) · L7 no `(Z)` legend form (1) · L8
no bare-space legend (1) · L9 no legend after a colon (1) · L10 no `marked with` (1) · L11 the legend line is an item
(1) · L12 no last-print fallback (1) · I1 invoice check refuses only an unread VAT (2) · I2 journal check likewise (3)
· I3 an unread invoice VAT counts as the draft's own figure (2) · I4 journal tolerance R200 (2) · I5 invoice check
refuses every captured bill (2) · I6 journal VAT Input read off no account (3).

---

## Round 33 — "none read" is none only on a page that prints no tax; the draft's VAT is every tax line

Review: `review-k072-r32.md` (1H/0M/2L; numbers reproduced exactly). Reviewer's probes: `agents/rev-k072ag/`.

| Finding | Disposition |
|---|---|
| HIGH-1 (regression from r31) round 32's "none read = 0" let an agent approve a bill whose VAT the text reader MISSED: `VAT INCL 375.00` approved Expense 2 875 / AP 2 875 with no VAT Input; `Incl. VAT 375.00` (read as a total of 375) approved an AP of R375 on a R2 875 invoice | FIXED, **the lead's decision**: `capturedVatEvidence.evidencedVat` — the VAT read if one was read; else **0 only when the document's text prints no tax at all**, else nothing is evidenced and the draft is refused, as in r31. "Prints tax" is the reader's own `TAX_WORD` (`VAT`, `V.A.T.`, `BTW`, `Tax`, `Belasting`, now exported from `ocrAmountPatterns`) with a leading word boundary and NO trailing one, so `VATNo:`, `BELASTINGFAKTUUR` and `Taxi` all count (fail closed), plus a bare `15%`. A document with no text evidences nothing. So `TAX INVOICE` or a VAT number on the letterhead is enough to refuse a no-VAT draft. **Proved on the DB** (`k072-capture-vat-unread`): both of the reviewer's Bosman shapes, run through `extractFromText` → `ai-invoice-pipeline` → both MCP tools, are refused and stay `draft` with no journal; a no-text bill is refused. Round 32's path is kept: a genuine no-tax slip's no-VAT draft still approves/posts claiming none (`k072-capture-vat-unread`, `k072-receipt-vat-unread`, whose no-VAT fixture now carries a no-tax text instead of an empty one). |
| LOW-1 only `vat_input` lines counted as the draft's VAT; 130.43 on a `vat_output` debit, a generic `tax` account (box 15) or a NULL-subtype "VAT Payable" posted against an unread document | FIXED: `journalHasUnevidencedVat` takes the net debit on EVERY tax account, decided by what the account is: subtype matching `vat`/`tax` (`vat_input`, `vat_output`, `tax`, any spelling), or a NAME containing the word VAT, BTW or "value added" whatever the subtype. It fails closed: an expense named with VAT counts too. **Proved on the DB** (`k072-journal-vat-evidence`, new): all three shapes, and `vat_input`, are refused on a no-tax document; a CREDIT to VAT Input (the reversal shape) nets negative and is refused. |
| The denied-entertainment cost (Spur, flagged-account receipts refused by `post_journal` at r32) | FIXED with the builder's own rule, so it is precise: a draft claiming 0 against a read VAT > 0 is consistent when the builder would have folded that VAT into the expense (s17(2)(a)) — **every** non-tax debit is on an account with `vat_input_denied`, or the vendor is a meals merchant (`parseReceiptType === 'meals'`, the same call `buildExpenseJournalFromReceipt` makes). Pinned on the DB: the flagged-account draft and the Spur draft post; the same draft on an ordinary expense is refused; half on a denying account, half not, is refused. |
| Payable-rule cost: of the reviewer's 18 realistic unpaid invoices, 10 posted unattended at `79d3a99c7`, 5 at `cbe8d5497`; add `Grand Total` and `Invoice Total` as payable labels, pinning a pre-tax probe for each to prove they do not reopen the residual | **MEASURED, NOT ADMITTED — the premise failed.** With both added, the 18 recover **5 → 7** (IT support `Invoice Total 1725.00 / VAT 225.00`, courier `Grand Total R 460.00 / VAT R 60.00`), but the harness finds **2 newly WRONG**: the r31 reviewer's own residual rows *are* labelled `Invoice Total` — `Invoice Total 1150.30 / VAT 150.00` posts R1 150.30 against R1 300.30, and `Invoice Total 920.24 / VAT 120.00` posts R920.24 against R1 040.24 (ae-nomark; stored and nulled alike). `Grand Total` is the same label class: it names the last figure printed, not the amount owed, so the unmarked fee pair under it posts too (unit-probed). Both stay out of `PAYABLE`; the unmarked in-window fee pair under each is pinned REFUSED, and the cost — an honest unpaid `Grand/Invoice Total … / VAT …` goes to a person — is pinned too (`k076-round33-policy`). **For Hein:** admitting them buys 2 of 18 ordinary invoices at the price of reopening the fee-pair wrong post for those labels. Bare `TOTAL`/`Totaal` keep refusing. Also learned: the legend form `Items with a Z are zero-rated` (the reviewer's rv-pin row, WRONG at `cbe8d5497`, now refuses). |
| LOW-2 four behaviours unpinned | PINNED: the payable label must be on the total's OWN line (`Amount due within 30 days` in a footer does not count — mutant U2 RED); the legend is read per segment (`S = Standard 15%, Z = Zero rated` defines Z — U3 RED); both one-cent tolerances on the DB, each edge both ways (invoice 150.01/149.99 approve, 150.02/149.98 refused; journal 130.44/130.42 post, 130.45/130.41 refused — I4/I5 RED). |

### Re-measured — head vs `cbe8d5497`, 4 481 rows (stored ≡ subtotal-null, row for row)

Harness as in round 32 plus the reviewer's `rv-unpaid` (18) and `rv-pin` (3).

| | `cbe8d5497` | head | head + `Grand/Invoice Total` (not shipped) |
|---|---|---|---|
| unattended / WRONG, all rows | 731 / 47 | **730 / 46** | 734 / 48 |
| the reviewer's 18 unpaid invoices | 5 / 0 | **5 / 0** | 7 / 0 |
| the 13 ordinary sets (351) | 125 | **125** | 125 |

**Newly wrong 0, newly refused 0; closed wrong 1** (rv-pin `Items with a Z are zero-rated`). The 46 WRONG left are the
accepted classes and the 2 disclosed ag-nomark rows. The MCP changes (HIGH-1, LOW-1, denial) are outside this harness
(it scores the posting gate); they are proved on the DB above.

### Mutations — 12 unit + 10 integration, all RED, restored byte-identically (md5)

L1 no payable label needed (14) · L3 legend tokens ignored (12) · L12 no last-print fallback (1) · U2 payable label
anywhere on the page (1) · U3 legend read per line (1 — GREEN until the probe's `S` item was removed, which had
marked the fee by itself) · L13 no `with a Z` legend (1) · L14 `Grand/Invoice Total` payable (6) · E1 none read is
always none (10) · E2 no `15%` marker (1) · E3 no text counts as none (1) · E4 the tax word must end the word (2) ·
I1 none read is always none (DB, 3) · I2 only `vat_input` is VAT (1) · I3 debits only (1) · I4 two-cent tolerance
(2) · I5 no tolerance (2) · I6 no denied fold (1) · I7 any denying debit suffices (1) · I8 meals merchants ignored
(1) · I9 accounts not read by name (1) · I10 generic `tax` subtype not VAT (2).

**Gate note:** `k072-capture-vat-unread` now calls `ai-invoice-pipeline` 5 times; the route's AI limiter allows 20 per
IP per 15 minutes on the shared fixture (`rate_limit_counters`), so back-to-back mutation runs 429 it. A 429 there is
the limiter, not the change — wait out the window and re-run.

---

## Round 34 — none read is none only when the document SAYS so; denial is the account's, not the vendor's

Review: `review-k072-r33.md` (1H/1M/0L; numbers reproduced exactly; the `Grand Total`/`Invoice Total` decision held —
the reviewer's narrower "no marker anywhere" rule leaves the same 2 WRONG). Probes: `agents/rev-k072ai/`.

| Finding | Disposition |
|---|---|
| HIGH-1 round 33's "prints tax" test was a word list guarding the dangerous direction: a missed tax word meant "no tax printed" meant 0 meant approve. On the DB `FAKTUUR … TOTAAL 2875.00 / B.T.W. 375.00` was approved (Dr 6000 2875 / Cr 2000 2875, no VAT Input), bulk approve did the same with `B.T.W. ingesluit 450.00`, and `post_journal` posted a `B.T.W. 130.43` receipt draft; `B T W`, `V A T`, `VAl`, `Incl. 375.00`, `15 persent` evidenced 0 by unit probe | **INVERTED, the lead's decision.** `evidencedVat`: no VAT read evidences 0 ONLY on a POSITIVE signal — the document declares no VAT applies (`DECLARES_NO_VAT`: `not (a) VAT registered (vendor/supplier)`, `not registered for VAT`, `non-VAT registered/vendor`, `VAT (is) not applicable`, `nie (vir) BTW-geregistreer nie`, `nie geregistreer vir BTW nie`, and `No VAT` / `No VAT charged` / `Geen BTW` only as a line of their own, because `No VAT on disbursements` is a VAT invoice's footnote) AND the page prints no SA VAT registration number (ten digits, leading 4, spaces or dashes allowed). A phrase the list lacks costs a refusal, never an approval. **Signal (a), the supplier master, is NOT used — checked:** `suppliers.vat_number` is written only when a person or an import creates/edits a supplier; the capture routes read it and never write it, so NULL means "not captured", not "not registered"; `suppliers.default_vat_type` exists but no app path writes it for suppliers (only customers). Using either would fail open exactly as the word list did. **The reader improvements are kept, for reading only:** `VAT_WORD` learns dotted and spaced `B.T.W.`/`B T W` and spaced `V A T`; the VAT rate patterns and their guards learn `persent`. Harness cost 0 (below). **Proved on the DB** with the VAT forced unread, so the evidence rule — not the reader — is what refuses: nine tails (the reviewer's two `FAKTUUR` shapes through `extractFromText` → `ai-invoice-pipeline`, then `B T W`, `V A T`, `VAl`, `Incl. 375.00`, `Incl 15 persent`, `VAT INCL`, `Incl. VAT`) are refused by BOTH approve tools and stay `draft` with no journal (`k072-capture-vat-unread`); `post_journal` refuses the reviewer's `Brits Hardeware … B.T.W. 130.43` draft and eight more tails, a no-tax page that declares nothing, a declaring page that prints a VAT number, and a page with no text (`k072-journal-vat-evidence`). A declaring no-VAT document still posts/approves claiming none (both files, and `k072-receipt-vat-unread`, whose fixtures now declare themselves). |
| MEDIUM-1 the vendor NAME excused a claimed 0 against a read VAT on any account (`parseReceiptType === 'meals'`, an unanchored substring: `Spurway Steel` and `Mr Doors Brits` posted on ordinary expense 6000) | FIXED: the name branch is dropped. A read VAT folded into the expense is consistent only when EVERY non-tax debit sits on an account with `vat_input_denied` — denial is a property of the account. **Proved on the DB:** `Spurway Steel`, `Mr Doors Brits`, `Spur Linden` and a plain vendor, read VAT 130.43, Dr 6000 1000 / Cr bank, are all refused and stay `draft`; `Spur Linden` booked to the denying entertainment account posts; half on a denying account is still refused. **Cost:** a real meals receipt booked to an account that does NOT deny input VAT now goes to a person (migration 521 flagged entertainment-named accounts on every tenant; an unflagged one is the tenant's to fix). **Open, flagged for the lead, not fixed here:** the ROOT is `receiptToJournalService.MERCHANT_PATTERNS` (`spur|mr\s*d|cafe|…`, unanchored). The receipt BUILDER still classifies `Spurway Steel` as meals, books it to 5600 and folds its input VAT into the expense — an under-claim at creation that no MCP check sees, because the builder, not an agent, made it. Anchoring those patterns changes how every receipt is coded and belongs on its own branch. |

### THE COST OF THE INVERSION — every set, measured (`evidencedVat` over the extraction of all 4 481 rows)

27 rows have no VAT read. At `684e251f6`, 9 of them evidenced 0 (so an agent could approve them claiming none); at
head, 1. **Now refused, 9:** 3 Makro card slips (`SALE` / `PURCHASE` / `RECEIPT`, x-card) — a VAT vendor's slip with no
VAT breakdown, so evidencing 0 was an UNDER-claim and refusing is right; and **6 genuine non-VAT invoices that do not
say so** (ac-null ×4, ac-nullvat ×1: Joe Garden Services; af-ord ×1: Joe's Plumbing). Those six are the real price: a
non-VAT vendor who prints nothing about VAT now goes to a person. **Newly evidenced 0, 1:** ac-null `Mama Thandi
Catering … Not VAT registered` (round 33 refused it for printing the word VAT). Pinned both ways on the DB (`r34 THE
COST` in `k072-capture-vat-unread`; the `NO_TAX_TEXT` row in `k072-journal-vat-evidence`).

### Re-measured — head vs `684e251f6`, 4 481 rows (stored ≡ subtotal-null, row for row)

unattended / WRONG **730 / 46 → 730 / 46**; newly refused 0, newly wrong 0; rv-unpaid 5 / 0 at both; none of the 13
ordinary sets changed. The reader's new spellings change no row in any set (no row prints `B.T.W.`, spaced tax words or
`persent`); they are proved by `k076-round34-policy`. The MCP rules are outside this harness and proved on the DB above.

### Mutations — 9 unit + 6 integration, all RED, restored byte-identically (md5)

N1 no declaration needed, any text evidences none (19) · N2 a VAT number on the page ignored (1) · N3 a bare `No VAT`
counts anywhere, not only as a line (1) · N4 no Afrikaans declarations (3) · N5 a spaced VAT number not read as one (1)
· R1 no dotted/spaced `B.T.W.` (4) · R2 no spaced `V A T` (1) · R3 no `persent` rate (2) · R4 the `persent` guard gone (1)
· J1 any text evidences none, on the DB (1) · J2 VAT number ignored (1) · J3 unevidenced counts as none (1) · J4 no
denied fold (1) · J5 the fold on ANY denying debit (1) · J6 the fold without a denying account (1). The integration
mutants ran on `k072-receipt-vat-unread` + `k072-journal-vat-evidence`, which pin the same `evidencedVat` and fold and
never call `ai-invoice-pipeline`, so no 429 could be mistaken for a RED.
