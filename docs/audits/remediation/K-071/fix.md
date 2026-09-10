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
