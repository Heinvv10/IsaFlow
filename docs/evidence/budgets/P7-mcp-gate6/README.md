# P7 MCP budget tools — gate 6: full FY2027 load on the dev Demo company

Date: 2026-11-17. Code: master `230a9b8d1d` (has #1513, #1526, #1523). Database: `isaflow_dev` only.
Company: `00000000-0000-0000-0000-000000000001` "ISAFlow Demo (Pty) Ltd" (checked with `company_profile` before the first write; every write also passed it as the `company_id` guard where the tool takes one).
Actor: QA user `reporting-qa@isaflow.dev` (owner of Demo), session minted via GoTrue email OTP, PAT made through `POST /api/auth/personal-tokens`
(scopes `read:reports`, `write:budgets`, `read:payroll`, 1 day) and revoked afterwards. Every call went over HTTP to `POST http://localhost:3477/api/mcp`.

Files: `transcript.jsonl` (39 JSON-RPC calls, token redacted, `file_base64` replaced by its length), `fleet-budget-fy2027.xlsx`
(free-form fleet sheet made with LibreOffice headless from CSV), `budget-grid-fy2027.png`, `budget-vs-actual-fy2027.png`.

## Setup
- `db:migrate --dry-run`: no new migrations to apply. `999l_budget_write_snapshots` was already tracked on dev (applied 2026-11-17 01:38 UTC). The only pending entries are the known historic 524–664 gap (data repairs that fail on dev data), so the runner was not run live.
- **Demo did not have the `mcp_connector` feature on dev**, so PAT creation was refused: "The MCP connector is not switched on for this company. Choose another company, or contact IsaFlow support to have it switched on." A temporary `company_feature_overrides` row (Demo only, dev only) turned it on for the run, and that row was deleted afterwards.
- `bun run dev` hard-codes `-p 3200`, so `PORT=` is ignored. The server ran as `next dev -p 3477`.
- `budgets_three_way` is off for Demo on dev and was left off.

## The load (version `2ba3f0b9-4ab6-4e3a-941f-bd1b13cfe739`, "FY2027 Budget", original, FY2027 = Mar 2026–Feb 2027)
`tools/list` returned 210 tools. All 25 budget tools were present: add_budget_note, approve/lock/unlock/set_primary_budget_version, budget_remaining, budget_tracking, budget_variance, copy/create/delete_budget_version, derive_three_way, get_budget, get_budget_drivers, get_budget_template, get_three_way, import_budget_workbook, list_budget_versions, restore_budget_version, seed_budget, set_budget_amounts, set_budget_annual, set_budget_drivers, set_three_way_assumptions, submit_budget_for_review.

1. `list_budget_versions`: none. `create_budget_version` FY2027 original made `9c57f47a…`, which was empty.
2. `seed_budget` original then refused: "The seed would be refused: FY2027 already has an original budget". seed_budget always creates its own version, so the empty one was removed with `delete_budget_version` (dry run, then live).
3. `seed_budget` from prior_year_actuals, turnover +8%, others 0%. The first dry run gave 5 accounts / 60 cells, and **prior-year turnover is R0 on dev Demo**, so the +8% uplift yields nothing. It was re-run with `include_no_activity` (84 accounts / 1 008 cells) and applied live. seed_budget has no plan_hash parameter (dry run, then live).
4. `set_budget_drivers`: 5200 Labour Costs (the only salary-type P&L account) per_head R12 000/head/month. Payroll headcount was 10 (Mar–Sep), 114 (Oct) and 144 (Nov–Feb), giving R9 120 000. Dry run, then live with plan_hash. The first call without `idempotency_key` was refused: "idempotency_key is required for write operations".
5. Fleet: the sheet held 5400 Transport & Fuel (the only fleet/vehicle expense account; R236 400) and 5500 Equipment Costs (picked as the second account, fleet tyres/servicing; R78 000). Free-form `import_budget_workbook` with `version_token`: dry run, then live. 24 cells changed, no warnings.
6. `get_budget_template` (json) was edited to set 4100 Activation Revenue (R1 048 000) and 4200 Maintenance Revenue (R504 000), and 5600 Admin Dec-26 from 4 918 to 9 000. JSON-rows import: dry run, then live. 25 cells changed.
7. `add_budget_note` on 5400. The tool takes an account per YEAR, not an account/month.
8. `get_budget_drivers`, `get_budget` (2 pages), `budget_variance` (full, by version_id).
9. `get_three_way` / `derive_three_way` refused: "The balance sheet and cash budget is not enabled for this company" (flag off, expected).
10. `budget_remaining` before primary: budget null for every line (no primary yet, correct per the tool's description). `budget_tracking` (open): 0 alerts, never evaluated.
11. `restore_budget_version` on the step-6 snapshot `eb9f3957…`: dry run, then live, restoring 25 cells. Verified 4100/4200 back to 0 and 5600 Dec back to 4 918. The step-6 import was then redone (new snapshot `18a8e6b5…`).
12. `approve_budget_version` (owner token): approved. `set_primary_budget_version`: primary.
13. After primary: `budget_remaining` Nov-26 gave 5400 budget 21 000 / remaining 21 000, 5200 budget 1 728 000 / actual 430 057.17 / remaining 1 297 942.83, and 4100 budget 95 000 / actual 8 700. `budget_variance` without version_id read the primary with the same figures.

## Final totals (FY2027 Budget, approved, primary; 84 rows, 1 008 cells, list total 11 163 154.00)
| Section | get_budget | budget_variance |
|---|---|---|
| Turnover | 1 552 000.00 | revenue 1 569 896 (turnover + other income) |
| Other income | 17 896.00 | |
| Cost of sales | 9 120 000.00 | expense 9 593 258 (COS + opex) |
| Operating expenses | 473 258.00 | |
| Net profit | -8 023 362.00 | -8 023 362 |

They tie per section and per account: all 84 accounts match exactly (get_budget row total = budget_variance budget_amount). The sum of row totals is 11 163 154.00, which equals the version total. budget_variance excludes 1 account: 5000 Expenses, R100 of actuals with no budget.

## Screenshots
- `budget-grid-fy2027.png` (`/accounting/budgets`): Budget Management, "2027: Mar 2026 – Feb 2027", "FY2027 Budget · Original · Approved ★", Primary, "Approved, edits are audited". The rows match the load: 4100 85 000…90 000 (FY 1 048 000), 4200 42 000/month (504 000), Total Turnover 1 552 000, 5200 Labour Costs in italics with a "Σ R 12 000 × heads" driver chip (120 000 → 1 728 000; FY 9 120 000), Gross profit (7 568 000), Other income 17 896.
- `budget-vs-actual-fy2027.png` (`/accounting/reports/budget-vs-actual?period=ytd`): "FY2027 Budget · approved (primary)", YTD 1 Mar–30 Nov 2026, "1 account carry actuals with no budget (R 100.00…)". FY Budget column: Turnover 1 552 000, COS 9 120 000, Opex 473 258, Net 8 023 362 loss. All of these tie to the MCP figures.
- The viewport was set to 1680×4600 because the app scrolls inside its layout, so `fullPage` alone captured only 1 050 px.

## Surprises / findings
- The connector flag was off for dev Demo (see Setup).
- Dev Demo has no prior-year turnover, so "+8% on revenue" seeded R0. Revenue came from the JSON template edit instead.
- `include_no_activity` pulled ~70 dev fixture accounts (LCK… "Line lock fixture", Stress…, E2E…, Loop…) into the budget as zero rows. They clutter the grid and BvA. This is dev data pollution, not a tool bug.
- Grid: the header row "4000 Revenue" (FY 1 569 896) includes 4300 Other Income, which sits in the Other income section, so the header ≠ Total Turnover (1 552 000). "5000 Expenses" likewise rolls up 5200 (a cost of sales account) under Operating expenses (FY 9 522 036). The header rollup crosses sections. This is worth a look by the grid owner.
- `budget_variance` money is JSON numbers, while the new budget tools use decimal text. With `detail: "summary"` the reply omits the `version` key (it is present with `full`).
- Demo's payroll headcount is 144 from Nov-26 (dev fixture employees), so the per_head salaries are large.
