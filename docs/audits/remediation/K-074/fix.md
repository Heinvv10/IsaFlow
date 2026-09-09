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
