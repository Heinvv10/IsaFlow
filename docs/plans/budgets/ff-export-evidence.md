# GL export budget tables + token_info user (FibreFlow PR A, #1634): evidence

Branch `feat/budget-export-tables`. Evidence below is for code head `41c575975a` (this file is committed on top of it). No migration.

- Tables `budget_versions`, `budgets` on `/api/accounting/gl-lines-export`, schema `isaflow-budgets-1.0`, `read:reports` only, as at today, `manifest=1`. MCP `export_gl_lines` refuses both and points at `list_budget_versions` / `get_budget`.
- `token_info` returns `user: { id, email, name }`: the token holder's OWN id, email and name, never another member.

## Review round 1 (blind review of `9a958204c7`, REQUEST_CHANGES), fixed in `f87dc80844`, `112ee01980`, `41c575975a`

1. HIGH, per-head roll-up per version: a copied/seeded version carries amounts but no driver lines, so its salary cells exported at their centres. Now one company-wide set (`budgetsExportRows.rolledUpAccounts`): every account with a per_head line in ANY version, applied to EVERY version.
2. MEDIUM, derived leak: the set is closed, to a fixed point, over driver lines (any version) whose `ref` names a rolled account (pct_of_line) or whose `section` is a rolled account's band (pct_of_section, either scope). Bands from the new `gridReadAccounts.loadAccountBands` (the grid's own account read).
3. MEDIUM, token_info: an integration case with three members of A, the caller a later-added OWNER (the directory shows an owner every member): only the caller's own id/email/name come back. The description and header say "the token holder's own id, email and name (never another member)".
4. LOW, non-member: the member read runs in a savepoint; a 42501 refusal answers null email/name with `log.warn`, any other error fails the call. In reality a non-member never reaches it: the integration case shows the company read (RLS) answers the generic "Not found" first, and the bearer pipeline admits members only. The header says so.
5. LOW, a version whose label the registry cannot place (`FiscalYearLabelUnknownError`, thrown before any SQL fails, so the transaction is intact) is skipped with `log.warn` naming the version; its driver lines still count towards the set; any other failure still fails the export. Integration: a version labelled 1400 (the registry's walk from the nearest stored year gives up; the test first asserts `loadGridCells` rejects with that error).
6. `41c575975a`: `bun run ci prepush` caught `tests/unit/mcp/tools-read.test.ts` (calls every read tool against an `@/lib/neon` stub that had no `withSavepoint`); the stub now carries a pass-through.

## Tests run (real output)

| Command | Head | Result |
|---|---|---|
| `node_modules/.bin/vitest run` budgetsExport, glLinesExportAuth, exportGlLinesComputedTables, tokenInfoTool, glLinesExportStream, exportGlLinesCursor, glLineExport, transport, withBearerAuth, writeToolRoleFence | `112ee01980` | `Test Files 10 passed (10)`, `Tests 362 passed (362)` |
| `node_modules/.bin/vitest run tests/unit/mcp/tools-read.test.ts` | `41c575975a` | `Tests 35 passed (35)` |
| `vitest run --config vitest.integration.config.ts` budgets-export, mcp-token-info-user, open-items-export, on a throwaway PostgreSQL 16 cluster built as `scripts/ci/integration/run.sh` step 1 builds it (baseline + migrations as non-superuser `postgres`, then `with_db`) | `112ee01980` | `Test Files 3 passed (3)`, `Tests 14 passed (14)` (6 + 4 + 4) |
| `bun run ci prepush` | `41c575975a` | every step PASS; `unit-tests (affected)`: `Test Files 87 passed (87)`, `Tests 1802 passed (1802)`; `[ci] all checks passed` |

`41c575975a` differs from `112ee01980` only in `tests/unit/mcp/tools-read.test.ts`.

The budgets integration suite reads as `app_user` (asserts `current_user = app_user`) and through the real route with a cookie session (real `withAuth`). It asserts: rows sum to `X-Control-Total` / `summary.controlTotal` in cents; Mar-May 2026, the PRIMARY version's revenue / expense rows equal `getBudgetVariance(...).sections.revenue.budget` / `.expense.budget` to the cent; the per_head account AND its pct_of_line dependent at CC1 grain export only company-level `per_head_rollup` rows, in the primary and in the copy without driver lines; another company's per_head-free account stays at its centre; `X-Row-Count` = CSV data rows; another company's versions and cells never appear; the unplaceable version is skipped and the route still answers 200; `budget_versions` sends no `X-Control-Total`.

## Mutation table (head `112ee01980`, the code under test)

Each mutant applied to the committed code, its tests run, the file restored from HEAD (`git status` clean after the run). Counts are `failed (total)`.

| Guard | Mutant | Unit | Integration |
|---|---|---|---|
| per-head set company-wide (#1) | set built per version (the reviewed bug) | 2 failed (16) | 1 failed (6) |
| per-head roll-up | every cell exported cell for cell | 5 failed (16) | 1 failed (6) |
| per-head roll-up | per_head lines ignored | 6 failed (16) | 1 failed (6) |
| closure over `ref` (#2) | a line referencing a rolled account not added | 3 failed (16) | 1 failed (6) |
| closure over `section` (#2) | a line reading a rolled account's band not added | 1 failed (16) | n/a |
| closure fixed point (#2) | one pass only | 2 failed (16) | n/a |
| unplaceable version (#5) | not skipped (rethrown) | 1 failed (16) | 1 failed (6) |
| unplaceable version (#5) | every error swallowed | 1 failed (16) | n/a |
| read:reports scope | route exported without `withScope('read:reports')` | 2 failed (15) | n/a |
| control total | per-row `Amount * 100`, unrounded | 1 failed (16) | n/a |
| control total | float sum in rand, then ×100 | 3 failed (16) | n/a |
| control total | one row dropped from the sum | 4 failed (16) | 2 failed (6) |
| no fake total on versions | `budget_versions` sends `X-Control-Total: 0.00` | 1 failed (15) | 1 failed (6) |
| MCP refusal | `isGlMcpExportTable` accepts the budget tables | 1 failed (9) | n/a |
| MCP refusal | MCP table enum lists the budget tables | 1 failed (9) | n/a |
| as-at-today refusal | date_from / date_to / status let through on budget tables | 1 failed (15) | n/a |
| token_info `user` | field dropped | 3 failed (10) | 3 failed (4) |
| token_info `user` | member never read | 4 failed (10) | 3 failed (4) |
| token_info own user only (#3) | `getCompanyUser` loses `AND m.user_id = ${userId}` | 0 failed (10): the unit test mocks the service | 2 failed (4) |
| token_info non-member backstop (#4) | 42501 not caught | 1 failed (10) | n/a |
| token_info non-member backstop (#4) | member read outside the savepoint | 1 failed (10) | n/a |
| token_info non-member backstop (#4) | every error swallowed | 1 failed (10) | n/a |

Earlier: the per-row unrounded ×100 mutant first stayed green on the `0.1 + 0.2` test; a test with `0.07, 1.10, 2.20, 0.10, 0.20` (drifts either way; the cents sum is 3.67) was added in `3e36fc748e`.

## Limits

- `budgets` exports the cells `loadGridCells` reads: revenue / expense accounts and months of the version's own financial year. A stored cell outside those (none of the budget readers reads it) is not exported. A skipped (unplaceable) version is in `budget_versions` but not in `budgets`.
- The roll-up is conservative: a pct_of_section driver on a band holding a rolled account is rolled whatever its scope (`same_grain` or `company`).
- The integration runs were local (throwaway cluster, CI's build steps), not the GitHub `integration` step.
- The MCP budget tools' per-head restriction (#979) is untouched.
