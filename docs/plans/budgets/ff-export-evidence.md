# GL export budget tables (FibreFlow PR A): evidence

Branch `feat/budget-export-tables`. Code and tests at `3e36fc748e` (this file is committed on top). No migration.

Tables: `budget_versions`, `budgets` on `/api/accounting/gl-lines-export`, schema `isaflow-budgets-1.0`, `read:reports` only, as at today, `manifest=1`. MCP `export_gl_lines` refuses both and points at `list_budget_versions` / `get_budget`.

## Tests run (real output)

| Command | Result |
|---|---|
| `node_modules/.bin/vitest run tests/unit/services/reports/budgetsExport.test.ts tests/unit/api/glLinesExportAuth.test.ts tests/unit/mcp/exportGlLinesComputedTables.test.ts tests/unit/api/glLinesExportStream.test.ts tests/unit/mcp/exportGlLinesCursor.test.ts tests/unit/services/reports/glLineExport.test.ts` | `Test Files 6 passed (6)`, `Tests 65 passed (65)` |
| `vitest run --config vitest.integration.config.ts tests/integration/budgets-export.int.test.ts tests/integration/open-items-export.int.test.ts` on a throwaway PostgreSQL 16 cluster built as `scripts/ci/integration/run.sh` step 1 builds it (baseline + migrations as non-superuser `postgres`, then `with_db`) | `Test Files 2 passed (2)`, `Tests 9 passed (9)` |
| `bun run ci prepush` | every step PASS; `unit-tests (affected)`: `Test Files 45 passed (45)`, `Tests 1019 passed (1019)`; `[ci] all checks passed (group: prepush, part 1/1)` |

The integration suite reads as `app_user` (SET LOCAL ROLE app_user, the member's claims, the company GUC; it asserts `current_user = app_user`) and through the real route with a cookie session (real `withAuth`). It asserts: rows sum to `X-Control-Total` / `summary.controlTotal` in cents; for Mar-May 2026 the PRIMARY version's revenue rows and expense rows equal `getBudgetVariance(...).sections.revenue.budget` / `.expense.budget` to the cent; the per_head account exports only company-level `per_head_rollup` rows (none at a dimension) in the version with the line, and cell for cell in the version without one; `X-Row-Count` = CSV data rows; another company's versions and cells never appear; `budget_versions` sends no `X-Control-Total`.

## token_info `user` (commit 8eb6838171)

`token_info` also returns `user: { id, email, name }` for the token's user (ctx.userId), read through `practiceUsersService.getCompanyUser` (`company_member_directory`: this company's active member only); email / name null when not readable, name null with no first or last name. Tests: `tests/unit/mcp/tokenInfoTool.test.ts` (7 passed) and `tests/integration/mcp-token-info-user.int.test.ts` (2 passed; real MCP registry, app_user, the bearer pipeline's claims). `vitest run` of tokenInfoTool, transport, withBearerAuth and writeToolRoleFence: 4 files, 288 passed. `token_info` is not described in `src/lib/mcp/.claude.md` (only in its change archive), so no contract doc changed.

## Mutation table

Each mutant applied to the committed code, its tests run, the file restored from HEAD (`git status` clean after the run).

| Guard | Mutant | Unit | Integration |
|---|---|---|---|
| (a) per-head roll-up | `budgetsExport.ts`: per_head filter matches nothing | 1 failed (10) | 1 failed (5) |
| (a) per-head roll-up | `budgetsExportRows.ts`: every cell exported cell for cell | 3 failed (10) | 1 failed (5) |
| (b) read:reports scope | route exported without `withScope('read:reports')` | 2 failed (15) | n/a |
| (c) control total | per-row `Amount * 100`, unrounded | 1 failed (10) | n/a |
| (c) control total | float sum in rand, then ×100 | 3 failed (10) | n/a |
| (c) control total | one row dropped from the sum | 4 failed (10) | 1 failed (5) |
| (c) no fake total on versions | `budget_versions` sends `X-Control-Total: 0.00` | 1 failed (15) | 1 failed (5) |
| (d) MCP refusal | `isGlMcpExportTable` accepts the budget tables | 1 failed (9) | n/a |
| (d) MCP refusal | MCP table enum lists the budget tables | 1 failed (9) | n/a |
| as-at-today refusal | route lets date_from / date_to / status through on budget tables | 1 failed (15) | n/a |
| token_info `user` (8eb6838171) | `user` field dropped from the reply | 2 failed (7) | 2 failed (2) |
| token_info `user` (8eb6838171) | member never read (email / name always null) | 2 failed (7) | 2 failed (2) |

One mutant first stayed green: the per-row unrounded ×100 sum passed the `0.1 + 0.2` test (both are exact ×100). A test with `0.07, 1.10, 2.20, 0.10, 0.20` (drifts either way; the cents sum is 3.67) was added in `3e36fc748e`, and both float mutants now fail.

## Limits

- `budgets` exports the cells `loadGridCells` reads: revenue / expense accounts and months of the version's own financial year. A stored cell outside those (none of the budget readers reads it) is not exported.
- The integration run above was local (throwaway cluster, same build steps as CI's), not the GitHub `integration` step.
- The MCP budget tools' per-head restriction (#979) is untouched: no MCP tool file other than `export_gl_lines` changed.
