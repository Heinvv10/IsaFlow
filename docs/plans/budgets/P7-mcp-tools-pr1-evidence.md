# MCP budget tools, PR 1 of 3: evidence

Branch `feat/mcp-budget-tools-core-20261116`. Tools, migration 999f and the services they call are described in
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

Ignored, and why: ids and timestamps (new each time; the version token is a timestamp); the version name and the
create row's `entity_ref` (`FY<year> <name>`: two versions of one year cannot share a name); `entity_id` (the
version's own id). Rows of one transaction share `created_at`, so they are compared in content order. MCP-only rows,
by design outside the compared tables: `mcp_tool_calls` and `budget_write_snapshots`.

## Integration suites

`mcp-budget-tools` (19), `mcp-budget-restore` (4), `mcp-budget-versions` (4), `mcp-budget-equivalence` (1): all
green on the throwaway cluster (output in the PR report).
