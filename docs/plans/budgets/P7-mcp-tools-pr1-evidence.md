# MCP budget tools, PR 1 of 3: evidence

Branch `feat/mcp-budget-tools-core-20261116`. Tools, migration 999l and the services they call are described in
`src/lib/mcp/.claude.md` and `src/modules/accounting/services/budgets/.claude.md`.

## Mutation table

Each guard was mutated in the production code (committed first; restored with `git apply -R` of the mutation's own
diff, tree verified clean after each), then the tests named ran: unit = `vitest run <file>`, int = the integration
files against a throwaway PostgreSQL 16 cluster built as `scripts/ci/integration/run.sh` builds its template
(baseline + this branch's migrations as non-superuser `postgres`), suites run as `app_user` through the real
registry. Counts are from the runs' own `Tests` lines (2026-11-16, box load 120-140).

| # | Guard | Mutant | Tests run | Result |
|---|---|---|---|---|
| M1 | role fence / write flag | `set_budget_amounts` declared `write: false` | unit writeToolRoleFence + budgetVersionTools; int mcp-budget-tools | unit 4 failed / 251; int 2 failed / 19 (viewer fenced; replay) |
| M2 | owner gate (ruling 2) | `ownerGate` admits owner **and admin** | unit budgetVersionTools; int mcp-budget-tools | unit 4 failed / 20; int 4 failed / 19 (one per gated tool) |
| M3 | stale token | live call uses the CURRENT token instead of `version_token` (pre-check and CAS both bypassed) | unit budgetAmountTools; int mcp-budget-tools | unit 1 failed / 26; int 1 failed / 19 |
| M4 | dry-run parity (same guards as live) | dry run skips the rolled-back `saveCells` | unit budgetAmountTools; int mcp-budget-tools | unit 4 failed / 26; int 1 failed / 19 (decision 4) |
| M4b | decision 4 (one grain per account) | `gridSave.assertOneGrain` refuses nothing | int mcp-budget-tools | first run **0 failed / 19**: the exclusion constraint (`budget_month_amounts_one_grain`, mapped by `mapBudgetDbError`) refused instead. Assertion pinned to the app check's message (commit 631f832b1e); re-run **1 failed / 19** |
| M5 | decision 14 (one dimension per cell) | per-row check allows two dimensions | unit budgetAmountTools; int mcp-budget-tools | unit 1 failed / 26; int 1 failed / 19 |
| M6 | holder slices (token user is the save's actor) | `saveCells` called with the version's creator (an owner) as actor | int mcp-budget-restore | first run **0 failed / 4**: migration 955's trigger (session user = the holder) refused instead. Assertion pinned to the app check's message (631f832b1e); re-run **1 failed / 4** |
| M7 | figures need read:reports | `figuresAllowed` always true | unit budgetAmountTools + budgetVersionTools; int mcp-budget-tools | unit 2 failed / 46; int 1 failed / 19 |
| M8 | restore only while the token is unchanged | `planRestore` skips the token comparison | int mcp-budget-restore | 1 failed / 4 |
| M9 | snapshot written with the write | live write records no snapshot | unit budgetAmountTools; int mcp-budget-restore | unit 1 failed / 26; int 3 failed / 4 |

### Review round 1 (blind review of 439ee1ad4f): new guards

Same procedure (cluster rebuilt for N9, a migration mutant). Counts from the runs' `Tests` lines.

| # | Guard | Mutant | Tests run | Result |
|---|---|---|---|---|
| N1 | budget writes need read:reports | `BUDGET_WRITE_FENCE` without `requiresScope` | unit budgetToolsRegistry; int mcp-budget-tools | unit 13 failed / 16 (one per write tool); int 1 failed / 21 |
| N2 | plan_hash binds the live call to its dry run | the hash comparison removed | unit budgetAmountTools; int mcp-budget-tools + mcp-budget-batch | unit 2 failed / 30; int 3 failed / 24 (stale dry run, other mode, in-batch write) |
| N3 | restore compares content, not only the token | `differing.length > 0` dropped | unit budgetSnapshotRestore; int mcp-budget-restore | unit 2 failed / 6; int first run **0 failed / 5** (every edit in the suite moved the token). Added "a writer that leaves the token" test (376fbaa435); re-run **1 failed / 6** |
| N4 | restore actor (author, owner or admin) | actor check removed | unit budgetSnapshotRestore; int mcp-budget-restore | unit 1 failed / 6; int 1 failed / 5 |
| N5 | same-transaction chain (latest snapshot must be unrestored) | `latest.restored` check removed | unit budgetSnapshotRestore; int mcp-budget-batch + restore | unit 1 failed / 6; int 3 failed / 8 |
| N6 | flat seasonality fills every month | flat spreads over the source's months only | unit budgetMcpPure; int mcp-budget-versions | unit 1 failed / 25; int 1 failed / 6 |
| N7 | rounding notice (last month past zero) | notice never raised | unit budgetAmountTools | 1 failed / 30 |
| N8 | get_budget page fits 90 KB | `GET_BUDGET_LIMIT_MAX` 80 → 150 | unit readLimitsSizeBudgets | 2 failed / 7 |
| N9 | restored_at only with the restore's own save (migration 999l trigger) | the `updated_at = now()` check disabled | int mcp-budget-restore (fresh cluster) | 1 failed / 6 |
| N11 | exactly 20 000 cells pass | the argument check refuses 20 000 (`>=`) | unit budgetAmountTools | 1 failed / 30 |
| N12 | the planned save is capped at 20 000 (replace's clears included) | the `plan.save` cap removed | unit budgetAmountTools | 1 failed / 30 |
| N10 | the diff is what the save actually left | dry run uses the before-state as "after" | unit budgetAmountTools; int mcp-budget-batch | unit 4 failed / 30; int 1 failed / 3 (driver reset / recomputed dependent) |

### Review round 2 (fix review + breaker on 56c3479782)

Red first: before the fix the new tests failed (unit 8 failed / 65; int 3 failed / 11, B1 answering the generic
failure); after it, unit 113/113 and int 42/42 (all six mcp-budget suites).

| # | Guard | Mutant | Tests run | Result |
|---|---|---|---|---|
| R1 | B1: an override reset to an equal driver value is refused (not half-restored) | the `unpinnable` refusal disabled | unit budgetSnapshotRestore; int mcp-budget-batch | unit 1 failed / 9; int 1 failed / 5 |
| R1b | B1: the post-check requires a former override to be one again | the `bs === 'override'` clause removed | unit budgetSnapshotRestore | 1 failed / 9 |
| R2 | B2: a status move after the write refuses the restore (same token, one batch) | the `statusMovedAt` check disabled | unit budgetSnapshotRestore; int mcp-budget-batch | unit 1 failed / 9; int 1 failed / 5 |
| R3 | B3: a snapshot is inserted only with a save of its version in the same transaction (999l insert trigger) | the trigger's check disabled | int mcp-budget-restore (fresh cluster) | 1 failed / 6 |
| R5 | round 3: a former override comes back 'override' only where a driver still covers it | `covered(c)` dropped from the post-check (any former override must be 'override') | unit budgetSnapshotRestore; int mcp-budget-batch | unit 1 failed / 10; int 1 failed / 6 |
| R4 | L1: a multi-cell write that changes nothing says so (before asking for plan_hash) | the nothing-changed answer removed (the hash check answers instead) | unit budgetAmountTools | 1 failed / 31 |

B2 is enforced with the version's clock-time status stamps (approved_at, locked_at, unlocked_at), not a stored status:
no schema change, and an unlock back to the same status after the write is caught too. B3 narrows, not closes: ANY update of
the version row in the same transaction satisfies the insert check, a no-op `UPDATE budget_versions SET name = name`
included (the updated_at trigger sets now()). So raw-SQL app_user can still insert a row after such an update; its
`created_by` is then that user (the database's stamp), and a restore of it writes only as its author, an owner or an
admin, audited as them. Accepted LOW: it needs raw app_user SQL, which can already write `budget_month_amounts`
directly; requiring an amount row changed in this transaction would not be sounder (a save that only clears cells
leaves none).

### Accepted limits

- `plan_hash` binds the PLANNED cells (value and source before, value after), not the dependents a driver recomputes
  after them: a per_head row's headcount can move between the dry run and the live call, so the live call's
  recomputed cells can differ from the dry run's listing. The live reply lists what the save actually left, and
  restore's content check covers the undo.
- Snapshots are never pruned (growth documented in `services/budgets/.claude.md`).

M4b and M6 show two layers: the app check (with a message naming the account and month) and a database backstop.
Both stay; the tests now pin the app layer, and the backstops keep their own suites (`budgets-grain-exclusion`,
`budgets-p5-holders-db`).

## Equivalence (`tests/integration/mcp-budget-equivalence.int.test.ts`)

One budget built twice by the same owner from the same source version: the app's `POST budget-grid/seed`
(version source, +10%) then `POST budget-grid/save` (set, clear, a zero), against `seed_budget` then
`set_budget_amounts` (dry run + apply). Asserted equal: every `budget_month_amounts` row (account, dimensions,
month, amount, amount_source, created_by), the version's state (company, year, kind, status, based_on, primary,
created_by, approval and lock stamps), and every `audit_log` row of the version (action, entity type, user, email,
changes with all metadata, ip, user agent, session).

Test (2) builds an annual amount through the save route (the grid's even spread, 83.00 x 11 + 87.00) and then
approves and locks through `POST budget-versions/[id]/status`, against `set_budget_annual` +
`approve_budget_version` + `lock_budget_version`: same rows, same state (locked, approved_by / locked_by), same audit
rows. `ip_address`, `user_agent` and `session_id` are NULL on BOTH paths (no budget service passes them to
`logAuditOrThrow`), so their equality is trivial; the test asserts they are null rather than claiming a comparison.

Ignored, and why: ids and timestamps (new each time; the version token is a timestamp); the version name, the
create and status rows' `entity_ref` (`FY<year> <name>`) and the status rows' `versionName` metadata (two versions
of one year cannot share a name); `entity_id` (the
version's own id). Rows of one transaction share `created_at`, so they are compared in content order. MCP-only rows,
by design outside the compared tables: `mcp_tool_calls` and `budget_write_snapshots`.

## TDD note (review round 1)

The round-1 tests were written in the same pass as the fixes rather than strictly red first; the N-table above is
the evidence that each new test fails on its guard's removal.

## Integration suites

`mcp-budget-tools` (21), `mcp-budget-restore` (6), `mcp-budget-versions` (6), `mcp-budget-batch` (3),
`mcp-budget-holders` (2), `mcp-budget-equivalence` (2), and the 24 `budget-grid-*` suites (213 passed, 1 skipped):
green on the throwaway cluster (output in the PR report).
