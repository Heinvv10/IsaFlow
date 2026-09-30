# R-165: generalLedgerStream.integration.test.ts flakes under a concurrent dev write

**Base:** origin/master `7c49109f5`. **Branch:** `fix/r165-gl-stream-flake-20260930`. **No migration. No product code changed — test-only, per the item's own claim.**

## Reproduction

The item's claim (R-123 push, 2026-09-29): `"gives the same runningBalance at any page size"` failed once with `expected -698619.48 to be close to -698504.48, diff 115` and passed on retry, against `isaflow_dev`, which peers write to during a run.

I could not write to `isaflow_dev` (goal §2a), so I reproduced the mechanism against a disposable fixture clone (`isaflow-fixture-r165-goal`, `127.0.0.1:55485`; cloned from `isaflow-fixture-r112`'s roles + `isaflow_schema_fixture` schema, migrated to 716, then seeded with one company, 2 accounts and 760 posted lines so the "busiest company" query and pagination behave the same shape as dev).

`withBusiestCompany` (the suite's shared setup) opens ONE `pg.Pool` client, runs `BEGIN`, then every read in the suite runs on that same client via `als.run`. That is one CLIENT, but on the default READ COMMITTED isolation it is NOT one snapshot: **each statement** in an open transaction gets its own snapshot as of when THAT statement starts, not the transaction's start. A commit from another session, landing between two of our statements, is invisible to the earlier one and visible to the later one.

I proved this deterministically (no timing, no sleeps) by adding a test that:
1. Reads a 500-row page of the busiest company (`before`).
2. On a **separate** `pg.Pool` connection — autocommitting immediately, exactly like a peer session — commits one balanced posted journal entry (2 lines) for the SAME company.
3. Reads the whole period (`whole`).
4. Asserts `whole.lineCount === before.lineCount` and every already-read line's `runningBalance` is unchanged.

With `BEGIN` (master's code, no isolation clause): **RED, deterministically, 3/3 runs** —

```
AssertionError: expected 762 to be 760 // Object.is equality
 ❯ …generalLedgerStream.integration.test.ts:171
   expect(whole.lineCount).toBe(before.lineCount);
```

762 = 760 seeded + 2 lines from the concurrent commit, visible to the `whole` read but not to `before` — the same shape as the reported diff (a later read disagreeing with an earlier one because of a write that landed in between).

## Root cause

`withBusiestCompany` in `tests/unit/mcp/w2/generalLedgerStream.integration.test.ts` ran `client.query('BEGIN')` with no isolation level, i.e. READ COMMITTED. The suite treats the transaction as if it pins one snapshot for every read inside it (`drain()`'s per-page calls, then the unpaged "whole" call) — but READ COMMITTED never promised that. It is a **test defect**, not a product one: the service itself (`getGeneralLedgerLines`) computes the running balance correctly from whatever snapshot each of its statements sees; the flake is in the test's assumption about what "one transaction" guarantees.

## Fix

`withBusiestCompany` now opens `BEGIN ISOLATION LEVEL REPEATABLE READ` instead of plain `BEGIN`. REPEATABLE READ fixes the transaction's snapshot at its FIRST statement (the "busiest company" query), so every later statement in the same transaction — any page, the unpaged read, `readTotalsOnly`'s recursive call — sees that exact same snapshot regardless of what any peer commits in the meantime. This removes the race outright rather than narrowing it: it is not a property of the two statements the flake happened to hit, but of the whole transaction, so it covers every read/read ordering the suite (or a future test added to it) could exercise. The transaction is read-only and ROLLBACKs at the end, so REPEATABLE READ never risks a serialization failure here (those only arise from write-write conflicts).

## Tests

`tests/unit/mcp/w2/generalLedgerStream.integration.test.ts`, new case: `"is not disturbed by a peer session committing a posted line mid-read (R-165 regression)"`. Concurrent-write helpers (`commitConcurrentPostedLine`, `deleteConcurrentPostedLine`) moved to a sibling `generalLedgerStream.concurrentWrite.helpers.ts` to keep the main file's existing helpers uncluttered.

All 10 tests in the file pass against the fixture with the fix in place (`ci.log`).

## Mutation check

| # | Guard removed | How | Test that goes RED | Assertion |
|---|---|---|---|---|
| M1 | `BEGIN ISOLATION LEVEL REPEATABLE READ` → plain `BEGIN` | Restored the file from a saved copy (not `git checkout`) after `sed`-reverting the one line, ran the suite, then restored the fix from the saved copy | `is not disturbed by a peer session committing a posted line mid-read (R-165 regression)`, 3/3 runs | `expected 762 to be 760` at `expect(whole.lineCount).toBe(before.lineCount)` |

Re-ran M1 (revert → 3/3 RED on the same assertion → restore → 10/10 GREEN) AFTER adding the `canWriteHere` guard, to confirm the guard doesn't mask the regression test's own effectiveness against the fixture. Same result as before.

No other guard exists in this change beyond `canWriteHere`/`assertDisposableTarget` (write-safety, not the fix itself) — the fix is the isolation level, and the regression test is what exercises it.

## Browser proof

Not applicable. This item is `area: tests`, `severity: low`, test-only per the brief; no page or API is involved.

## Dev writes, and an incident during CI

No migration. All INTENTIONAL reproduction and verification ran against the disposable fixture `isaflow-fixture-r165-goal` (removed after this work).

**Incident:** the first `bun run ci` run on this branch (`env -u DATABASE_URL bun run ci`, gated) executed the new regression test against **real `isaflow_dev`**, and it committed one balanced posted journal entry (2 lines, `description = 'R-165 regression: concurrent write mid-read'`) into whichever company was `isaflow_dev`'s busiest at the time, then deleted it again in the test's own `finally` block when the assertion failed. Root cause: `env -u DATABASE_URL` does **not** actually unset `DATABASE_URL` for this suite — `vitest.config.ts` calls `loadEnv(mode, cwd, '')`, which re-reads `.env.local` and repopulates `env.DATABASE_URL` regardless of the parent shell's unset (a known gotcha, `feedback_env_local_bash_source`-adjacent; every OTHER test in this file already runs against real `isaflow_dev` in CI by design — the file's own header says "against isaflow_dev... Read-only" — but this was the first WRITE in the suite, which is what turned that gotcha into a real hazard).

The test's own `finally { await deleteConcurrentPostedLine(); }` deleted the entry and its lines before I even looked — confirmed clean with a direct read-only query against `isaflow_dev` immediately after (`SELECT count(*) FROM gl_journal_entries WHERE description ILIKE '%R-165%'` → 0; no orphaned `gl_journal_lines` with a missing parent entry). No other row was touched; nothing was left behind.

**Response:** added `canWriteHere` (checked via `new URL(DATABASE_URL).pathname`) so the regression test `it.skipIf`s itself whenever the resolved database is `isaflow_dev`, `isaflow`, or unresolved — it only runs against an explicitly different (disposable) target. Also hardened `commitConcurrentPostedLine` itself with the same check (`assertDisposableTarget`), so a future caller reusing the helper outside this one guarded test can't repeat the incident. Reverified both directions: `env -u DATABASE_URL bunx vitest run …` (i.e. real isaflow_dev) now shows `9 passed | 1 skipped`, with the skip verified to be the R-165 regression test by name; the fixture run still shows `10 passed`.

## Census / prod check

Not applicable. Nothing in `src/` or `pages/` changed; this fixes a test's isolation level only. There is no production query to run — the fix does not touch application code, migrations, or data.
