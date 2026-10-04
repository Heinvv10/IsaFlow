# R-185 — the Paystack fee journal posts once per reference, under concurrency

## Defect

`postGatewayFee` (`src/modules/accounting/services/ar/gatewayFeeService.ts`) guarded the fee leg
with a SELECT on `gl_journal_entries` (company, reference, `posting_agent =
'system:paystack-receipt:v1'`, `status IS DISTINCT FROM 'reversed'`) and then inserted. Nothing
enforced it. Two dedupe-path deliveries for one reference (two webhook bodies, or verify and the
webhook, after the receipt is banked) could both pass the SELECT and both post the fee: the
expense doubled and Bank fell short of the deposit by the fee. Pre-existing; recorded by the R-181
PR #618 final review.

## Decision (Hein, 2026-10-03)

`.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md` §3: a partial unique index by
migration; a census for existing duplicates first; the migration fails loudly on duplicates and
never dedupes (gate G2); `postGatewayFee` treats a conflict as "already posted", detected by
outcome, in its own savepoint.

## Fee journal vs receipt journal (from code)

- **Receipt journal:** `confirmCustomerPayment` (`customerPaymentAllocationService.ts:94`) calls
  `createJournalEntry` with `postingAgent: GATEWAY_RECEIPT_AGENT` and NO `reference`, and
  `createJournalEntryInTransaction` writes `${input.reference || null}`. Its reference is NULL, so
  it is outside the index.
- **Fee journal:** the only writer of `GATEWAY_RECEIPT_AGENT` WITH a reference
  (`gatewayFeeService.ts`, `reference: receipt.reference`). No SQL, script or other service writes
  that agent (`grep` over `src pages scripts`).
- **A reversal of a fee journal** (by hand; `cancelCustomerPayment` reverses only the receipt's
  `gl_journal_entry_id`): `reverseJournalEntryInner` creates the contra with no `reference`
  (NULL), stamped with the caller's agent or `human:<userId>`, so the contra is never indexed. The
  original keeps `status = 'posted'` (the reversal is `reversed_at` metadata), so a reversed fee
  journal still occupies its reference. That is the existing guard's semantics too (it ignores
  only `status = 'reversed'`, which no code in `src`/`pages`/migrations sets on a journal): after a
  reversal the fee is not re-posted by a redelivery.
- **Schema:** `status varchar(20)`, nullable, default `'draft'`, CHECK `draft | posted | reversed`.
  `reference varchar(255)` nullable. `IS DISTINCT FROM` keeps a NULL-status row inside the index,
  as in the guard.
- **No `ON CONFLICT`** in `src pages scripts` targets `gl_journal_entries`.

## Fix

- **Migration `852_gateway_fee_journal_unique.sql`:** `CREATE UNIQUE INDEX IF NOT EXISTS
  ux_gl_je_gateway_fee_reference ON gl_journal_entries (company_id, reference) WHERE posting_agent =
  'system:paystack-receipt:v1' AND reference IS NOT NULL AND status IS DISTINCT FROM 'reversed'`.
  A DO block first counts the duplicate groups and `RAISE EXCEPTION`s with the count. A bare
  `CREATE UNIQUE INDEX` would also fail, but names only one key. The census query is in the
  header. The build holds a SHARE lock on `gl_journal_entries` (blocks journal writes) for a full
  scan. `SET LOCAL lock_timeout = '5s'` bounds only the WAIT for that lock; `SET LOCAL
  statement_timeout = '120s'` (PR #626 review) bounds how long the census scan and the build may
  then run while holding it. Either cancels the statement and the file rolls back. The prod row
  count was not measured here; the fixture has 0 rows, so its timing proves nothing about prod.
  Proven through the runner's own path (`migration.round4.runner-probe.log`): `applyOne` sends the
  whole file as ONE multi-statement simple query inside BEGIN. A probe file with `SET LOCAL
  statement_timeout = '1s'; CREATE TABLE ...; SELECT pg_sleep(3);`, run through a verbatim copy of
  `applyOne` (it is not exported) on the fixture, failed with 57014 after ~1.0s and rolled back:
  no sentinel table, no `schema_migrations` row, and the setting did not outlive the transaction.
  So a `SET LOCAL` in the file arms the timeout for the statements after it. The probe does not
  show whether the limit runs per statement or across the rest of the string; either way the
  index build is bounded by 120s.
  Not `CONCURRENTLY`, because the runner wraps each file in a transaction.
- **Code:** the guard SELECT stays as the fast path (`findFeeJournal`, same predicate as the
  index). The create and post run in `withSavepoint('gateway_fee_post')`. On ANY failure the
  journal is re-read: if it is present, another delivery posted it, so log at info and return; if
  it is absent, rethrow the original error. No error code or message is matched. The savepoint is
  load-bearing. `sql.transaction`'s own batch savepoint already contains a 23505 on the INSERT,
  but a failed POST leaves this call's own draft. Without the rollback the re-read would find that
  draft and swallow the failure (mutant M3).
- **Lock order** is unchanged. Two interleavings, both tested:
  - The winner COMMITTED between the loser's guard and its insert: the loser's insert raises 23505
    on `ux_gl_je_gateway_fee_reference`. This is the window that posted the fee twice before 852.
  - The winner is still UNCOMMITTED at the loser's insert: the loser blocks and raises 23505 on
    `uq_gl_je_company_entry_number` when the winner commits, not on 852's index. The entry-number
    trigger (`generate_journal_entry_number`) is MAX+1 over committed rows, so both compute one
    number, and that older index is checked first. This is deterministic, and it held before 852
    too: pre-fix, that loser answered 500 and was redelivered. If the winner rolls back, the
    loser's insert proceeds and posts the one fee.
  - Either way the re-read (READ COMMITTED, new statement) decides by outcome; it does not care
    which constraint fired. The winner holds nothing the loser needs before its insert on the
    dedupe path (no request UPDATE; the link spend is a no-op once spent).
- **Stand-down detail (PR #626 review):** the re-read returns the row. A DRAFT row stops the post
  exactly as before (same semantics as the guard) but logs `warn` (the fast-path guard too, since
  round 4: a draft already stuck when the delivery arrives is the realistic case) "a DRAFT fee journal already
  holds the reference" with its id, not `info` "already posted". The swallowed error's `code` is
  read null-safely: a thrown `null` used to raise a TypeError in the log line instead of standing
  down; with no journal found it is rethrown as the same `null`.
- **Logs on a lost race:** `journalEntryCrudService` logs `error` "Failed to create journal entry"
  with the 23505, then the stand-down `info` "Gateway fee already posted by a concurrent delivery"
  carries the swallowed `code` and message (no stack). The shared service is not changed; the error
  line is expected noise on this path (also in `ar/.claude.md`).

## Census (G2/G3): dev 0, prod 0

Query in the header of `852_gateway_fee_journal_unique.sql`; it must return 0 rows before 852 is
applied, or 852 refuses.

- **dev (`isaflow_dev`), 2026-10-03, read-only, run by the orchestrator:** 0 duplicate groups, and 0
  journals with the agent at all.
- **prod (`isaflow`), 2026-10-04, read-only (G3, approved by Hein):** 0 duplicate groups, and 0
  journals with the agent at all (38,166 `gl_journal_entries` rows at 01:20 SAST, 38,343 at the
  03:28 re-run). The index is not present yet. So 852 will build. The race has never posted a
  duplicate fee on prod, because no Paystack fee journal exists there. `census.prod.log` is the
  03:28 re-run with `psql -e`, so every query is echoed above its result; the 01:20 run did not echo
  its SQL (rev-626-land2).

## Tests

- `tests/integration/r185-gateway-fee-unique.int.test.ts` (real webhook route, fixture):
  - Race: a receipt is banked without a fee. Delivery A stops right after its fee-guard SELECT
    finds nothing (sql wrapper hook, asserted fired once). Delivery B, a different body for the
    same reference, then runs to COMMIT, and A resumes. Asserts: both 200, exactly 1 fee journal,
    Bank nets R112.00 and fee R3.00, all 3 events `processed` (the loser's transaction committed
    after the fee path).
  - Closed period: the fee post fails. Asserts: 500, no journal with the reference (not even a
    draft), event unprocessed with `processing_error`.
  - B inserts while A holds its uncommitted fee journal (A paused at its processed stamp; B seen
    in `pg_stat_activity`, in this database, blocked by A's backend pid, on its INSERT; hook
    asserted fired): A commits → B 200,
    stand-down logged with `code` 23505, exactly 1 fee journal; A rolls back → A 500, B posts,
    exactly 1 fee journal, no stand-down.
  - Company scope: a live fee journal for the SAME reference in another company does not stop
    A's fee (pins `company_id` in `findFeeJournal`, then named `feeJournalExists`; killed by M12).
  - Index predicate: refuses a second live fee journal (posted/posted, draft/posted,
    NULL/posted). Admits two NULL-reference journals with the agent (receipts), another agent with
    the same reference, and a `reversed` row. Round 0's NULL case bound `status ?? 'posted'`, so it
    inserted 'posted', not NULL; the NULL claim was false until round 1 (`'status' in row`, killed
    by M9).
- `tests/unit/services/ar/gatewayFeeIdempotency.test.ts`: the error shape Postgres raises
  (`pg-23505.shape.log`, captured from the fixture). 23505 with the journal present stands down.
  23505 with it absent rethrows the same error object. A post failure with no journal rethrows.
  Any error, not only 23505 (a 40P01 from the post), with the journal present stands down (pins
  "no code matched"; killed by M11). The create and post run inside the savepoint callback (the mock records an in-savepoint flag
  per call). The stand-down log carries `code` and message.
- `tests/unit/services/ar/gatewayFeeLeg.test.ts`: neon mock gains `withSavepoint` (new import).

## Evidence

| File | What | Result |
|---|---|---|
| `red.unit.log` | unit, HEAD code | 3 failed / 1 passed (no stand-down, no re-read, no savepoint) |
| `red.int.log` | int, HEAD code, no 852 | 2 failed / 2 passed (race: 2 fee journals; index probe: no 23505) |
| `migration.fixture.log` | duplicates → RAISE (rolled back); clean → applied; re-run no-op | as stated |
| `pg-23505.shape.log` | node-postgres error for the index | code 23505, constraint `ux_gl_je_gateway_fee_reference` |
| `green.unit.log` | unit, fix (round 0, `1910c157b` + working tree) | 9/9 (2 files) |
| `green.int.log` | int, fix + 852 | 4/4 |
| `mutations.log` | 8 mutants, baselines before and after green | 8/8 RED |
| `regression.unit.log` | `tests/unit/services/ar/gateway*`, `tests/unit/services/billing/paystack*` | 9 files, 126/126 |
| `regression.int.log` | r181-*, k-036, r167*, r178*, link-revoke*, k-035, k095*, k096*, r185 | 22 files, 207/211; the 4 failures are all in k-035 |
| `regression.k035-attribution.int.log` | k-035 on HEAD code, no 852 | the same 4 failures: pre-existing |
| `gates.log` | migration-naming, migration-rls, check-client-responses, agent-docs, type-check, lint | all exit 0 |
| **Round 1, at committed `0c1543d33`** (code tree clean; only these logs untracked) | | |
| `green.round1.unit.log` | unit | 9/9 (2 files) |
| `green.round1.int.log` | int, 852 applied | 6/6 |
| `mutations.round1.log` | M1-M10, baselines before and after green | 10/10 RED. M9 (`<> 'reversed'` in index and guard) is the NULL-status red; M10 (create/post outside the savepoint callback) the unit red. M1 kills the committed-winner race and the index probe; the uncommitted-winner interleavings survive M1 by design (their arbiter is the entry-number index) |
| `regression.round1.unit.log` | same 9 files | 126/126 |
| `regression.round1.int.log` | same 22 files | 209/213; the same 4 pre-existing k-035 failures |
| `gates.round1.log` | type-check, lint, check-client-responses, agent-docs, migration-naming | all exit 0 |
| **Round 2, at committed `552eac043`** (clean tree; only these logs untracked) | | |
| `green.round2.unit.log` | unit, verbose | 10/10 (2 files) |
| `green.round2.int.log` | int, verbose, 852 applied | 7/7 |
| `mutations.round2.log` | M1-M12, baselines before and after green | 12/12 RED. M11 (non-23505 rethrown before the re-read) is the unit red; M12 (no `company_id` in `feeJournalExists`) the company-scope int red |
| **Round 3 (PR #626 review), at committed `7915ecb76`** (clean tree; only these logs untracked) | | |
| `red.round3.unit.log` | new unit cases against the pre-round-3 service | 2 failed / 6 passed: thrown null raised a TypeError; a draft logged "already posted" |
| `migration.round3.fixture.log` | DROP INDEX, re-apply 852 with `statement_timeout` | built, exit 0; settings were `2min` / `5s` inside the run; the fixture has 0 journal rows, so the timing says nothing about prod |
| `green.round3.unit.log` | unit, verbose | 13/13 (2 files) |
| `green.round3.int.log` | int, verbose, 852 re-applied | 7/7 |
| `mutations.round3.log` | M1-M14, baselines before and after green | 14/14 RED. M13 (draft logs "already posted") and M14 (code read without the null check) are unit reds |
| `regression.round3.unit.log` | same 9 files | 130/130 |
| `regression.round3.int.log` | same 22 files | 210/214; the same 4 pre-existing k-035 failures |
| **Round 4 (PR #626 reconfirm), at committed `39dbe8a9c`** (clean tree; only these logs untracked) | | |
| `red.round4.unit.log` | new guard cases against the pre-round-4 service | 1 failed / 9 passed: the guard returned silently on a draft |
| `migration.round4.runner-probe.log` | `SET LOCAL statement_timeout='1s'` + sleep, via a verbatim copy of `applyOne` (diffed identical), fixture | 57014 after 1006 ms; rolled back; no `schema_migrations` row; setting did not leak |
| `green.round4.unit.log` | unit, verbose | 15/15 (2 files) |
| `green.round4.int.log` | int, verbose | 7/7 |
| `mutations.round4.log` | M1-M15, baselines before and after green | 15/15 RED. M15 (guard silent on a draft) is the unit red |
| `regression.round4.unit.log` | same 9 files | 132 passed (132) |
| **Land (master 51f501bbe merged), throwaway commit `e8e0d81e6` (tree `30e6497bf`, = `git merge-tree --write-tree origin/master 35a09b2a3`; never pushed)** | | |
| `regression.land.int.log` | same 22 files, 852 applied | 210/214; the same 4 pre-existing k-035 failures |
| `regression.land.k035-master.int.log` | k-035 on clean master `51f501bbe`, no 852 | the same 4 failures: pre-existing on master |
| **Land 2, committed merge `05335acec` of master `4ac280c63` (#625, #629, #631, #630, #632 merged)** | | |
| `regression.land2.int.log` | same 22 files, 852 applied | 210/214; the same 4 k-035 failures (R-190, now on master) |
| `regression.land2.r187.int.log` | the 2 R-187 files (`r187-*`), which drive the dedupe-path fee post that master's R-187 rewrote, 852 applied | 10/10 |
| `regression.land2.unit.log` | `tests/unit/services/ar/gateway*`, `tests/unit/services/billing/paystack*` (11 files at this tree) | 141/141 |

## Recorded, not changed

- `k-035-webhook-redelivery-discarded.int.test.ts` fails 4/6 on unchanged HEAD as well. It is the
  mandate/authorization path, not the fee path. It expects a 500 from
  `ux_sub_mandates_company_active`; the authorization branch now avoids that 23505 by design
  (`paystackEventHandlers.ts`, "never at the cost of a 23505 on ux_sub_mandates_company_active").
- **A lost race drops the loser's `fees`.** If the two deliveries report different fees, the
  winner's figure stands and the loser's is not compared or flagged (pre-existing: the sequential
  dedupe path behaves the same).
- A fee post that fails for a non-race reason (for example a closed period) still fails the whole
  delivery (500, redelivered), as before. This is unchanged by design.
