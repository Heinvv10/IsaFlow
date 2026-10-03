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
  header. `SET LOCAL lock_timeout = '5s'`: the build takes a SHARE lock on `gl_journal_entries`.
  Not `CONCURRENTLY`, because the runner wraps each file in a transaction.
- **Code:** the guard SELECT stays as the fast path (`feeJournalExists`, same predicate as the
  index). The create and post run in `withSavepoint('gateway_fee_post')`. On ANY failure the
  journal is re-read: if it is present, another delivery posted it, so log at info and return; if
  it is absent, rethrow the original error. No error code or message is matched. The savepoint is
  load-bearing. `sql.transaction`'s own batch savepoint already contains a 23505 on the INSERT,
  but a failed POST leaves this call's own draft. Without the rollback the re-read would find that
  draft and swallow the failure (mutant M3).
- **Lock order** is unchanged. The loser's INSERT waits on the winner's uncommitted index entry,
  then raises 23505 once the winner commits, and the re-read (READ COMMITTED, new statement) sees
  the winner's row. The winner holds nothing the loser holds on the dedupe path (no request
  UPDATE; the link spend is a no-op once spent).

## Census (G2): PENDING

Not run against dev or prod (the brief reserves that for the orchestrator). Query in the header of
`852_gateway_fee_journal_unique.sql`; it must return 0 rows before 852 is applied, or 852 refuses.

## Tests

- `tests/integration/r185-gateway-fee-unique.int.test.ts` (real webhook route, fixture):
  - Race: a receipt is banked without a fee. Delivery A stops right after its fee-guard SELECT
    finds nothing (sql wrapper hook, asserted fired once). Delivery B, a different body for the
    same reference, then runs to COMMIT, and A resumes. Asserts: both 200, exactly 1 fee journal,
    Bank nets R112.00 and fee R3.00, all 3 events `processed` (the loser's transaction committed
    after the fee path).
  - Closed period: the fee post fails. Asserts: 500, no journal with the reference (not even a
    draft), event unprocessed with `processing_error`.
  - Index predicate: refuses a second live fee journal (posted/posted, draft/posted,
    NULL/posted). Admits two NULL-reference journals with the agent (receipts), another agent with
    the same reference, and a `reversed` row.
- `tests/unit/services/ar/gatewayFeeIdempotency.test.ts`: the error shape Postgres raises
  (`pg-23505.shape.log`, captured from the fixture). 23505 with the journal present stands down.
  23505 with it absent rethrows the same error object. A post failure with no journal rethrows.
  The create and post run in one savepoint.
- `tests/unit/services/ar/gatewayFeeLeg.test.ts`: neon mock gains `withSavepoint` (new import).

## Evidence

| File | What | Result |
|---|---|---|
| `red.unit.log` | unit, HEAD code | 3 failed / 1 passed (no stand-down, no re-read, no savepoint) |
| `red.int.log` | int, HEAD code, no 852 | 2 failed / 2 passed (race: 2 fee journals; index probe: no 23505) |
| `migration.fixture.log` | duplicates → RAISE (rolled back); clean → applied; re-run no-op | as stated |
| `pg-23505.shape.log` | node-postgres error for the index | code 23505, constraint `ux_gl_je_gateway_fee_reference` |
| `green.unit.log` | unit, fix | 9/9 (2 files) |
| `green.int.log` | int, fix + 852 | 4/4 |
| `mutations.log` | 8 mutants, baselines before and after green | 8/8 RED |
| `regression.unit.log` | `tests/unit/services/ar/gateway*`, `tests/unit/services/billing/paystack*` | 9 files, 126/126 |
| `regression.int.log` | r181-*, k-036, r167*, r178*, link-revoke*, k-035, k095*, k096*, r185 | 22 files, 207/211; the 4 failures are all in k-035 |
| `regression.k035-attribution.int.log` | k-035 on HEAD code, no 852 | the same 4 failures: pre-existing |
| `gates.log` | migration-naming, migration-rls, check-client-responses, agent-docs, type-check, lint | all exit 0 |

## Recorded, not changed

- `k-035-webhook-redelivery-discarded.int.test.ts` fails 4/6 on unchanged HEAD as well. It is the
  mandate/authorization path, not the fee path. It expects a 500 from
  `ux_sub_mandates_company_active`; the authorization branch now avoids that 23505 by design
  (`paystackEventHandlers.ts`, "never at the cost of a 23505 on ux_sub_mandates_company_active").
- A fee post that fails for a non-race reason (for example a closed period) still fails the whole
  delivery (500, redelivered), as before. This is unchanged by design.
