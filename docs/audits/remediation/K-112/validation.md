# K-112 — opening-balance-equity race recovery is dead code

**Claim.** The 23505 catch re-queries on an already-aborted transaction, so recovery raises 25P02.

**Corrected trigger.** Not only "two concurrent first-time posts". ANY 23505 from that INSERT —
including one raised by a concurrent chart-of-accounts import claiming 3300 — reaches the same catch.

**Disposition: confirmed.**

## Evidence
- Baseline `origin/master` = `31fc2f10`. `git diff HEAD origin/master -- <file>` is empty, so the
  checked-out copy the test exercises is byte-identical to the baseline.
- `git show origin/master:src/modules/accounting/services/gl/openingBalanceEquityService.ts`
  lines 110-133: bare `sql` INSERT, `catch` → `if (err.code === '23505') { const raced = await findExisting(...) }`.
  No savepoint anywhere in the function.
- `withAuth` opens one transaction per request (plan correction C6/K-040), and the only caller,
  `src/lib/mcp/tools/writeOpeningBalance.ts:136`, runs inside the MCP registry's savepoint
  (`src/lib/mcp/registry.ts:218`) — which unwinds only on a THROW, never on a caught error.
- Fixture schema: `uq_gl_accounts_company_code` is the unique index that raises the 23505.
- RED: `tests/integration/k112-obe-race-recovery-25p02.int.test.ts` — 1 test, 1 failed.
  Received: `25P02 current transaction is aborted, commands ignored until end of transaction block`.
  Log: `red.log`. The interleave is lock-driven, not timed: the test waits on
  `pg_stat_activity.wait_event_type='Lock'` before the winner commits.

## Reachability
Reachable from the MCP `write_opening_balance` tool whenever the company has no OBE account. The
eager seed (migrations 605/606) makes that a first-use-only window for companies created after
2026-09-04, and a permanent window for any company whose OBE account was deactivated or had its
subtype edited.

## Proposed minimal fix
`src/modules/accounting/services/gl/openingBalanceEquityService.ts`
1. Wrap the INSERT in `withSavepoint('obe_account_insert', ...)` from `@/lib/neon`.
2. Keep the 23505 catch OUTSIDE that savepoint, so the rollback has already restored the tx before
   `findExisting` runs.
3. Alternatively use `ON CONFLICT (company_id, account_code) DO NOTHING RETURNING …` and fall back to
   `findExisting` on an empty result — no error is raised, so no savepoint is needed.
Option 3 is smaller and removes the abort entirely.

## Historical-data impact
None to stored rows. The failure mode is a lost 500 on a posting that was never written; the winner's
account row is correct either way. No corrective SQL.

## Risks
`ON CONFLICT DO NOTHING` returns nothing when the existing 3300 is inactive or carries a different
subtype — `findExisting` would then also return null and the function would need to fall through to
the next preferred code rather than return undefined.
