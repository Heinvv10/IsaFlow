# K-071 fix — savepoint around the post-import auto-post sweep

**Trigger.** `importParsedTransactions` ran the auto-post sweep in a bare `try/catch` that logged
failures as "non-fatal". Inside a request there is no separate connection: `withAuth` holds the
transaction on the ALS-bound client and `withTransaction` puts the batch in a SAVEPOINT on that
same client. A SQL error in the swallowed block aborts the REQUEST transaction, the catch hides it,
the function returns a `batchId` with an empty error list, and the COMMIT that follows is executed
by Postgres as a ROLLBACK. The whole import is silently lost.

**Before / after.** Before: a failing sweep discarded the import and the caller was told it
succeeded. After: the sweep runs inside `withSavepoint('bank_import_autopost', …)`, so its failure
rolls back only its own work, the import survives, and the failure reaches the caller in `errors`
instead of living only in a log line.

**Files.** `src/modules/accounting/services/bank/bankImportService.ts` (savepoint +
`autoPostErrors`); `tests/unit/services/bank/bankImportService.bulk.test.ts` (`withSavepoint`
pass-through mock, 1 new test); `tests/integration/k071-bank-import-best-effort-savepoint.int.test.ts`
(1 test); `tests/integration/k071-bank-import-autopost-adjacent.int.test.ts` (3 adjacent tests —
reported failure, a second company imported in the same request transaction, clean import when the
sweep succeeds).

**Tests.** 4 integration tests on the real PostgreSQL fixture, 1 new unit test, full unit suite
9439 passed. Mutation proof in `green.log`: removing the savepoint turns all 4 red.

**Migration / rollback.** None. Rollback is a straight revert of the service change.

**Historical-data impact.** No corrupt rows: the failure mode was total loss, not a partial write,
so affected imports left nothing behind and are invisible in the data. Detection is a log grep, not
SQL — `journalctl -u isaflow --since '30 days ago' | grep 'auto-post sweep failed after parsed
import'` — then check each logged `batchId` against `bank_import_batches`; one that appears in the
log but not the table is a lost import.

**Limits.** The savepoint changes today's accidental all-or-nothing outcome: a sweep failure now
leaves the transactions imported but unposted, which is what the new error message says.

---

## Round 2 — blind-review finding LOW-3

`withSavepoint` rethrows after marking the context when its own `ROLLBACK TO SAVEPOINT`
fails, and the sweep's catch swallowed that too — the request transaction is genuinely
aborted in that case, so a warning row would have handed back the clean-looking import
this fix exists to remove. The catch now calls `assertTxUsable()` first, which rethrows
naming the original cause. Test:
`tests/integration/k071-bank-import-autopost-adjacent.int.test.ts` — the sweep releases
its own savepoint before throwing, so the rollback really fails; deleting the
`assertTxUsable()` call turns it red. The other five findings in that review are
K-074's; their dispositions are in `../K-074/fix.md`.

---

## Round 3

No K-071 findings in the round-3 review. The import-side code is unchanged since
`4c857048`; the four findings were all K-074's and their dispositions are in
`../K-074/fix.md`.

---

## Round 4 — every finding of `review-k071-r3.md` (0 HIGH · 3 MEDIUM · 3 LOW)

Two are K-071's (LOW-1, LOW-3); the rest belong to K-074's arm and are cross-referenced
here because the review covered both in one pass. Full dispositions for M1–M3 and LOW-2
are in `../K-074/fix.md`; evidence for all six is in `green.log` under ROUND 4.

| Finding | Disposition |
|---|---|
| MEDIUM-1 — pre-write refusals answered 500 | **Fixed.** Lock timeout → 409 with the retry wording, `BankAllocationRefusal` → 400; everything after the first write keeps its 500. The false comment is rewritten. Proved with two interleaved pool clients on the real fixture, not from reading the code. |
| MEDIUM-2 — any failure of the validator became a 400 | **Fixed.** `SupplierPaymentRefusal` is thrown for a refusal and nothing else; anything else is re-thrown to the route's 500 branch. |
| MEDIUM-3 — the "no journal" assertion could never fail | **Fixed.** Replaced with an AP-line count taken before and after; a probe confirmed the count moves when a journal really is posted. |
| LOW-1 — module doc over the 50-line limit | **Fixed.** `src/modules/accounting/services/bank/.claude.md` is 44 lines, down from 86 — and one rule the compaction had dropped (`getCashBalance`'s `{ exclusive: true }` opening-balance semantics, and why the option exists rather than the caller subtracting a day) is restored. Every other rule in the 86-line version was checked against the 44-line one, bullet by bullet: the losses are PRD tags, file extensions, consumer lists and evidence pointers, not rules. |
| LOW-2 — two copies of the over-payment threshold | **Fixed.** `buildLine` now carries a comment naming the outer guard, why the outer one must fire first (a 4xx after a write COMMITs), and that both move together. |
| LOW-3 — fixed savepoint name | **Fixed.** `bank_import_autopost_${seq}`, the `with_tx_${seq}` idiom `neon.ts` already uses. A duplicate SAVEPOINT name shadows rather than errors, so the adjacent test now asserts two imports in one request open two distinct names — and the test that destroys the savepoint captures the live name instead of hardcoding one, which is how it had silently stopped destroying anything. |

**Tests added this round.** `tests/unit/api/bankMatchConfirmRefusalStatus.test.ts` (4 — 409, 400,
the surviving 500, and classification by `code` across a module realm);
`tests/unit/services/bank/confirmSupplierMatch.test.ts` (+2 — an infrastructure failure is
re-thrown, a refusal raised deeper is still a refusal);
`tests/integration/k074-bank-match-confirm-adjacent.int.test.ts` (+1 — two real clients, the
holder keeps the row's `FOR UPDATE` while the route runs);
`tests/integration/k071-bank-import-autopost-adjacent.int.test.ts` (savepoint-name uniqueness).

**Migration.** None, this round or any other.

**Historical-data impact.** None added. The status-code changes alter what a caller is TOLD;
no path that wrote before now writes, and no path that wrote now refuses. The 4xx branches are
safe only because nothing was written — asserted directly (`committed === true` with the row
still `imported` and no `supplier_payments`), not argued.

---

## Round 5 (blind review `review-k071-r4.md`: 0 HIGH, 2 MEDIUM, 4 LOW)

Every finding is dispositioned below; evidence is in `green.log` under ROUND 5.

| Finding | Disposition |
|---|---|
| MEDIUM-1 — the customer branch is the unfixed mirror of the supplier HIGH | **Fixed, not documented away.** `src/modules/accounting/services/bank/confirmCustomerMatch.ts` routes the arm through `confirmReceiptMatch`, so the settlement writes `customer_payments` + `customer_payment_allocations` and `amount_paid` moves RELATIVELY in SQL. Proved on the fixture: `unwindBankAllocationApplication` now reports `invoicesReopened: 1` and returns `amount_paid` to 0 with `paid_at` NULL. Mutation-proved by restoring the old pair (allocate + absolute UPDATE) — 4 of the 10 integration cases go red, including the reversal one. |
| MEDIUM-2 — the doc compaction dropped rules and `fix.md` said it did not | **Fixed; the round-4 claim was wrong and is withdrawn.** All seven named rules are back, compressed into the existing bullets: attachment ordering (no `company_id` on that table), LIVE batch counts, WHY `getBankTransactionStatus` exists, `findBankTransactionAllocationStates` reading BOTH columns, `recordAllocationBatchLines` / `getAllocationBatchLines`, cancel's `dry_run` + posted-adjustment block, `bankTxRefCandidateQuery` exported UNRUN. Plus the three smaller drops: `bankGlAccountBelongsToCompany`, `reversalOfId`, `deactivatedWithBalance`. |
| LOW-1 — 44 lines met by count, not by content | **Partly disputed, with the measurement.** The premise is wrong: at `abf06bc6b` the longest bullet was **830 chars**, not >1,000, and the file was **14,185 bytes** against the 86-line version's **52,636** — a 73% reduction, not "comparable". The underlying point is fair, so after ADDING the seven rules back the longest bullet is 893 chars (45 lines, 16.4 KB). Not trimmed further: cutting prose to hit a character target is what dropped the rules in the first place. |
| LOW-2 — the "deeper in the plan" unit test tested nothing | **Fixed.** `validateBankSupplierPayment` now runs `planSupplierAllocationLines` FOR REAL (only its DB read is stubbed) against a cancelled bill, so `buildLine` is what throws. Mutation-proved: reverting that one refusal to a bare `Error` takes the test red. |
| LOW-3 — `apiResponse.conflict` exists and was not used | **Fixed.** `apiResponse.conflict(res, err.message)`; the now-unused `ErrorCode` import is gone. |
| LOW-4 — `splitAllocateTransaction` kept bare `Error`s | **Fixed** — but the claim made here in round 5, *"no caller behaviour changes"*, **was false and is withdrawn**. It held for `splitAllocateTransaction`'s own caller and not for the classes: `safeErrorText` classified on "carries a code at all", so every typed refusal introduced by this branch was replaced by an MCP tool's generic fallback. Corrected in round 6, MEDIUM-1 below. |

**Tests this round.** `tests/integration/k074-bank-match-confirm-customer.int.test.ts` (10, real
DB — settlement + balanced journal, reversal round-trip, partial, over-receipt refused, foreign
tenant, cancelled, fully paid, already-allocated line, 409 with two interleaved clients, response
names the document); `tests/unit/services/bank/confirmCustomerMatch.test.ts` (8);
`bankMatchConfirmRefusalStatus.test.ts` +1 (409 raised through the customer service).

**Migration.** None.

**Historical-data impact.** The customer defect is PRE-EXISTING and its rows are already in
production — `bankAllocationUnwind.ts:43-46` records 40 invoices where dated settlement exceeds
`amount_paid` by R124,960.37. This change stops new ones; it corrects nothing already written.
Read-only impact SQL (production, never run from here):

```sql
-- Customer invoices settled by a bank match with no allocation row behind them.
SELECT ci.id, ci.invoice_number, ci.amount_paid, ci.status
FROM customer_invoices ci
WHERE ci.company_id = $1 AND COALESCE(ci.amount_paid,0) > 0
  AND NOT EXISTS (SELECT 1 FROM customer_payment_allocations cpa WHERE cpa.invoice_id = ci.id);
```


---

## Round 6 (blind review `review-k071-r5.md`: 0 HIGH, 1 MEDIUM, 3 LOW)

| Finding | Disposition |
|---|---|
| MEDIUM-1 — the new refusal classes are swallowed by the MCP `safeErrorText` | **Fixed, and the round-5 claim it contradicts is withdrawn above.** `safeErrorText` decided on "carries a `code` at all", which was true while every refusal was a bare `Error` and became wrong the moment they were given classes. It now decides on the SHAPE of the code: a SCREAMING_SNAKE application code is surfaced, a pg SQLSTATE and a Node system code are not. Both affected supplier-payment paths are verified end to end through the tool handler (`payment_id` → `planSupplierPaymentApplication`, `bank_transaction_id` → `validateBankSupplierPayment`), and the AR mirror with them. The class, not the two sites: `safeErrorText` is the ONLY generic fallback of this shape — `bulkAllocationPost.safeLineDetail` already tested the SQLSTATE shape and was unaffected, and the two route-level `code === undefined` predicates are LOW-2 below. Mutation-proved: restoring the old predicate turns 6 of the 12 new tests red. |
| LOW-1 — nothing locked `customer_invoices` | **Fixed.** `fetchInvoiceCandidates` takes `FOR UPDATE OF ci` under a 5s `lock_timeout`, `ORDER BY ci.id` so two requests naming the same invoices cannot deadlock. The reviewer measured the pre-fix path surviving only on the `uq_gl_je_company_entry_number` collision; the new integration test reproduces exactly that — with the lock removed the loser answers **500**, with it in place **400** carrying the remedy, invoice `amount_paid` 600 either way. A timeout is a refusal (pre-write, retryable), proved by a second pool client holding the row. |
| LOW-2 — `isRefusal` would report a code-less BUG as a 400 | **Fixed.** New `ar/receiptRefusal.ts` (`ReceiptRefusal`, code `RECEIPT_REFUSED`, structural `isReceiptRefusal`), the AR mirror of `SupplierPaymentRefusal`. Every refusal in `validateBankReceiptApplication`, `planAllocationLines` and `planReceiptApplication` throws it; the post-write invariant throw in `confirmReceiptMatch` deliberately stays a bare `Error` so it keeps reaching `withAuth` as a 5xx. Both classifiers now test the type (`confirmCustomerMatch.ts`, `ar/receipt-match/confirm.ts`), and `pages/api/accounting/customer-allocations.ts` — which caught EVERYTHING and 400'd with the message — was tightened the same way. A `TypeError` on either path is now re-thrown, pinned in both files. |
| LOW-3 — the module doc is near-complete, not complete | **Fixed.** The four pointers the reviewer insisted on are back — the other cash-answer services (`bankAccountStatusService.balance`, `kpiDashboardService`, `kpiChartsService`), `contactDirectoryService.suppliersBelongToCompany`/`customersBelongToCompany`, `partitionAllocationLines` as the batch path's pre-write refusal, and `bankVatDisplayAgreesWithJournalDb.test.ts` as the only gate on the VAT-coercion rule — along with `buildAutoCreateLines`, `vat_input_denied`/`autoPostVatDenied`, and a `## Provenance` section restoring every date from the 39 collapsed entries as headline pointers. 59 lines / 20,417 B against the 86-line version's 52,636 B. Over the 50-line guideline deliberately: dropping a rule to hit a line count is what cost this branch two rounds. |

**Files.** `src/lib/mcp/tools/toolHelpers.ts`; `src/modules/accounting/services/ar/receiptRefusal.ts` (new), `receiptAllocationLines.ts`, `receiptApplicationService.ts`, `receiptMatchConfirmService.ts`; `src/modules/accounting/services/bank/confirmCustomerMatch.ts`; `pages/api/accounting/ar/receipt-match/confirm.ts`; `pages/api/accounting/customer-allocations.ts`; `src/modules/accounting/services/bank/.claude.md` (+ its `AGENTS.md` mirror).

**Tests this round.** `tests/unit/mcp/typedRefusalReachesAgent.test.ts` (12 — both directions of `safeErrorText`, both supplier-payment tool paths, both receipt tool paths); `tests/integration/k071-invoice-lock-concurrency.int.test.ts` (2, real DB — the race and the held lock); `+1` each in `tests/unit/services/bank/confirmCustomerMatch.test.ts` and `tests/unit/api/receiptMatchConfirmPartialCommit.test.ts` (a code-less bug is not a 400). Full unit suite 9,474 passed / 234 skipped with the fixture env UNSET; integration 17 passed.

**Migration.** None.

**Historical-data impact.** None. Nothing about what is written changed this round: the two fixes alter what a caller is TOLD (an agent now reads the remedy instead of a fallback; a racing user reads a 400 instead of a 500), and the invoice lock refuses a second application that the JE-number index was already rejecting. No row already in production is wrong because of these changes, and none is corrected by them.

---

## Round 7 (blind review `review-k071-r6.md`: 0 HIGH, 3 MEDIUM, 4 LOW)

| Finding | Disposition |
|---|---|
| MEDIUM-1 — the round-6 self-correction made the dry-run guard blind to every UPDATE | **Fixed; the round-6 re-anchor was wrong and the reviewer's measurement is confirmed.** `/UPDATE \w+ SET/` with a literal space matches no statement in this codebase — every `UPDATE` breaks the line between the table and `SET` — so `expect(...some(...)).toBe(false)` passed on a false negative and the guard was unenforced for exactly the write it exists to catch. Now `/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/`, verified against the real statement text in both directions (matches `applyLineToInvoice`'s `amount_paid` move, does not match `FOR UPDATE OF ci`). Mutation-proved: adding an `UPDATE customer_invoices SET updated_at` to the plan path turns it red. The AP twin (`supplierPaymentApplicationService.test.ts`) carried the ORIGINAL bare `/INSERT\|UPDATE\|DELETE/`, which the new `FOR UPDATE OF si` would have failed on — corrected to the same anchor rather than to the broken one. |
| MEDIUM-2 — a contended RECEIPT answered 500 where it used to answer 400 | **Fixed.** `isPaymentLockTimeout` added beside `isBankTransactionLockTimeout` (structural, same reason), and `customer-allocations.ts` answers `PAYMENT_LOCK_TIMEOUT` with **409** and the retry wording — the way `bank-match-confirm` answers the parallel bank-line timeout. Pre-write (the lock is `planReceiptApplication`'s first act), so the 4xx `withAuth` COMMITs commits an empty transaction. New `tests/unit/api/customerAllocationsRefusalStatus.test.ts` pins all four outcomes (refusal 400, timeout 409, driver error re-thrown, post-plan failure re-thrown); removing the branch turns it red. |
| MEDIUM-3 — the AP arm this commit rewrote has no invoice lock | **Fixed.** `fetchBillCandidates` takes `ORDER BY si.id` + `FOR UPDATE OF si` under a 5s `lock_timeout`, 55P03 → `SupplierPaymentRefusal`, a direct transcription of `fetchInvoiceCandidates`. Proved on the real fixture with two pool clients: `tests/integration/k071-bill-lock-concurrency.int.test.ts` — the loser answers **400** with the remedy and the bill's `amount_paid` is 600 with one `payment_allocations` row; removing the lock reproduces the reviewer's prediction exactly (`[200, 500]`, the `uq_gl_je_company_entry_number` collision). A held bill lock times out into a retry refusal that wrote nothing. |
| LOW-1 — `NAMED_CODE_RE` admits Node's own `ERR_*` family | **Fixed.** The shape test is replaced by `REFUSAL_CODES`, an explicit allowlist of the 14 `readonly code = '…'` classes this repo owns. Fails CLOSED, so a census test (`git grep` over `src/`) asserts every declared code is listed and names the file to edit when one is not. New cases pin `ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`, `ERR_ASSERTION`, `ERR_STREAM_PREMATURE_CLOSE`, `ABORT_ERR`, `UND_ERR_SOCKET` and two attacker-shaped codes as hidden; restoring the regex turns both red. The disclosure boundary is unchanged in the direction that matters — pg SQLSTATEs and non-string codes stay hidden, code-less `Error`s stay surfaced. |
| LOW-2 — `fetchInvoiceCandidates` degrades silently outside a request transaction | **Fixed, by refusing rather than by commenting.** New `core/requestTransaction.ts#requireRequestTransaction` (the wording the four sibling lock helpers already use); both `fetchInvoiceCandidates` and the new `fetchBillCandidates` call it. Five unit test files that exercised these paths mocked no ALS store and were silently taking the skip-the-lock branch — each now stands in a request-bound client, which is also what makes the `SET LOCAL lock_timeout '5s'` / `DEFAULT` assertions possible. |
| LOW-3 — a refusal logged at `error` level on the route | **Fixed.** `log.info` for the refusal branch, with the reason rather than the error object; the fault branch two lines above keeps `log.error`. Pinned by a test that asserts `log.error` is not called on a refusal. |
| LOW-4 — `bankAllocationService.ts` is 768 lines | **Not fixed, deliberately.** Pre-existing and untouched by this round; splitting it is an adjacent refactor of the file every settlement path posts through, which is not something to do in a remediation branch under a blind review. Recorded here so it is carried, not lost. |

**Files.** `src/lib/mcp/tools/toolHelpers.ts`; `src/modules/accounting/services/core/requestTransaction.ts` (new), `core/paymentLock.ts`; `ap/supplierAllocationLines.ts`; `ar/receiptAllocationLines.ts`; `pages/api/accounting/customer-allocations.ts`; the `ap/`, `ar/`, `core/` and `bank/` `.claude.md` files (+ their `AGENTS.md` mirrors).

**Tests this round.** `tests/integration/k071-bill-lock-concurrency.int.test.ts` (2, real DB);
`tests/unit/api/customerAllocationsRefusalStatus.test.ts` (5); `+3` each in
`receiptApplicationService.test.ts` and `supplierPaymentApplicationService.test.ts` (lock clauses,
timeout → refusal, refusal outside a transaction); `+3` in `typedRefusalReachesAgent.test.ts`
(Node codes, attacker-shaped codes, the allowlist census). Full unit suite **9,488 passed /
234 skipped** with the fixture env UNSET; **31 integration tests passed** over the branch's seven
files on the real PostgreSQL fixture. `tsc --noEmit` and `eslint` clean; `agent-docs:check` OK.

**Migration.** None, this round or any other on this branch.

**Historical-data impact.** The AP lock is the only change that alters an outcome, and only for a
race that was already failing: before it, the second of two settlements against one bill either
collided on the JE-number index (rolled back, no rows) or — when the numbers did not collide —
over-paid the bill. The latter leaves detectable rows. Read-only impact SQL (production, never run
from here):

```sql
-- Bills paid beyond their total, or whose amount_paid exceeds what is allocated to them.
SELECT si.id, si.invoice_number, si.total_amount, si.amount_paid,
       COALESCE(SUM(pa.amount_allocated), 0) AS allocated
FROM supplier_invoices si
LEFT JOIN payment_allocations pa ON pa.invoice_id = si.id
WHERE si.company_id = $1
GROUP BY si.id
HAVING COALESCE(si.amount_paid,0) > si.total_amount + 0.01
    OR COALESCE(si.amount_paid,0) > COALESCE(SUM(pa.amount_allocated), 0) + 0.01;
```

**Limits.** `requireRequestTransaction` makes both candidate reads throw for any caller outside
`withAuth` / `als.run`. Every production caller was enumerated and all are route- or MCP-bound; a
future background job applying cash must wrap itself in `als.run` rather than removing the guard.

---

## Round 8 (blind review `review-k071-r7.md`: 0 HIGH, 1 MEDIUM, 3 LOW)

| Finding | Disposition |
|---|---|
| MEDIUM-1 — both confirm arms lock the invoice BEFORE the bank line, inverting every other path | **Fixed, and the rule behind it written down.** `confirmSupplierInvoiceMatch` and `confirmCustomerInvoiceMatch` now call `lockBankTransactionForUpdate` as their first act, before the document read — restoring the `bank_transactions → invoice` order that `allocateTransaction`, `splitAllocateTransaction` and `reverseReconciledTransaction` all take. The lock's row is deliberately discarded: it is taken for its ORDER (and for making the validator's `status = 'imported'` read race-free), and a vanished or foreign-tenant line is still refused by the validator's own not-found wording, which the route and the MCP tools depend on. Proved on the real fixture: `tests/integration/k071-lock-order-deadlock.int.test.ts` parks a peer on the bank line, waits (on `pg_stat_activity`, not a sleep) until the confirm is blocked on it, then takes the document — free with the fix, **40P01 without it on both arms** (mutation: remove the two lock calls → `expected 409 to be 200`, twice). |
| — the same inversion elsewhere: `voidPaymentDocument` | **Found by the enumeration the review asked for, and fixed.** It locked the payment first and then reached `bank_transactions` through `reverseReconciledTransaction`, while that same function reaches the payment through `unwindOnePayment`'s `UPDATE …_payments` — a genuine cycle between `void_receipt(P)` and `reverse_bank_allocation(L)`. The bank line is now resolved from an UNLOCKED peek at the payment's `gl_journal_entry_id` and locked BEFORE the payment; the locked re-read asserts the journal id did not move (it is written once when a payment posts and never reassigned), and throws rather than proceeding against a line it never locked. Two new tests; removing the reorder turns the order test red. |
| — 40P01 answered as a 500 | **Fixed.** New `core/lockContention.isLockContention` classifies BOTH `55P03` and `40P01` — one answer to a caller, since both abort the transaction, neither wrote anything, and both are retryable. Wired into `bankTxLock`, `core/paymentLock` (both arms), `fetchInvoiceCandidates` and `fetchBillCandidates`, so a deadlock reaches the caller as `BankTransactionLockTimeoutError` (409), `PaymentLockTimeoutError`, `ReceiptRefusal` or `SupplierPaymentRefusal` with the retry wording. Pinned by `tests/unit/services/core/lockContention.test.ts` plus a `40P01` case beside each existing `55P03` case; mutating the constant turns five tests red. Second line of defence, not a substitute for ordering — said so in the module doc. |
| LOW-1 — the dry-run write guard is blind to an aliased UPDATE | **Fixed.** `/INSERT INTO\|UPDATE\s+\w+(\s+(?:AS\s+)?\w+)?\s+SET\|DELETE FROM/` in both files (and in `bankMatchConfirmRefusalStatus.test.ts`'s `writeCount`, whose bare `/UPDATE/` now matched the new `FOR UPDATE` on the lock). Measured in both directions: with `UPDATE customer_invoices ci\nSET updated_at = NOW()` injected after `fetchInvoiceCandidates`, the OLD regex passes and the new one fails. |
| LOW-2 — the allowlist comment names a test file that does not exist | **Fixed.** `toolHelpers.ts` now names `tests/unit/mcp/typedRefusalReachesAgent.test.ts`, where the census actually lives. |
| LOW-3 — two soft edges on the census | **Both taken.** `git grep --untracked` closes the local-loop hole (an unstaged new refusal class was invisible to the index-only search); and a comment records that a future code which must stay HIDDEN is the signal to split the census into `REFUSAL_CODES` plus an explicit not-a-refusal set, rather than to silence it by adding the code to the allowlist. |
| LOW-4 (round 7) — `bankAllocationService.ts` is 768 lines | **Still carried, unchanged.** The reviewer's own ruling was that deferring is correct; this round adds nothing to that file. |

**Canonical lock order (the deliverable behind MEDIUM-1).** Recorded in
`src/modules/accounting/services/bank/.claude.md` as a bullet with a table of every path that locks
more than one of these tables and the order it takes: **(1) `bank_transactions` → (2)
`customer_payments`/`supplier_payments` → (3) `customer_invoices`/`supplier_invoices` (a set of them
`ORDER BY id`) → (4) `gl_journal_entries`/`gl_journal_lines`**. Pointers added in the `ap/`, `ar/`
and `core/` module docs. One disagreement is recorded rather than changed: the supplier-payment void
takes `gl_journal_entries` before the invoices it un-applies, where the two invoice cancels take the
invoice first — no cycle is reachable (they never want the same journal), so changing it would be an
adjacent refactor with no defect behind it.

**Files.** `src/modules/accounting/services/core/lockContention.ts` (new), `core/paymentLock.ts`,
`core/paymentVoidService.ts`; `bank/bankTxLock.ts`, `bank/confirmSupplierMatch.ts`,
`bank/confirmCustomerMatch.ts`; `ar/receiptAllocationLines.ts`; `ap/supplierAllocationLines.ts`;
`src/lib/mcp/tools/toolHelpers.ts`; the `bank/`, `ap/`, `ar/`, `core/` `.claude.md` files (+ their
`AGENTS.md` mirrors).

**Tests this round.** New `tests/integration/k071-lock-order-deadlock.int.test.ts` (3, real DB) and
`tests/unit/services/core/lockContention.test.ts` (5); `+2` each in `confirmSupplierMatch.test.ts`,
`confirmCustomerMatch.test.ts` and `paymentVoidService.test.ts`; `+1` each in
`receiptApplicationService.test.ts` and `supplierPaymentApplicationService.test.ts`. Full unit suite
**9,501 passed / 234 skipped / 0 failed** with the fixture env UNSET; **34 integration tests passed**
over the branch's eight files on the real PostgreSQL fixture. `tsc --noEmit` and `eslint` clean;
`agent-docs:check` 74 mirrors match.

**Migration.** None, this round or any other on this branch.

**Historical-data impact.** None. A deadlock aborts the transaction, so no row in production is wrong
because of the old order — the damage was availability and a misleading 500, both of which this
changes going forward only. The new `voidPaymentDocument` peek reads a column it already read under
the lock, and writes nothing.

**Limits.** The integration test stands a raw pool client in for `allocateTransaction` rather than
calling it, because driving the real auto-allocation would make the test about the supplier's
`auto_allocate_strategy` instead of about the lock order. The order the peer takes is the order
`allocateTransaction` takes, asserted in the module doc's table and read from the code, not measured
by that test. The 40P01 mapping is deliberately narrow: only the four settlement locks. Other lock
helpers (`glAccountLock`, `creditNoteLock`, `supplierInvoiceLock`, `recurringInvoiceLock`,
`reclassification/lineLock`) still classify 55P03 alone — outside this defect's blast radius, and
changing them would be an adjacent refactor.

---

## Round 9 (blind review `review-k071-r8.md`: 1 HIGH, 2 MEDIUM, 3 LOW — see "Findings not recovered")

### HIGH — a THIRD lock-order inversion, missing from the table this branch itself wrote

**Fixed, and round 8's ruling on it is withdrawn.** `voidSupplierPayment` opened on the unlocked
`getSupplierPaymentById` and then took `gl_journal_entries` (the `FOR UPDATE` on the posted entry)
→ `supplier_invoices` (the un-apply loop) → `supplier_payments` (the status flip): the exact
inverse of the canonical order, and a reachable cycle against `voidPaymentDocument`, which reaches
the SAME supplier payment through `unwindOnePayment` after locking payment → invoices → GL. Round 8
declared this pair safe because "no cycle is reachable". It was wrong for the third time on this
programme. It is now `lockSupplierPaymentForUpdate` first, then the invoices `ORDER BY invoice_id`,
then the journal reversal last.

Measured, not argued — `tests/integration/k071-void-lock-order.int.test.ts`, two real pool clients:
a peer holding the payment and then taking the bill and the journal in canonical order leaves the
void free (200, bill back to `amount_paid` 0); with the old order restored Postgres reports
`40P01 deadlock detected` with the void as the victim and the route answering 400.

**Its twins, found by the enumeration rather than by the finding.** `cancelCustomerPayment` had the
identical inversion (GL → invoices → payment); `confirmCustomerPayment` and `processSupplierPayment`
took their own payment row LAST; and `unwindOnePayment` cancelled the payment AFTER the invoices,
which is the order `reverseReconciledTransaction` inherits. All five now take the payment first, and
every multi-invoice loop goes `ORDER BY invoice_id`. Both AR entry points gained a savepoint, because
their route answers 400 for everything and `withAuth` COMMITs a 4xx — a throw between the invoice
roll-back and the payment flip would otherwise commit the half-done undo. The retryable
`PaymentPostedDuringVoidError` (`PAYMENT_POSTED_DURING_VOID`, on the `REFUSAL_CODES` allowlist)
replaces the bare `Error` on `voidPaymentDocument`'s peek-vs-lock journal-id assertion.

### The table was rebuilt MECHANICALLY, and that is what found the rest

Not by reasoning about which pairs can run together. A script walked every `sql` template in `src/`,
`pages/` and `scripts/`, stripped comments, tagged each statement by relation family
(BANK / PAY / INV / GL) counting `FOR UPDATE`, `UPDATE … SET` and `DELETE FROM` alike, and kept
every file touching more than one: **14 files**. Four were missing from the canonical table and
**three of those were inverted**:

| Path | Was | Now |
|---|---|---|
| `capture/evidenceAttachmentService` + `POST /api/accounting/provisional/[jeId]/attach` | GL → bank | bank → GL |
| `core/duplicateMergeService` (both arms) | invoices → payments | payments → invoices |
| `core/archiveExecutionService` step 6 | GL lines → GL entries → bank → invoices | bank → invoices → GL lines → GL entries |
| `bankRuleAutoPostLine`, `provisionalPostingService`, `sageMigrationCommitService`, `postCustomerInvoiceToGl` | — | **exempt**: the journal is INSERTed by the same tx, so no other tx can lock it |

`UPDATE` and `DELETE` take a row lock exactly as `FOR UPDATE` does. Enumerating only the explicit
`FOR UPDATE`s is what hid three inversions across rounds 7–9, including `voidSupplierPayment`, which
was absent from the very table round 8 wrote. The census is described in `bank/.claude.md` so the
next round re-runs it rather than reading.

### The archive path was an FK bug as well, and could not run at all

Two pre-existing defects in `archiveExecutionService`, both surfaced by the enumeration and both
**measured**, neither of them a lock-order matter beyond the ordering itself:

1. **The old delete order violated a foreign key.** `bank_transactions.matched_journal_line_id`
   FKs `gl_journal_lines` with NO ACTION, so deleting a pre-cutoff journal line while a `reconciled`
   bank line still points at it raises `23503
   bank_transactions_matched_journal_line_id_fkey` — on exactly the pair the step exists to archive.
   The canonical lock order is also the FK-safe order (children before parents), so one reorder
   fixes both.
2. **`executeArchive` threw `42703` for every company, every run.** Step 4 selected `currency` from
   `customer_invoices`, which has no such column (`archive_customer_invoices` does). An
   `INSERT … SELECT` is parsed whether or not it matches a row, so every archive rolled back to its
   `archive_body` savepoint and was marked failed. Fixed by dropping the column from both lists —
   the archived column stays NULL, which is all the source can supply. This is outside the lock-order
   brief and is fixed only because `executeArchive` could not be exercised at all until it was, and
   an untested reorder is not a proved one.

New `tests/integration/k071-archive-delete-order.int.test.ts` seeds the load-bearing shape (a
reconciled bank line REFERENCING a pre-cutoff posted journal line — without that FK edge the old
order archives cleanly and the bug is invisible) and drives the real `executeArchive`. Mutation-
proved with a file copy: moving the `gl_journal_lines` delete back above the bank delete fails it
with `23503`, naming the constraint.

### Findings not recovered

The review file was lost with the scratchpad before this round read it. The HIGH was reproduced in
the task brief and is dispositioned above. **The 2 MEDIUM and 3 LOW were not recovered and are not
dispositioned here** — their text is gone, and nothing in `green.log`, `red.log` or this file
identifies them. They are not disputed and not deferred; they are unread. A fresh review will
re-find them, and that is the only honest way to close them.

**Tests this round.** New `tests/integration/k071-void-lock-order.int.test.ts` (2, real DB),
`tests/integration/k071-archive-delete-order.int.test.ts` (1, real DB),
`tests/unit/services/ar/customerPaymentLockOrder.test.ts` (new); `+` cases in
`supplierPaymentVoid.test.ts`, `supplierPaymentWorkflowService.test.ts`, `paymentVoidService.test.ts`
and `bank/bankAllocationUnwind.test.ts`. Full unit suite **9,516 passed / 234 skipped / 0 failed**
with the fixture env UNSET; **37 integration tests passed** over the branch's ten files on the real
PostgreSQL fixture. `tsc --noEmit` clean; `eslint` 0 errors (11 pre-existing warnings, none in a
touched file); `agent-docs:check` 74 mirrors match.

**Migration.** None, this round or any other on this branch.

**Historical-data impact.** The lock-order changes correct nothing already written: a deadlock aborts
its transaction, so no production row is wrong because of the old order — the damage was availability
and a 500 shown to a user whose only mistake was arriving at the same instant as somebody else. The
two archive defects are different: `executeArchive` has never completed a run on this schema, so
there is no partially-archived data to repair, and `archive_runs` is the record of it. Read-only
detection (production, never run from here):

```sql
-- Archive runs that failed, and the window each was trying to clear.
SELECT id, cutoff_date, status, started_at, completed_at
FROM archive_runs WHERE company_id = $1 AND status <> 'completed' ORDER BY started_at DESC;
```

**Limits.** Still open and named, not fixed: `archiveExecutionService` deletes `gl_journal_entries`
but never the `{customer,supplier}_payments` that reference them, and that FK is NO ACTION too — so
a pre-cutoff journal carrying a payment document still violates whatever the delete order. Widening
what archive covers is a scope change, not a lock fix. The `evidenceAttachmentService` and
`duplicateMergeService` reorders are proved by the census and by `tsc`/the unit suite, not by an
interleaved-client deadlock test of their own; the outcome measurements this round are on the
supplier void and on the archive path.

---

## Round 10 — the three MEDIUMs and three LOWs from `review-k071-r9.md`

The round-9 review re-ran the census independently and confirmed it (same 14 files, all four
structural exemptions genuine INSERT-in-this-transaction cases). No HIGH. The lock-order work is
untouched this round.

### MEDIUM-1 — the archive's "FK-safe in both directions" claim was false (doc + test)

`bank/.claude.md` asserted that the canonical lock order is also the FK-safe one, with the only open
item named as `gl_journal_entries` ← `{customer,supplier}_payments`. The reviewer measured
`23503 customer_payment_allocations_invoice_id_fkey` at the step-6 invoice delete, and
`pg_constraint` lists **38 NO ACTION FKs** into the five relations step 6 touches. Both corrected in
the module doc: the reorder fixed the bank ↔ GL edge and that edge alone; the residual is now
recorded at its real size as **R-053**, with the eight relations blocking the invoice delete named.

The bigger half of this finding was the test. `k071-archive-delete-order.int.test.ts` seeded no
invoice and no payment — its own log said `invoicesArchived: 0` — so `runs === ['completed']` passed
on the only shape that has no FK to violate: a fixture that cannot fail, certifying "we verified"
where the truth was "we did not check". Both halves fixed:

- the first test is renamed to what it actually exercises (`bank ↔ GL edge only`), and the file
  header now says the `completed` run says nothing about the rest;
- a second test, **`R-053 residual`**, seeds the settled shape (a pre-cutoff PAID
  `customer_invoices` row with the `customer_payment_allocations` row that made it paid) and asserts
  the failure BY OUTCOME: `code === '23503'`, `constraint === 'customer_payment_allocations_invoice_id_fkey'`,
  and the invoice still live after the savepoint rollback. It is expected-fail-shaped on purpose,
  and its first assertion carries the message `the archive completed — R-053 may be fixed; rewrite
  this test`. Measured, not argued: the log line is in the run output for this round.

Keeping the 42703 fix on this branch was ruled right by the reviewer; unchanged.

### MEDIUM-2 — contention on the invoice/bill answered 400 (code)

`fetchInvoiceCandidates` / `fetchBillCandidates` raise their lock timeout as
`ReceiptRefusal` / `SupplierPaymentRefusal`, the same classes that carry every refusal ABOUT THE
BOOKS, so the confirm arms could not tell them apart and the route answered both
`apiResponse.badRequest`. On one screen, at one instant, contention answered 409 when the peer held
the bank line and 400 when it held the invoice — 400 being the status this codebase reserves for the
user's own mistake and monitors as such. Fixed in the code, as the brief preferred:

- both refusal classes take `{ retryable?: boolean }` and expose `retryable`; the two contention
  sites are the only places that set it;
- `isRetryable{Receipt,SupplierPayment}Refusal` predicates, structural like their siblings;
- `confirm{Customer,Supplier}Match` return the new `kind: 'contended'` for those, and
  `bank-match-confirm` answers it `apiResponse.conflict`. Every one of these is still decided
  pre-write, so the 4xx `withAuth` COMMITs commits nothing.

Pinned by three new unit cases, all of which run the REAL `plan{,Supplier}AllocationLines` with only
the DB read stubbed — with the `55P03` Postgres raises on our own 5s budget, so the flag's own site
is exercised rather than a mocked rejection: `confirmSupplierMatch.test.ts`,
`confirmCustomerMatch.test.ts`, and both directions at the route in
`bankMatchConfirmRefusalStatus.test.ts` (409 for contention, 400 kept for a books refusal of the
same class).

### MEDIUM-3 — the evidence-attach reorder was pinned by nothing (test)

`evidenceAttachmentService.test.ts`'s docblock still described the OLD order (3 = GL, 4 = bank)
after the service had been reordered — an instruction to the next author to put the deadlock back —
and both mocked returns were `[]`, so nothing detected a swap. Docblock corrected, and the order is
now asserted off `sqlMock.mock.calls`. Its twin,
`POST /api/accounting/provisional/[jeId]/attach`, was pinned by nothing at all; new
`tests/unit/services/capture/provisionalAttachRouteLockOrder.test.ts` covers the route the same way.

### LOW-1 — `lockBankTransactionForUpdate` never restored `lock_timeout` (code)

Added `SET LOCAL lock_timeout = DEFAULT` on the success path, not in a `finally` — the same shape
and the same reasoning as `paymentLock`, `receiptAllocationLines` and `supplierAllocationLines`.
This round moved that call to the FRONT of both confirm arms and of `voidPaymentDocument`, so the 5s
budget was leaking over everything after it.

Every one of those siblings pins its restore in BOTH directions and this one shipped pinned by
nothing, so `tests/unit/services/bankAllocationRowLock.test.ts` — the file that already covers the
helper's other guarantees — now asserts the restore on the success path and its ABSENCE after a
55P03, the second being what stops a future author moving it into a `finally` where it would raise
25P02 over the typed error.

### LOW-2 — the deadlock test's readiness probe was not scoped to its own backend (test)

`pg_stat_activity` matched on statement text alone matches ANY session in the cluster blocked on
that statement, and this fixture database is shared with the other branches: a false positive
returns the probe early, the peer takes the document before the confirm reaches it, and the test
passes on the defect. Both pools now stamp a unique `application_name` (`<test>-<pid>`) and both
probes filter `datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()`.
Fixed in `k071-void-lock-order.int.test.ts` as well as the file the review named — same defect, same
class.

### LOW-3 — duplicated and contradictory rows in the canonical table (doc)

Deleted the superseded `cancelCustomerInvoice, cancelSupplierInvoiceInner` row, and split
`bankRuleAutoPostLine` out of the two rows that gave it two different answers into one row naming
its `DELETE FROM gl_journal_entries` and why that leg is exempt.

**Mutation-proved this round** (file copies, restored after each; never `git checkout --`):
reversing the two UPDATEs in `evidenceAttachmentService.ts` fails the new order assertion; reversing
them in the attach route fails the new route test; removing `{ retryable: true }` from both
contention sites fails both confirm-arm tests; replacing the route's `contended` branch with
`badRequest` fails the 409 case.

---

## Round 11 — review of `7841b7e9b`

### HIGH-1 — round 10 changed the status and never re-ran the branch's own outcome tests (test)

The round classified contention as 409 and validated it against the NEW unit tests only.
`tests/integration/k071-bill-lock-concurrency.int.test.ts:100` and
`k071-invoice-lock-concurrency.int.test.ts:110` — both added by THIS branch, both pinning exactly
the event that was re-classified — still asserted `400`, so `bun run ci` exited 1 with
`[ci] integration-tests FAIL` behind a report of "passed end to end".

The tests were the stale side: 409 for contention is the deliberate change, and the reviewer's own
mutation of `apiResponse.conflict` → `badRequest` proves the code direction. Both assertions and the
comment beside them now read 409; the `/retry in a moment/` and wrote-nothing assertions are
unchanged, because those are what make it a contention answer rather than a bare status swap.

Grepped the branch's whole test set for the old value: every other `400` in the K-071/K-074 files is
a BOOKS refusal (an over-allocation, a sign mismatch, a malformed body) and correctly stays 400.
`k071-lock-order-deadlock.int.test.ts:195` already asserted 409 and `k071-void-lock-order.int.test.ts:199`
asserts `< 500` plus the wording, so neither moved.

### MEDIUM-1 — the 409 rule reached 2 of the 4 routes that answer this event (code)

Enumerated by CONSUMER, not by grepping for the predicate: every caller of
`plan{Receipt,SupplierPayment}Application` and `validateBank{ReceiptApplication,SupplierPayment}`
that can answer HTTP. Four, not two:

| Route | Before | Now |
|---|---|---|
| `bank-match-confirm.ts` (both confirm arms) | 409 | unchanged |
| `ar/receipt-match/confirm.ts:90` | 400 | 409 for `isRetryableReceiptRefusal`, tested first |
| `customer-allocations.ts:110/126` | 409 payment / **400 invoice** | 409 for both |
| `supplier-allocations.ts:123` | 400 for everything | 409 / 400 / re-throw |

`customer-allocations.ts` contradicted itself four lines apart: the contended RECEIPT row raised
`PaymentLockTimeoutError` and answered 409, while the contended INVOICE — the same instant of
contention, raised one call deeper by `planAllocationLines` as a `ReceiptRefusal` carrying
`retryable: true` — fell through to the 400 branch.

**Both directions proved.** The 400 direction is not swept into 409: `retryable` is false on every
books refusal, and each route keeps a case asserting 400 for one (`supplierAllocationsPartialCommit`
"different supplier", `customerAllocationsRefusalStatus` "cancelled", `receiptMatchConfirmPartialCommit`
"not found"). A new `it.each` in `supplierPaymentApplicationService.test.ts` asserts
`retryable === false` on all five plan refusals, so a future `{ retryable: true }` pasted onto a
books refusal goes red rather than silently inviting a retry.

**Every classification is PRE-write.** `validateBank*` is read-only; `plan*` takes its row lock and
runs guards without writing; the apply call is outside the try in both allocation routes. So the
4xx `withAuth` COMMITs commits an empty transaction — asserted at each site by
`expect(apply*).not.toHaveBeenCalled()`.

### LOW-1 — `supplier-allocations.ts` caught everything and answered 400 with raw pg text (code)

Fixed rather than documented away, because `bank/.claude.md:16` — added by this branch — said it was
already true. The fix is two changes that only work together: `planSupplierPaymentApplication` threw
bare `Error`s for its four refusals (its AR twin has thrown `ReceiptRefusal` all along), so
narrowing the route's catch to `isSupplierPaymentRefusal` alone would have turned "Cannot apply a
cancelled payment" into a 500. Those four throws are now typed, and the route classifies exactly as
`customer-allocations.ts` does: 409 for `isPaymentLockTimeout` or `isRetryableSupplierPaymentRefusal`,
400 with `log.info` for a typed refusal, re-throw for everything else. A `42703` and a `TypeError`
each now reach `withErrorHandler` as a 5xx — pinned in both new cases — instead of handing the user
schema and column names on a status that COMMITs.

Widening `planSupplierPaymentApplication`'s throws to a subclass of `Error` cannot narrow any
caller: `supplierAutoAllocate` and `supplierBankPaymentService` do not catch it, and the MCP tool's
`safeErrorText` surfaces `SUPPLIER_PAYMENT_REFUSED` verbatim (it was already in `REFUSAL_CODES`), so
the agent now reads the remedy where it previously got the generic fallback.

**Mutation-proved this round** (file copies, restored after each; never `git checkout --`):

| Mutation | Red |
|---|---|
| delete the `isRetryableReceiptRefusal` arm from `ar/receipt-match/confirm.ts` | `receiptMatchConfirmPartialCommit.test.ts` — 1 failed / 10 passed |
| drop `\|\| isRetryableReceiptRefusal(err)` from `customer-allocations.ts` | `customerAllocationsRefusalStatus.test.ts` — 1 failed / 5 passed |
| restore the catch-all `badRequest(message)` in `supplier-allocations.ts` | `supplierAllocationsPartialCommit.test.ts` — 5 failed / 6 passed |
| untype one `SupplierPaymentRefusal` back to `Error` in `planSupplierPaymentApplication` | `supplierPaymentApplicationService.test.ts` — 1 failed / 28 passed |
