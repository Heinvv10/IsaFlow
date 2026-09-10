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

---

## Round 13 — the census walked DIRECT importers, and three more routes reach the event

### MEDIUM-1 — `bank/.claude.md` said FOUR routes; there are EIGHT (code + doc)

Round 11 derived its list as "every caller of `plan{Receipt,SupplierPayment}Application` and
`validateBank{ReceiptApplication,SupplierPayment}` that can answer HTTP". That is a census of the
files that IMPORT those symbols. It cannot see a route that reaches them through an intermediary,
and four do:

```
bank-transactions-action  ─┐
bank-transactions-manual  ─┴─→ allocateTransaction
                                 ├─ lockBankTransactionForUpdate      → BANK_TX_LOCK_TIMEOUT
                                 ├─ recordSupplierBankPayment  (ap/supplierAutoAllocate.ts:224)
                                 │    → planSupplierPaymentApplication → PAYMENT_LOCK_TIMEOUT
                                 │      → planSupplierAllocationLines  → SupplierPaymentRefusal{retryable}
                                 └─ autoApplyCustomerReceipt   (ar/customerAutoAllocate.ts:132)
                                      → planReceiptApplication         → PAYMENT_LOCK_TIMEOUT
                                        → planAllocationLines          → ReceiptRefusal{retryable}
supplier-payments-action  ──→ processSupplierPayment / voidSupplierPayment
                                 → lockSupplierPaymentForUpdate        → PAYMENT_LOCK_TIMEOUT
customer-payments-action  ──→ confirmCustomerPayment / cancelCustomerPayment
                                 → lockCustomerPaymentForUpdate        → PAYMENT_LOCK_TIMEOUT
```

Three of the four answered **400** from a blanket catch (`bank-transactions-action.ts:181`,
`supplier-payments-action.ts:54`, `customer-payments-action.ts:45`) — the status this codebase
reserves for the caller's own mistake and monitors as such — for the identical event
`k071-lock-order-deadlock.int.test.ts:195` pins at 409 through `bank-match-confirm`.
`bank-transactions-manual.ts:120` answered **500**, and `apiResponse.internalError` replaces the
service's "retry in a moment" with "An internal error occurred", deleting the only wording the
caller can act on. `bankTxLock.ts:31` conceded the split in prose ("as a 400, or as the 409
`bank-match-confirm` answers") while `bank/.claude.md:79`/`:111` called the census finished; the
source comment was the evidence and both are now corrected.

**Fix.** `src/modules/accounting/services/core/retryableContention.ts` —
`isRetryableContention(err)`, the UNION of `isBankTransactionLockTimeout`, `isPaymentLockTimeout`,
`isRetryableReceiptRefusal` and `isRetryableSupplierPaymentRefusal` — tested before the blanket
branch in all four routes, answering `apiResponse.conflict` with the service's own wording. The
four narrow routes keep their two-predicate checks: they each reach exactly one settlement call and
a precise predicate there is better documentation than a union. A blanket-catch route gets the
union because it cannot know which subset its nine verbs can raise, which is the mistake that
produced this finding.

`PaymentPostedDuringVoidError` is deliberately NOT in the union. It is equally retryable, but it is
raised only by `voidPaymentDocument`, which no HTTP route reaches — `voidSupplierPayment` names it
in a comment and does not call it. An unreachable arm cannot be proved at a route.

**How the enumeration was re-done — PATHS, not directories.** Reverse call graph from the two
`retryable: true` throw sites (`ar/receiptAllocationLines.ts:182`, `ap/supplierAllocationLines.ts:161`)
and the three lock helpers (`lockBankTransactionForUpdate`, `lock{Customer,Supplier}PaymentForUpdate`),
to their enclosing exported service functions (`allocateTransaction`, `splitAllocateTransaction`,
`reverseReconciledTransaction`, `lockForStatusWrite` → `match`/`unmatch`/`exclude`/`delete`,
`autoPostRuleLine`, `confirm{Customer,Supplier}Match`, `confirmCustomerPayment`,
`cancelCustomerPayment`, `processSupplierPayment`, `voidSupplierPayment`, `voidPaymentDocument`,
`plan{Receipt,SupplierPayment}Application`), then to every file under `pages/api/` and `src/lib/mcp/`
naming any of them. That yields nine HTTP routes and the MCP tools. Eight classify contention (four
already did, four fixed here). The ninth, `pages/api/accounting/provisional/[jeId]/attach.ts`, names
`reverseReconciledTransaction` and `voidPaymentDocument` **in a comment only** and calls neither —
verified by reading the handler, not by grep. MCP is not a gap: every tool goes through
`safeErrorText`, whose `REFUSAL_CODES` allowlist carries all four codes, and MCP has no HTTP status
to get wrong.

**Both directions proved**, per route (`tests/unit/api/actionRouteContentionStatus.test.ts`, 12
cases): contention → 409 with the retry wording, AND a non-retryable books refusal → the route's
original 400 with its own message, AND a bare `Error` → still 400 on the three action routes, AND a
`TypeError` → still 500 on the manual route. Every classification is pre-write with respect to the
allocation: the lock timeouts are raised by a `FOR UPDATE` that never acquired the row, and the two
`retryable` refusals by `fetch{Invoice,Bill}Candidates`, which the plan phase runs before `apply*`.

**Why 409 is safe on a route that catches AFTER a write.** Every member of the union descends from
`isLockContention`, i.e. from `55P03` or `40P01`, and both abort the Postgres transaction — so
`withAuth`'s COMMIT on a 4xx is a no-op and nothing survives. That holds even on
`bank-transactions-manual`, which INSERTs its row before allocating: the row is discarded whether
the status is 409 or 500. Only the wording changes.

**REGISTERED, NOT FIXED — R-060.** The four blanket catches remain a partial-commit hazard for any
**non-aborting** post-write throw. `allocateTransaction` has posted a journal, moved
`bank_transactions` and may have created a payment document by the time a `TypeError` or a
`23505` reaches the catch; `voidSupplierPayment` has reversed a journal. Three of the four answer
that 4xx, which `withAuth` COMMITs. This branch deliberately does not widen into it: the remedy is a
plan/apply split per verb (the shape `customer-allocations` and `supplier-allocations` already have),
not a status change, and it is pre-existing rather than introduced here.

### LOW-1 — `k071-void-lock-order.int.test.ts:199` asserted `< 500`, which passes at 400 and 409 alike

The branch's only outcome test on `supplier-payments-action`'s contention answer could not go red
for the defect above, in either direction. Now `expect(result.status).toBe(409)`, matching its two
siblings `k071-{bill,invoice}-lock-concurrency`.

### LOW-2 — `receiptAllocationLines.ts:158` documented "the 400 the caller answers with"

Every caller now answers 409, so the word is corrected. The AP mirror carried no equivalent
sentence at all — `supplierAllocationLines.ts` now states the same rule, and each names the other,
so the two files can no longer drift apart silently.

### Mutation proof (file copies in `<scratchpad>/agents/fix-k071m/bak/`, restored after each)

Against `tests/unit/api/actionRouteContentionStatus.test.ts` (12 passing).

| # | Mutation | Result |
|---|---|---|
| M1 | delete the `isRetryableContention` arm from `bank-transactions-action.ts` | 4 failed / 8 passed |
| M2 | delete it from `bank-transactions-manual.ts` | 1 failed / 11 passed |
| M3 | delete it from `supplier-payments-action.ts` | 1 failed / 11 passed |
| M4 | delete it from `customer-payments-action.ts` | 1 failed / 11 passed |
| M5 | disable the `isBankTransactionLockTimeout` arm of the union | 2 failed / 10 passed |
| M6 | drop the `isRetryableReceiptRefusal` arm | 1 failed / 11 passed |
| M7 | drop the `isRetryableSupplierPaymentRefusal` arm | 1 failed / 11 passed |
| M8 | drop the `isPaymentLockTimeout` arm | 3 failed / 9 passed |
| M9 | union → always `true` (does the 400 direction survive?) | 5 failed / 7 passed |
| M10 | union → `isPaymentLockTimeout` only | 2 failed / 10 passed |

Ten of ten red; M9 is the both-directions proof — sweeping everything into 409 kills the five cases
that pin 400/500.

## Round 15 — review of `726b8ed12` (0 HIGH · 1 MEDIUM · 1 LOW)

### MEDIUM-1 — a ninth route committed a partial sweep behind a 400, and falsified the safety argument (code + doc)

`bank-rules-action` (`apply`) → `applyRules` → `withSavepoint('rule_autopost_line', autoPostRuleLine)`
→ `recordSupplierBankPayment` → `planSupplierPaymentApplication` → `fetchBillCandidates` →
`SupplierPaymentRefusal{retryable:true}`. The sweep's per-line catch skipped ONLY
`BankTransactionLockTimeoutError`. The other three union members arrive through a savepoint whose
`ROLLBACK TO` succeeded, so the request transaction was live: the re-throw reached the route's
blanket 400 and `withAuth` COMMITted every line the sweep had already posted (reviewer's probe:
400 "Action failed", line A posted and committed, line B still imported).

**1. The sweep skips the union** — `bankRulesMatchingService.ts`: `if (!isRetryableContention(lineErr)) throw lineErr;`,
counted in `autoPostSkippedLocked` exactly as the bank-line arm already was. Measured on real SQL
(`tests/integration/k071-rule-sweep-undo-contention.int.test.ts`, first case): every bill held →
**200**, `autoPostSkippedLocked: 1`, line A `allocated`, line B `imported`; control with no holder →
200, line B `allocated`. Both directions in `tests/unit/services/bank/bankRulesSweepContention.test.ts`:
each of the four members is skipped and the next candidate still posts; a books refusal (the same
`SupplierPaymentRefusal` class WITHOUT the flag) and a plain `Error` still end the run.

**2. The invariant is restated, because it was false.** `core/retryableContention.ts` said "every
member is pre-write by construction … there is nothing committed behind it", and `bank/.claude.md`
said contention is safe "because 55P03/40P01 abort the transaction". Both were written as
properties of the UNION. They are properties of the *call that raised it*. The header now names
the two shapes in which a member surfaces — ABORTED (raised on the request transaction; COMMIT
degrades to a rollback) and CONFINED (raised inside a savepoint that rolled back cleanly; the
request is live and earlier writes COMMIT behind the 4xx) — states the rule as **"pre-write, OR
confined to a savepoint that rolled back"**, and says a caller MUST establish which before
answering 409. A loop over savepointed items does not re-throw at all; it skips and counts.

**3. The two other routes on the path.**
- `bank-rules.ts` POST (create + auto-apply) → `applyRules`: after (1) the sweep no longer throws
  any member — the checker-resolved graph shows `applyRules`'s ONLY raiser-reaching callee is
  `autoPostRuleLine`, called only inside the per-line savepoint — so it answers 200 with the count.
  No route change.
- `bank-auto-post.ts` undo → `undoRun` → `reverseReconciledTransaction` → `lockBankTransactionForUpdate`,
  taken on the REQUEST transaction (`bankAllocationService.ts:691`, before the function's own
  savepoint). `undoRun`'s per-row catch swallowed the typed error on the aborted transaction, so
  the next statement raised 25P02 and the route answered 400 "Undo failed". Worse, had the swallow
  succeeded the run would have been marked undone and could never be retried. Now `undoRun`
  re-throws the union (before the log-and-skip) and the route answers `apiResponse.conflict` with
  the service's wording. ABORTED shape, so it is safe: measured (second integration case) with the
  line undoRun's own SELECT returns LAST held, so one line IS reversed before the contention →
  **409** "retry in a moment", BOTH lines still `allocated`, `undone_at` NULL (the log shows the
  first reversal's `JE-2026-00005` number re-used by the control run — the reversal was rolled
  back, not committed). Control, no holder → 200 `{reversed: 2, skipped: 0}`. Other direction in
  `autoPostUndoService.test.ts`: a non-contention failure is still logged, counted as skipped, and
  the run still marked undone; in `bankAutoPostUndoContention.test.ts` a plain `Error` still 400s.

### LOW-1 — the census boundary is recorded (doc)

The census is no longer walked by hand. `<scratchpad>/agents/fix-k071n/callgraph-ts.cjs` (reproduced
below so the next round can re-run it) builds a reverse call graph with the **TypeScript checker**,
so every identifier is resolved to its declaration through imports, re-exports
(`bankRulesService` → `applyRules`), namespace imports, `{ fn }` shorthand and
`const { f } = await import(...)`. That removes the reviewer's `callgraph2.py` limitation: names
defined in more than one file are distinct nodes, not dropped. Seeds are the CONSTRUCTION sites
of the events, found by the script (`new BankTransactionLockTimeoutError`, `new PaymentLockTimeoutError`,
`retryable: true`), not a list of helper names — it found exactly the five the reviewer seeded.
Walked: every `.ts`/`.tsx` in `src/**` and `pages/**` that `tsconfig.json` includes (so NOT
`tests/**` or `scripts/**`); 118 symbols to fixpoint. Entry = any file under `pages/api/**` or
`src/lib/mcp/**`; any reached symbol nobody references is printed as a root to classify by hand.

Known limits: only STATIC references are followed — a computed call (`obj[verb]()`), a
string-keyed registry, or an untyped `any` receiver is invisible. The MCP registry is the one
string-keyed dispatch here and every tool file is itself an entry. One root: `importBankStatement`
(`bankImportService.ts:39`) — re-exported by `bankReconciliationService.ts:340` and imported by
nothing (dead; mentioned, not deleted). The reviewer's `provisional/outstanding` row is NOT reached:
`postProvisional` calls no raiser. `provisional/[jeId]/attach` is not reached either (comment only).

**Every entry reached, and how it answers (after this round):**

| Entry | Reaches via | Answer to contention |
|---|---|---|
| `bank-match-confirm` | `confirm{Supplier,Customer}InvoiceMatch`, `allocateTransaction`, `matchTransaction` (transfer + journal-line arms) | 409 (narrow; `matchTransaction` locks on the request tx before any write in its arm) |
| `ar/receipt-match/confirm` | `validateBankReceiptApplication`, `confirmReceiptMatch` | 409 (narrow) |
| `customer-allocations` | `planReceiptApplication` | 409 (narrow) |
| `supplier-allocations` | `planSupplierPaymentApplication` | 409 (narrow) |
| `bank-transactions-action` | `match`/`unmatch`/`exclude`/`autoMatch`/`allocate`/`split`/`reverse` | 409 (union, r13) |
| `bank-transactions-manual` | `allocateTransaction` | 409 (union, r13) |
| `supplier-payments-action` | `processSupplierPayment`, `voidSupplierPayment` | 409 (union, r13) |
| `customer-payments-action` | `confirm`/`cancelCustomerPayment` | 409 (union, r13) |
| **`bank-auto-post`** (undo) | `undoRun` → `reverseReconciledTransaction` | **409 (union, r15)** — ABORTED shape, measured |
| **`bank-rules-action`** (apply) | `applyRules` → `autoPostRuleLine` | **200, counted skip (r15)** — measured |
| **`bank-rules`** (POST) | `applyRules` → `autoPostRuleLine` | **200, counted skip (r15)** — same service |
| `smart-categorize` | `sweep` → `allocateTransaction` | swallowed in-service, 25P02 — **R-065** |
| `bank-transactions-bulk-commit` | `importParsedTransactions` → `sweep` | swallowed; import's own savepoint discards the sweep as "non-fatal" — **R-065** |
| `bank-feeds/[id]/extension-ingest` | `importParsedTransactions` → `sweep` | same — **R-065** |
| 11 MCP tools (`allocationApplyRoute`, `allocationLine`, `writeApplyReceipt`, `writeApplySupplierPayment`, `writeBankAllocate`, `writeBankImport`, `writeBankReconciliation`, `writeBankReverseBatch`, `writeBankReverseRange`, `writeSettleByContra`, `writeVoidPayments`) | as named | registry savepoint per tool + `safeErrorText` (`REFUSAL_CODES` carries all four codes); no HTTP status |

**The second hop, recorded** (raiser-reaching callees, from the script's `KIDS=` output):
`applyRules → autoPostRuleLine → {lockBankTransactionForUpdate, recordSupplierBankPayment}`;
`undoRun → reverseReconciledTransaction → lockBankTransactionForUpdate`;
`importParsedTransactions → sweep → allocateTransaction`. Re-run after this change: the entry set
is identical to the run on `726b8ed12` (only line numbers moved), so the fix added no path.

### Registered, not fixed — R-065 (reserved with `reserve-r-id.sh`)

`autoPostGateService.sweep` catches every per-row failure with NO savepoint. A contended
`allocateTransaction` raises its 55P03 on the request transaction, the catch logs it as a skip,
and the next statement is a 25P02: `smart-categorize` calls `sweep` directly; the two import routes
reach it through `importParsedTransactions`, whose savepoint then throws the whole sweep away as
"non-fatal". The caught-error-poisons-the-transaction hazard, pre-existing and outside this round
(the blanket-catch hazard in general stays R-060).

### Mutation proof (file copies in `<scratchpad>/agents/fix-k071n/bak/`, restored; `git diff` hash identical after)

| # | Mutation | Unit (3 files, 13 tests) | Integration (2 tests) |
|---|---|---|---|
| M1 | sweep catch back to the bank-line lock only | 3 failed | 1 failed — `expected 400 to be 200` |
| M4 | sweep catch swallows everything (both-directions check) | 2 failed | — |
| M2 | drop `undoRun`'s re-throw | 1 failed | 1 failed — `expected 400 to be 409` |
| M3 | drop the route's 409 arm | 1 failed | 1 failed — `expected 400 to be 409` |

M1's integration failure is the reviewer's defect reproduced (400 with line A committed); M2's is
the 25P02 path (400 "Undo failed").

### The census script

```js
// Reverse call graph with the TypeScript CHECKER (not name matching): every
// identifier is resolved to its declaration through imports, re-exports and
// dynamic `await import()` destructuring, so same-named symbols in different
// files are distinct nodes and none has to be dropped. Seeds are derived from
// the CONSTRUCTION sites of the contention events, not from helper names.
// Usage: node callgraph-ts.cjs <worktree>
const path = require('path');
const W = process.argv[2];
const ts = require(path.join(W, 'node_modules/typescript'));
const cfgPath = path.join(W, 'tsconfig.json');
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, W);
const program = ts.createProgram(cfg.fileNames, cfg.options);
const checker = program.getTypeChecker();
const rel = (f) => path.relative(W, f);
const files = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile
  && !sf.fileName.includes('node_modules') && /^(src|pages)\//.test(rel(sf.fileName)));
const isEntry = (f) => /^pages\/api\//.test(f) || /^src\/lib\/mcp\//.test(f);

function resolve(sym) {
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym); } catch { /* keep */ } }
  const d = sym.declarations && sym.declarations[0];
  // const { f } = await import('./x')  →  x's export f
  if (d && ts.isBindingElement(d) && ts.isObjectBindingPattern(d.parent)) {
    const vd = d.parent.parent;
    if (ts.isVariableDeclaration(vd) && vd.initializer) {
      const prop = checker.getPropertyOfType(checker.getTypeAtLocation(vd.initializer),
        (d.propertyName || d.name).getText());
      if (prop) return resolve(prop);
    }
  }
  return sym;
}
function ownerOf(node) {
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n)
      || ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) && n.name && ts.isIdentifier(n.name)) {
      return resolve(checker.getSymbolAtLocation(n.name));
    }
  }
  return null; // module scope
}
const label = (sym) => {
  const d = sym.declarations && sym.declarations[0];
  const sf = d && d.getSourceFile();
  return sf ? `${sym.name}@${path.basename(sf.fileName)}:${sf.getLineAndCharacterOfPosition(d.getStart()).line + 1}` : sym.name;
};
// Index every identifier reference by text once; resolve lazily per frontier symbol.
const byText = new Map();
for (const sf of files) {
  (function walk(n) {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isDeclName = p && p.name === n && (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)
        || ts.isMethodDeclaration(p) || ts.isClassDeclaration(p) || ts.isParameter(p) || ts.isPropertyDeclaration(p));
      if (!isDeclName) { if (!byText.has(n.text)) byText.set(n.text, []); byText.get(n.text).push(n); }
    }
    ts.forEachChild(n, walk);
  })(sf);
}
// Seeds: the functions that CONSTRUCT a contention event.
const seeds = new Map();
for (const sf of files) {
  (function walk(n) {
    const hit = (ts.isNewExpression(n) && /^(BankTransactionLockTimeoutError|PaymentLockTimeoutError)$/.test(n.expression.getText()))
      || (ts.isPropertyAssignment(n) && n.name.getText() === 'retryable' && n.initializer.kind === ts.SyntaxKind.TrueKeyword);
    if (hit) { const o = ownerOf(n); if (o) seeds.set(o, `${rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`); }
    ts.forEachChild(n, walk);
  })(sf);
}
const parent = new Map(); const q = [];
for (const s of seeds.keys()) { parent.set(s, null); q.push(s); }
const entries = new Map(); const roots = new Map(); const kids = new Map();
while (q.length) {
  const sym = q.shift(); let referenced = false;
  for (const id of byText.get(sym.name) || []) {
    // `{ fn }` shorthand: getSymbolAtLocation answers the PROPERTY, not the value.
    const at = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
      ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
    if (resolve(at) !== sym) continue;
    referenced = true;
    const sf = id.getSourceFile(); const f = rel(sf.fileName);
    const where = `${f}:${sf.getLineAndCharacterOfPosition(id.getStart()).line + 1}`;
    if (isEntry(f)) {
      if (!entries.has(f)) entries.set(f, new Set());
      const chain = []; for (let s = sym; s; s = parent.get(s)) chain.push(label(s));
      entries.get(f).add(`${where}  ${chain.join(' -> ')}`);
      continue;
    }
    const o = ownerOf(id);
    if (!o) { roots.set(`${where} (module scope, refs ${sym.name})`, true); continue; }
    if (!kids.has(o)) kids.set(o, new Set()); kids.get(o).add(label(sym));
    if (!parent.has(o)) { parent.set(o, sym); q.push(o); }
  }
  if (!referenced) roots.set(`${label(sym)} (no references outside entries)`, true);
}
console.log('# seeds (construction sites)'); for (const [s, w] of seeds) console.log(`  ${label(s)}  <- ${w}`);
console.log(`\n# entry files reached: ${entries.size}`);
for (const f of [...entries.keys()].sort()) { console.log(f); for (const p of [...entries.get(f)].sort()) console.log('    ' + p); }
console.log(`\n# non-entry roots (reached symbols nobody references, or module-scope refs) — classify by hand`);
for (const r of [...roots.keys()].sort()) console.log('  ' + r);
// Every raiser-reaching callee of the named symbols — one BFS parent per node
// hides a second path, so classify an entry by ALL of what it references.
const want = (process.env.KIDS || '').split(',').filter(Boolean);
if (want.length) console.log('\n# raiser-reaching callees of: ' + want.join(', '));
for (const [o, set] of kids) if (want.includes(o.name)) console.log(`  ${label(o)} -> ${[...set].sort().join(', ')}`);
console.log(`\n# symbols walked: ${parent.size}`);
console.log([...parent.keys()].map(label).sort().join('\n'));
```

### Gates (this round, on the working tree that is committed below)

`env -u DATABASE_URL bun run ci` (load average ~28–32):

    [ci] unit-tests PASS    — Test Files 803 passed | 36 skipped (839); Tests 9557 passed | 234 skipped (9791)
    [ci] component-tests PASS — Test Files 61 passed (61); Tests 416 passed (416)
    [ci] build PASS
    [ci] all checks passed
    EXIT=0

Integration, whole suite, `source fixture.env && bunx vitest run --config vitest.integration.config.ts --no-file-parallelism`
(load average ~50):

    Test Files  32 failed | 78 passed (110)
    Tests  12 failed | 428 passed | 167 skipped (607)
    EXIT=1

The environment baseline is 32 files / 12 tests failed / 426 passed. The counts are identical, no
k071/k074 file is among the 32 failing (auth/2FA, AFS, aging, CSP and similar environment files),
and 428 = 426 + the two new cases in `k071-rule-sweep-undo-contention.int.test.ts` — absent from
the FAIL list, and both scenarios' own log lines (`autoPostSkippedLocked: 1`, "Auto-post undo hit a
contended line") appear in the run.

---

## Round 17 — MEDIUM-1: the census tool's blind spot, and the defect behind it

### The finding

`bulkAllocationPost.ts:199` classified per-line contention on `BANK_TX_LOCK_TIMEOUT` alone,
while `writeBankBulkAllocate → postPreparedLines → postAllocationLine → allocateTransaction`
reaches all four members of `isRetryableContention` — through `recordSupplierBankPayment` /
`autoApplyCustomerReceipt`. A retryable `SupplierPaymentRefusal`, a retryable `ReceiptRefusal`
and a `PaymentLockTimeoutError` each failed the whole batch, contradicting
`src/lib/mcp/.claude.md` and the file's own comment. Not financial (the registry savepoint
unwinds and nothing is posted), but it is the narrow-predicate mistake `isRetryableContention`
exists to prevent.

**Fix:** `src/lib/mcp/tools/bulkAllocationPost.ts` — the local `isLockTimeout` helper is gone
and the catch arm calls `isRetryableContention`. The reason wording is unchanged
(`locked by another request — retry`), which is what the docs and the existing test pin.

### The tool, not just the site

`callgraph-ts.cjs` treated ANY `src/lib/mcp/**` file as a terminal entry, so a tool reaching a
raiser THROUGH another mcp file was invisible. An HTTP route genuinely is a boundary — nothing
in the graph calls into `pages/api/**` — but an mcp helper is not: a tool handler calls sibling
mcp files. The tool now records an mcp file as an entry AND keeps walking up out of it
(`isHttpEntry` / `isMcpEntry`); only `pages/api/**` still terminates the walk.

Re-run on this worktree: **28 entry files** (was 25). The 14 `pages/api/**` entries are
byte-identical. The three the old tool could not see:

| New entry | Classification |
|---|---|
| `src/lib/mcp/tools/bulkAllocationPost.ts` | **the defect** — fixed above |
| `src/lib/mcp/tools/writeBankBulkAllocate.ts` | clean: no try/catch around the batch at all (`:152-155`); a throw must reach the registry savepoint |
| `src/lib/mcp/toolIndex.ts` | clean: module-scope registration, classifies nothing |

Cross-checked by predicate as well: every `BANK_TX_LOCK_TIMEOUT` / `PAYMENT_LOCK_TIMEOUT` /
`isRetryable*` / `isRetryableContention` mention under `src/lib/mcp/` and
`pages/api/accounting/`. The only other narrow classifiers are the four documented NARROW-call
routes (`bank-match-confirm`, `ar/receipt-match/confirm`, `customer-allocations`,
`supplier-allocations`) that `retryableContention.ts`'s header names as correct by construction.
`writeMergeGlAccounts.ts:158` reads `GL_ACCOUNT_LOCK_TIMEOUT` — a different lock, taken as the
first statement of its own write path, not a member of this union. `toolHelpers.ts` is an
allowlist of refusal codes, not a contention classifier. **No further R-id reserved: nothing was
found out of scope.**

### Docs

`src/lib/mcp/.claude.md` (the bulk-allocation bullet) now says contention is classified with
`isRetryableContention`, names the call path that reaches the other three members, and records
what reading the code alone cost. The comment in `bulkAllocationPost.ts` says the same.
`src/lib/mcp/AGENTS.md` regenerated with `bun run agent-docs:generate`; `agent-docs:check` →
`OK: 74 agent document mirror(s) match canonical sources.` Never hand-edited.

### Proof, by outcome, in both directions

`tests/unit/mcp/bulkAllocateSkipAllocated.test.ts` — a new describe block builds each member
from its REAL class (`PaymentLockTimeoutError`, `ReceiptRefusal({retryable:true})`,
`SupplierPaymentRefusal({retryable:true})`, plus the bank-lock code), so a member that changes
its code or flag breaks this file rather than silently leaving the batch fatal.

- all four: line 2 skipped with `locked by another request — retry`, `posted: 2`, and
  `allocateTransaction` called 3 times — the batch carries on.
- the other direction: a `SupplierPaymentRefusal` with `retryable` FALSE (a cancelled bill)
  still throws `BulkAllocationLineError` at index 1 and records no batch lines.

Mutations (file copy restored, never `git checkout --`):

| Mutation | Result |
|---|---|
| catch arm back to `code === 'BANK_TX_LOCK_TIMEOUT'` | **3 failed** — payment lock, receipt refusal, supplier refusal |
| catch arm to `true \|\| isRetryableContention(err)` | **6 failed** — incl. "still FAILS the batch on a refusal about the books" |
| unmutated | 25 passed |

### Gates (round 17, foreground, on the tree committed below)

`env -u DATABASE_URL bun run ci` (load average 20.45 at start):

    [ci] build PASS

    [ci] all checks passed
    EXIT=0

Integration, `source fixture.env && bunx vitest run --config vitest.integration.config.ts
--no-file-parallelism tests/integration`:

    Test Files  32 failed | 78 passed (110)
    Tests  12 failed | 428 passed | 167 skipped (607)
    EXIT=1

Identical to the round-16 baseline; no k071/k074 file among the failures (grepped the FAIL/×
lines for `k071|k074|bulkAlloc|bankRules|undo` — no matches).

**Not done:** R-060 and R-065 (out of scope for this round). No migration.

## Round 18 — merge `origin/master` (c1ecf6fb9) into the branch

No new findings. Eleven conflicts, every one resolved by keeping BOTH sides' intent; none of
them required choosing between two contradictory fixes.

| Conflict | master was fixing | this branch was fixing | kept |
|---|---|---|---|
| `bank/bankTxLock.ts` | K-140: `tableLockUnavailable` probe + `BankMatchUnavailableError`, and the reasoning for reading a bare 55P03 as row contention | classification widened to `isLockContention` (55P03 **and** 40P01) + the structural `isBankTransactionLockTimeout` | both. The catch classifies with `isLockContention`; master's comment is kept and extended. `LOCK_NOT_AVAILABLE` was lost in the textual merge and is restored — the probe's `isLockNotAvailable` uses it. |
| `ar/receiptAllocationLines.ts` | the invoice row lock, factored into the shared `withCustomerInvoiceLock` (also used by `creditNoteCancelService`) | the same lock, hand-rolled, mapping contention to a **retryable** `ReceiptRefusal` so the routes answer 409 | both. Master's helper takes the lock; the call site maps `CustomerInvoiceLockTimeoutError` (its 55P03 mapping) **and** a raw 40P01 to the retryable refusal. The helper is untouched, so its other caller is unaffected. |
| `core/duplicateMergeService.ts` | `rowCount` is always `undefined` on the `sql` tag, so `count` was always 0 — fixed with `RETURNING id` + `.length` | payments locked before invoices (canonical lock order) | both: payments first, both statements with `RETURNING id`. |
| `bank/bankRulesMatchingService.ts` | imports for the suggestion pass | `isRetryableContention` for the skip-and-count sweep | both imports; master's `BankTransactionLockTimeoutError` import is dropped because the merged body classifies with the union, which subsumes it. |
| `mcp/tools/toolHelpers.ts` | `safeErrorText` keyed on `isCallerSafeError` (a `_LOCK_TIMEOUT` suffix test) | an identity ALLOWLIST (`REFUSAL_CODES`) | the allowlist: every code the suffix test admitted is named in it, so master's "contention reaches the agent" intent survives by identity. |
| `ar/receipt-match/confirm.ts` | `isRefusal = isCallerSafeError` | typed `isReceiptRefusal` / `isRetryableReceiptRefusal` (400/409) | the typed predicates, which are strictly narrower and carry master's lock-timeout case through the retryable arm. |
| `supplier-payments-action.ts` | the blanket `badRequest(err.message)` replaced by a typed chain ending in `throw err`, so an unclassified error is a 500 that rolls the claim back | a 409 arm for contention | both, contention first. See the one gate-forced addition below. |
| `bank/.claude.md` (+ regenerated `AGENTS.md`) | new modules and signatures (suggestion pass, auto-post gate/undo, `tableLockUnavailable`, `rulePattern`) | the compressed rewrite of the same sections | the compressed form, with master's new facts folded in. The mirror was regenerated (`agent-docs:generate`), never hand-merged; `agent-docs:check` reports 74 mirrors matching. |
| `tests/unit/services/ar/receiptApplicationService.test.ts` | the dry-run guard matched on statement forms | the same guard, anchored and alias-aware | this branch's, a strict superset. |
| `tests/unit/services/supplierPaymentWorkflowService.test.ts` | the status-predicated CLAIM | the payment row lock | both — the merged path takes the lock **and** the claim, so the mock chains gained one more `mockResolvedValueOnce`; the call-index comments say so. |

### What the gate found, and what it forced

The branch's own guards caught six things the textual merge had left inconsistent. Each was
fixed by making the merged code right, not by relaxing an expectation:

1. **`tests/unit/mcp/typedRefusalReachesAgent.test.ts` census** — master declares 24 refusal
   codes the allowlist did not name, and renamed `RECLASS_LINE_LOCKED` to
   `RECLASS_LINE_LOCK_TIMEOUT`. `REFUSAL_CODES` now lists all 38 genuine refusals.
2. **One of those is not a refusal.** `ClaimOutsideTransactionError`
   (`CLAIM_OUTSIDE_TRANSACTION`) marks a programmer error — a claim attempted outside a request
   transaction — and its message names internal machinery, so surfacing it to an agent offers a
   remedy the caller cannot act on. Under master's `isCallerSafeError` it was hidden. This is
   the case the census docblock itself prescribed a split for, so the split is implemented:
   `NOT_A_REFUSAL_CODES` beside `REFUSAL_CODES`, and the census now requires every declared code
   to be in exactly one set — surfaced, or pinned to the fallback. **This is the only test
   expectation changed rather than satisfied, and it is the change the test asked for.**
3. **`als` module mocks vs `tests/unit/helpers/requestCtx`.** Both sides solved "the lock needs
   a request transaction", master with `enterFakeRequestCtx` (calls `als.enterWith`), this
   branch by stubbing `als.getStore`. Spreading the ALS instance drops its prototype methods, so
   the two together threw `als.enterWith is not a function`. Where the branch's `mockTx.present`
   toggle subsumes the helper (`receiptApplicationService`, `receiptMatchConfirmService`) the
   helper call is removed; where master's test enters a context explicitly
   (`supplierPaymentWorkflowService`) the mock restores `run`.
4. **`undoRun` returns a third counter.** Master added `alreadyUndone`; the branch's exact-equality
   assertion gained it as `0`, with a note on what it counts.
5. **`actionRouteContentionStatus.test.ts`** stubbed the workflow service without the two error
   classes the route now classifies on. The mock uses `importOriginal` so `instanceof` sees the
   real constructors, not stubs.
6. **Gate-forced behaviour addition (the only one).** Master's typed chain re-throws anything it
   does not name, so a typed `SupplierPaymentRefusal` — a books refusal this branch answers 400
   with its own wording — became a 500. An arm for `isSupplierPaymentRefusal` is added after the
   contention check. Safe under master's own rule: every construction site of that class is a
   plan/validate function that has written nothing (`supplierAllocationLines`,
   `supplierBankPaymentService`, `supplierPaymentApplicationService`). An unclassified error
   still reaches the 500.

### Gates (round 18, foreground)

`env -u DATABASE_URL bun run ci` (load average 31.70 at start):

    [ci] build PASS

    [ci] all checks passed
    EXIT=0
