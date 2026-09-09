# K-074 fix — bank-match-confirm: generated column write, and a committing 400

**Trigger.** Two defects in `pages/api/accounting/bank-match-confirm.ts`. (1) The supplier-invoice
branch assigned `balance`, which migration 201 declares
`GENERATED ALWAYS AS (total_amount - amount_paid) STORED`; Postgres refuses that with SQLSTATE
428C9 before looking at any row, so the branch could never reach its own subledger write. (2) The
catch-all answered every failure with `apiResponse.badRequest`. `withAuth` decides COMMIT vs
ROLLBACK on `statusCode >= 500`, and every throw reachable there happens at or after
`allocateTransaction` — which has already posted a journal, touched `bank_transactions` and may
have written a payment document. A 400 committed that half-finished match.

**Before / after.** Before: the supplier branch failed every time, and a post-write throw in any
branch committed a GL post with the document unpaid. After: the UPDATE omits `balance` (the
generated column follows `amount_paid`) and the catch-all returns `apiResponse.internalError`, so
`withAuth` rolls back. Pre-write refusals are plain `return`s and keep their 4xx.

**Files.** `pages/api/accounting/bank-match-confirm.ts`;
`tests/integration/k074-bank-match-confirm-supplier-balance.int.test.ts` (5 tests) — drives the real
handler against the production schema inside a request transaction, committing only below 500 the
way `withAuth` does. Covers full settlement, partial settlement with the generated balance checked,
a throw after the GL post answering 500 and NOT committing, a bill in another tenant refused 404
and untouched, and a money-IN line refused 400 before any write.

**Tests.** 5 integration tests on the real PostgreSQL fixture, full unit suite 9439 passed.
Mutation proof in `green.log`: re-adding `balance` turns 2 red, restoring the 400 turns 1 red.

**Migration / rollback.** None. Rollback is a straight revert of the route change.

**Historical-data impact.** None from the supplier branch: `balance` has been generated since the
table was created, so that write always aborted its own transaction and no partial row exists — the
absence is the evidence. The customer-invoice and purchase-order branches did succeed and carried
the ordering defect alone, which needs a non-SQL throw after the first write. I can give no
detection SQL for those: `bank_transactions` has no column linking a line to the document it
settled (`matched_journal_line_id` is a journal line, not the invoice), so a half-match is only
visible as an AR/AP subledger-versus-control-account difference, which is the existing
aging-vs-control reconciliation, not a query specific to this defect.

**Limits.** The 500 is deliberate — it makes the failure visible to `withAuth` and to error
tracking. Any caller that treated the old 400 message as user-facing validation now sees a 500.

---

## Round 2 — dispositions for the six blind-review findings on `d0765c74`

All six are **fixed**; none was argued away.

**HIGH-1 (settlement had no payment document).** Correct, and the more serious half of
the finding. Dropping the `balance` assignment switched ON a bare `amount_paid` write
with no `supplier_payments` row and no `payment_allocations` row, and
`bankAllocationUnwind` finds its work through exactly those two tables — so
unallocating the line would have reversed the GL and left the bill paid. The branch now
settles through `applyBankLineToSupplierInvoices`, which posts the journal, writes the
payment document carrying it, and applies it through `applyLineToBill`. The
over-payment half is fixed by the same change: the bill takes what it can and the
remainder stays on the document, where `list_unapplied_payments` can see it, instead of
being capped away against an AP control moved by the whole line. Proved by two new
tests — one asserts the document, the allocation row, a balanced journal and AP relieved
by exactly the cash; one settles a bill, unwinds it and asserts `amount_paid` returns to
zero.

**MEDIUM-1 (status written on terminal bills).** Correct. The inline UPDATE had no
status filter. `applyLineToBill` writes money only and delegates the three derived
columns to `recomputeInvoiceStatus`, which restricts itself to balance-derived statuses,
and `planSupplierAllocationLines` refuses a `cancelled` or `draft` bill outright. Test:
a cancelled bill is refused 400 with nothing written.

**MEDIUM-2 (every failure became "An internal error occurred").** Correct, and a real UI
regression for the FindMatchModal. `validateBankSupplierPayment` — reads only — now runs
BEFORE the first write, so its refusals (line already allocated, closed or missing
fiscal period, cancelled bill, over-allocation, money the wrong way) return 400 carrying
their own remedy. The catch-all keeps its 500, because after the first write the
rollback is the point. Test: an already-allocated line answers 400 quoting the reason.

**LOW-1 (no module-doc entry).** Fixed: an entry in
`src/modules/accounting/services/bank/.claude.md` covering both K-071 and K-074, with
the `AGENTS.md` mirror regenerated.

**LOW-2 (evidence ran against a stubbed allocator).** Fixed: the K-074 tests no longer
mock `allocateTransaction` or the settlement at all. They run the real posting path
against the production schema, seeding a chart of accounts and an open fiscal period
(`tests/integration/helpers/k074Fixture.ts`). The post-write-failure case now forces its
throw at the LAST step of the real settlement, so the journal and the payment document
genuinely exist when the rollback removes them. An over-payment case was added.

**LOW-3 (a failed savepoint rollback still returned a clean import).** Fixed in
`bankImportService.ts`: the sweep's catch calls `assertTxUsable()` first, so when
`withSavepoint` has marked the context the failure is rethrown with the original cause
instead of degrading to a warning row. Test: the sweep releases its own savepoint before
throwing, which is the one case a savepoint cannot survive.

**Tests after round 2.** 15 integration tests across four files, all on the real
PostgreSQL fixture; full unit suite 9439 passed. Six mutation probes, one per fixed
finding, each turning the matching tests red — see `green.log`.

**Historical-data impact, unchanged.** The supplier branch still never succeeded before
this work, so there is nothing to repair. What changes is only what it does from now on.

---

## Round 3 — dispositions for the four findings on `4c857048`

**MEDIUM-1 (an over-payment's remainder is invisible to the AP aging).** Correct, and the
choice made here is to **refuse the over-payment**, not to surface it. The reasoning, since
the review offered both:

- `allocateTransaction` relieves AP control by the whole line; the bill can only take its
  outstanding balance; and `apAgingService` builds the aging from `supplier_invoices` alone,
  with no unapplied-payment credit anywhere in the query. So the excess parts the control
  account from the aging with nothing on any AP report to explain it.
- Making it visible instead would mean teaching the aging and the supplier statement to net
  unapplied supplier payments. That changes every AP report for every path that leaves a
  remainder — `supplierAutoAllocate`, the purchase-order branch, the MCP apply tool — and is
  a reporting change, not a fix to this route. It is the better systemic answer and it wants
  its own piece of work.
- The module's own rule decides the rest. A caller that HANDS IN its allocations may leave a
  remainder, because there the split is an instruction the user gave: the MCP apply tool
  returns `unapplied_remainder` and the payment document holds it. This screen derives the
  allocation itself from the single bill the user picked, so a remainder is a mis-match. It
  is refused before the first write, naming the excess and the remedy: "This line is
  R1,000.00 but only R600.00 is outstanding … the R400.00 excess would sit unapplied where
  the AP aging cannot see it. Split the line, or capture the payment against every bill it
  settles."
- The second half of the finding — the user is told nothing — is fixed for the settling case
  too: the response now carries `supplierPaymentId`, `paymentNumber` and `allocated`, so the
  screen can name the document that settled the line.

**LOW-1 (validation ran twice per confirm).** Fixed. `applyBankLineToSupplierInvoices` takes
an optional pre-computed `validation` and uses it when given, so the eight reads run once.
Every other caller is untouched. The residual race the review names is unchanged and
correctly diagnosed: between the route's read-only validation and the `FOR UPDATE` inside
`allocateTransaction`, a concurrent confirm of the same line still loses at the lock and
answers 500 rather than the 400 the same refusal earns when it is not a race. That is the
safe direction to fail, and narrowing it means holding the row lock across the validation,
which changes the locking shape of every caller — deliberately not done here.

**LOW-2 (`leg()` summed the account across the whole database).** Fixed: it takes the journal
id and filters on it, matching the balance query beside it. Probe J is the proof — with the
filter removed and a second journal on the same account, the assertion fails.

**LOW-3 (module doc is 109 lines against the 50-line rule).** Partly fixed, and the rest
deliberately not. The file is down to **86 lines** by lossless compaction only: the wrapped
PRD-11 §3 entry unwrapped into one bullet, the blank separators inside Recent-changes
removed, the five 2026-04 stubs merged into one, and this branch's own entry rewritten
tighter. Reaching 50 requires deleting facts other sessions wrote in the last fortnight —
known limitations and locking rules among them — and that is a judgement about their
documentation, not this branch's to make. The review says the same ("not this branch's
job"). Flagged, not silently dropped.

**Structure note.** The route reached 315 lines with these changes, over the 300 ceiling, so
the supplier arm moved to `src/modules/accounting/services/bank/confirmSupplierMatch.ts`
(113 lines) and the route delegates to it. That is where the accounting reasoning belongs
anyway; the route now maps its outcome to a status code and nothing else.

**Tests after round 3.** 16 integration tests on the real fixture, plus 6 new unit tests for
the extracted module. Four mutation probes, one per fixed finding. Full unit suite 9444
passed with one load-induced timeout in an untouched file — see `green.log`, which reports it
rather than rounding it to green.

---

## Round 4 — the three MEDIUMs and LOW-2 of `review-k071-r3.md`

**MEDIUM-1 (a pre-write refusal was answered `500 "An internal error occurred"`, and the route
comment claiming otherwise was false).** Fixed. `allocateTransaction`'s first statement is
`lockBankTransactionForUpdate`, so the lock timeout and the "already <status>" refusal are both
decided before any write. Those two are now typed — `BankTransactionLockTimeoutError` (already
existed) and the new `BankAllocationRefusal` — and the route answers 409 and 400 for them,
keeping 500 for every remaining throw, which really does land after the first write. The comment
now says "every REMAINING throw". Both classifiers are structural (`err.code`), not
`instanceof`: module mocking and a bundler's second copy of a module defeat prototype identity,
and this decides a status code. Proof: two interleaved pool clients on the fixture — a holder
takes the row's `FOR UPDATE`, the route blocks in `lockBankTransactionForUpdate`, times out at
5s and answers 409 with the retry wording, the line still `imported`, no payment, no journal.

**MEDIUM-2 (any failure of `validateBankSupplierPayment` became a 400 carrying raw error text).**
Fixed by giving refusals a type. `validateBankSupplierPayment` and `planSupplierAllocationLines`
throw `SupplierPaymentRefusal` and nothing else; `confirmSupplierInvoiceMatch` re-throws anything
that is not one. A dropped connection or a `25P02` is now a 500 that ROLLBACKs, instead of a
400 that COMMITs while showing the user Postgres's own words. The mirror of MEDIUM-1, as the
review said, and fixed in the same shape.

**MEDIUM-3 (the "no journal was posted" assertion could never fail).** Fixed. The journal's
description names the invoice, never the bank line, so `LIKE '%<bankTxId>%'` matched nothing
either way. Replaced by a count of `gl_journal_lines` on the AP control account taken before and
after the request. Sensitivity proved with a throwaway probe that asserted the count UNCHANGED
across a SUCCESSFUL confirm and went red.

**LOW-2 (two copies of the over-payment threshold).** `buildLine` now carries a comment naming
the outer guard in `confirmSupplierMatch.ts`, why the outer one has to decide first, and that
the two move together. Not deduplicated into one helper: the outer guard needs the bill's
outstanding balance before the validator runs, and the inner one needs it from the row it has
just read inside the write — the same arithmetic in two places on purpose.

**LOW-1 and LOW-3 are K-071's; see `../K-071/fix.md`.** LOW-1's residual is now gone: the module
doc is 44 lines, and the one rule the earlier compaction had dropped is back.
