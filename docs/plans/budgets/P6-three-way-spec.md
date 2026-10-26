# P6 — Balance-sheet & cash budgets (three-way) + scenarios — spec

**Date:** 2026-10-26 · **Status:** Draft, not started · **Parent:** `docs/plans/2026-10-26-budgets-next-level.md` §5 P6
**Contract:** `docs/plans/budgets/00-shared-contract.md` (obeyed exactly; canonical names from P1).
**Precondition:** P1–P4 merged on `origin/master` (checks: contract "Preconditions"). Decision 10 answered at the phase-start gate (§1).
**Refresh before building:** re-read this spec against what the MVP (P0–P3) taught us on Demo. Anything
the MVP feedback contradicts wins over this document; record the change in §13.

**Strongest argument against:** Fathom/Spotlight already do 3-way well, and a wrong cash forecast is
worse than none: one mis-timed VAT payment makes the runway chart lie. Mitigation: pure engine with
hand-computed fixtures and exact-cent invariants, and nothing client-visible until Hein signs off on Demo.

---

## 1. Decision 10 (phase-start gate — pre-filled default, Hein answers yes/override)

| # | Default (build this unless Hein overrides) |
|---|---|
| 10 | Cash timing from **actual** debtor/creditor/inventory days, derived at the opening date and editable per version. VAT and PAYE paid on **SARS due dates**. Figures **not client-visible** until Hein reviews on ISAFlow Demo (feature flag `budgets_three_way`, off for every company except Demo). |
| 10a | Opening balance sheet = actual BS (`getBalanceSheet`) as at the day before the version's first month. If that day is in the future, use the latest actual date ≤ today and show a "provisional opening (as at …)" banner. |
| 10b | Provisional tax (companies only, `entity_type` company/pty/cc): IRP6 #1 = 50 % of the version's FY budgeted tax expense in month 6 of the financial year; #2 = balance of FY tax in month 12; opening tax payable (prior year) settled in the top-up month (6 months after a February year end, else 7). Non-companies: off. |
| 10c | The P&L budget is the only authority for P&L figures. Depreciation, interest and tax come from the budgeted P&L lines; asset register / loan schedules are **checks** (warning when they differ by > 5 %), never overrides. |
| 10d | Negative cash is shown, never auto-funded by an overdraft plug. |

**Verify before coding (LOW→MEDIUM confidence facts):** SARS VAT category ↔ alignment (repo helpers
disagree — see §11 R2) and the IRP6 top-up month. At monthly grain both the 25th and "last business day"
VAT due dates and the EMP201 7th fall in month m+1, so business-day rules do not change the engine.

## 2. What exists (verified on origin/master) — reuse, do not rebuild

| Need | Existing code |
|---|---|
| Actual BS (opening) | `src/modules/accounting/services/reports/balanceSheetService.ts` (`getBalanceSheet`, `calculateRetainedEarnings`; lines carry `accountCode` only, signed by `gl/balanceByAccountType.ts`) |
| Account roles | `gl/accountSubtypes.ts` (`canonicalSubtype`, `isCashEquivalent`), `gl/accountSubtypeVocabulary.ts` (`CanonicalSubtype`), `gl/accountClassification.ts` (`expenseBand`, `revenueBand`) |
| Cash groups | `afs/cashFlowClassification.ts` (`CashGroup`, `classifyCashGroup`) — reuse the type for the direct CF |
| Cash balance | `bank/cashBalanceService.ts` (`getCashBalance`) — opening-cash parity check |
| Cash-flow statement (actual) | `pages/api/accounting/reports-cash-flow.ts`, `pages/accounting/reports/cash-flow.tsx` (layout reference) |
| Short-term AI forecast | `reports/cashFlowForecastService.ts` + `pages/accounting/reports/cash-flow-forecast.tsx` — different product (AR/AP due dates, weeks). P6 does **not** touch or merge it. |
| Debtor/creditor/inventory days | `reports/ratioCalculations.ts` (`debtorDays`, `creditorDays`, `windowDays`) — definition reference; P6 derives on the **VAT-inclusive** basis it projects on (§4.2) |
| Aged AR/AP | `ar/arAgingService.ts` (`getARAging`), `ap/apAgingService.ts` (`getAPAging`) — shown beside derived days as evidence |
| VAT cadence/basis | `src/modules/bureau/services/vatPeriodHelper.ts` (`normalizeVatSetting`, `normalizeVatAlignment`, `normalizeVatBasis`, `isVatRegistered`, `expectedVatPeriodAsOf`), `core/companyMapper.ts` (`vatPeriod`, `vatPeriodAlignment`, `vatSystemType`); rate `reports/vatBoxBasis.ts` `SA_VAT_RATE` |
| SARS calendar (reference only) | `reports/sarsTaxPeriodsService.ts` — hard-codes Feb year end for IRP6; do not reuse for companies |
| EMP201 | `reports/emp201Service.ts` (`generateEMP201`: `payePayable`, `totalUIF`, `totalSDL`, `totalTaxableRemuneration`) — derives the statutory share |
| Fixed assets | `items/depreciationSchedule.ts` (`buildDepreciationSchedule`, annual), `items/assetRegisterService.ts` |
| Loans | `loans/loanScheduleService.ts` — use **`previewSchedule`** (no `FOR SHARE`, persists nothing). Never `getOrComputeSchedule` from a read path. Engine `src/lib/amortisation/engine.ts` (`amortise`) for planned new loans. Schedule `Date`s: local getters (see `loans/.claude.md`). |
| Fiscal year months | `gl/fiscalYearRegistry.ts` (`requireFiscalYear`, `monthsSpanned`) — 12 or 14-month transition years |
| Money | `src/lib/money/decimalSum.ts` (`toMoney`), `src/lib/format/money.ts` (`formatStatementFigure`, `formatPct`) |
| Feature flag | `src/modules/admin/services/featureFlagService.ts` (`hasFeature`), `src/modules/admin/middleware/withFeature.ts`, `src/components/admin/FeatureGate.tsx`, `pages/api/features/check.ts` |
| UI | `src/components/accounting/statement/StatementGrid.tsx`, `src/components/accounting/charts/CashPositionChart.tsx` + `cashPositionOption.ts`, `charts/ibcs.ts` (`varianceColor`), `charts/escapeHtml.ts`, `src/components/charts/EChart.tsx` |
| Nav | `src/components/accounting/navSections/accounting.ts`, `navSections/accountants.ts`, `accountingNavConfig.ts` |
| P1–P4 outputs | P1: `budget_versions`, `budget_month_amounts.version_id`, service home `src/modules/accounting/services/budgets/`, lock trigger `public.budget_month_amounts_refuse_locked()`, `budgetVersionScope.ts` (`lockVersionForWrite`, `primaryVersionScope`), `budgetVersionTypes.ts` (`mapBudgetDbError`), routes `pages/api/accounting/budget-versions/**`. P2: version copy +x% (wizard `POST /api/accounting/budget-grid/seed`), `VersionsBar.tsx`. P3: one actuals SQL `budgets/tracking/trackingActualRead.ts`, engine `budgets/tracking/budgetTrackingService.ts` (NP for I5). P4: `budgets/drivers/driverEngine.ts` (amounts after drivers). Confirm against master. |

## 3. Scope

**In:** company-level budgeted BS and CF per month for one version; assumptions per version; scenario
versions (`kind = 'scenario'`) whose assumptions are sparse overrides of their `based_on_version_id`;
compare up to 3 versions; cash runway chart; derive-assumptions-from-actuals; feature-flagged.

**Out (explicit):** group consolidation and intercompany; multi-currency (ZAR only — foreign balances
carried at opening ZAR, flat); BS budgeting per GL account (bucket grain only) and per CC1/CC2/BU
(company only — dimension filters disabled with a reason); asset disposals; IFRS 16 leases; deferred tax;
interest earned on cash; overdraft auto-funding; weekly/13-week cash; VAT categories D/E (6-monthly,
annual) — refused with a typed reason; customer deposits, bad-debt provisions; writing budget figures
into the GL (never); MCP tool (later); email of figures.

## 4. Assumptions model

Stored per version as one validated document (zod, `schemaVersion: 1`). Every value carries provenance.

```ts
type Prov<T> = { value: T; source: 'derived' | 'manual'; derivedAsAt?: string; basis?: string };
interface ThreeWayAssumptions {
  schemaVersion: 1;
  workingCapital: {
    debtorDays: Prov<number>;      // 0..365, VAT-inclusive sales basis
    creditorDays: Prov<number>;    // 0..365, VAT-inclusive purchases basis
    inventoryDays: Prov<number>;   // 0..730, on cost of sales; 0 when no inventory subtype held
  };
  vat: {
    registered: Prov<boolean>; cadence: Prov<'monthly'|'bi-monthly'>; alignment: Prov<'odd'|'even'>;
    basis: Prov<'invoice'|'payment'>;          // from companies.vat_system_type
    vatableSalesShare: Prov<number>;           // 0..1
    vatablePurchasesShare: Prov<number>;       // 0..1
    refundLagMonths: Prov<0|1|2>;              // default 1
  };
  payroll: { statutoryShare: Prov<number> };   // (PAYE+UIF ee+er+SDL)/payroll expense, paid m+1
  incomeTax: { mode: Prov<'provisional'|'off'>; topUpMonthOffset: Prov<6|7> };
  capex: Array<{ id: string; month: string; amountExVat: number; vatClaimable: boolean;
                 description: string; usefulLifeYears?: number }>;      // paid in its month
  loans: {
    existing: Array<{ loanId: string; include: boolean }>;              // schedules via previewSchedule
    planned: Array<{ id: string; description: string; drawdownMonth: string; principal: number;
                     annualRatePct: number; termMonths: number; firstRepaymentMonth: string }>;
  };
  equity: {
    shareIssues: Array<{ id: string; month: string; amount: number }>;
    dividends: Array<{ id: string; declaredMonth: string; paidMonth: string; amount: number }>;
  };
  minimumCash: Prov<number>;                   // runway threshold, default 0
}
// Scenario: { overrides: DeepPartial<ThreeWayAssumptions> } merged over the base version's resolved doc.
// Arrays (capex, loans.planned, shareIssues, dividends) REPLACE, never element-merge. Chain depth ≤ 5, cycles refused.
```

**Derived defaults (decision 10)** — `deriveAssumptions(companyId, versionId)` computes, never writes:
- debtorDays = AR(open) ÷ trailing-12m VAT-inclusive turnover × trailing days; creditorDays the same
  on AP vs VAT-inclusive (purchases + supplier opex); inventoryDays = inventory ÷ trailing COGS × days.
  Fewer than 3 months of history → default 30/30/0, `basis: 'insufficient history'`.
- vatableSalesShare = trailing output VAT ÷ (turnover × rate), clamped 0..1; purchases likewise.
- statutoryShare = Σ last 3 EMP201 (payePayable + totalUIF + totalSDL) ÷ payroll expense same months; no payroll → 0.
- VAT cadence/alignment/basis from the company row via `vatPeriodHelper` normalisers.

## 5. Engine (pure TS, integer cents, double entry)

`runThreeWay(input: EngineInput): EngineOutput` — no DB, no `Date.now()`, deterministic.

**Input:** `months[]` (`YYYY-MM-01`, from the fiscal-year registry), `daysInMonth[]`, `pnl[month]` by
band (`turnover`, `otherIncome`, `costOfSales`, `payroll`, `depreciation`, `financeCost`, `taxExpense`,
`otherOpex`) from the version's amounts (after P4 drivers resolved), `lookback[]` (≥ 12 pre-start
actual months of turnover/COGS/purchases, for the days method), `opening` buckets, resolved
assumptions, `loanSchedules` (principal/interest per month per included loan), FY month index of each month.

**Buckets** (debit-positive cents; mapped from canonical subtype; unmapped → `otherAssets`/`otherLiabilities`/`otherEquity`, carried flat):
`cash`(bank,cash) · `receivables` · `inventory` · `vatControl`(vat_input + vat_output, net) · `fixedAssets` ·
`accumDepreciation` · `otherAssets` · `payables` · `payrollLiabilities` · `incomeTaxPayable` (account chosen in
assumptions; default none → synthetic line) · `dividendsPayable` · `loans`(long_term_liability, non_current_liability,
plus `loans.gl_account_id`/`current_portion_account_id`) · `otherLiabilities` · `shareCapital`/`otherEquity` · `retainedEarnings`.

**Days method** (`closingFromDays(days, flows, daysInMonth, m)`): closing = Σ_k flow_{m−k} × clamp((days − Σ_{j<k} d_{m−j}) / d_{m−k}, 0, 1),
walking back into `lookback` before the first month. Rounded to cents half-up.

**Per month m, emit balanced postings in this order** (each posting asserts Σdr = Σcr; out = credit):
1. **Sales:** DR receivables (turnover × (1 + s_out·rate)); CR revenue (RE) turnover; CR vatControl output VAT (invoice basis).
   Other income: DR cash, CR RE (no VAT).
2. **Receipts:** close_AR = closingFromDays(D, VAT-incl turnover); receipts = open_AR + sales_incl − close_AR;
   DR cash, CR receivables. Payment-basis VAT: output VAT accrues on receipts (receipts × s_out·rate/(1+rate)) instead of in 1.
3. **Inventory/purchases:** close_Inv = closingFromDays(I, COGS); stockPurchases = COGS + close_Inv − open_Inv;
   DR inventory stockPurchases, CR inventory COGS (DR RE); supplier purchases = stockPurchases + otherOpex.
4. **Creditors:** DR inventory/RE (ex VAT), DR vatControl input VAT (s_in·rate), CR payables (incl); close_AP =
   closingFromDays(C, VAT-incl supplier purchases); payments = open_AP + purchases_incl − close_AP; DR payables, CR cash.
5. **Payroll:** DR RE payroll; CR cash (1 − p)·payroll; CR payrollLiabilities p·payroll. Remit opening/prior-month
   liability in m (EMP201 7th of m+1 → the month after accrual): DR payrollLiabilities, CR cash.
6. **Depreciation:** DR RE, CR accumDepreciation (non-cash).
7. **Finance cost:** DR RE, CR cash (paid in month). Loans: drawdown DR cash CR loans; principal DR loans CR cash.
8. **Capex:** DR fixedAssets ex VAT, DR vatControl (if claimable), CR cash.
9. **Income tax:** DR RE taxExpense, CR incomeTaxPayable; provisional payments per 10b: DR incomeTaxPayable, CR cash.
10. **Equity:** share issue DR cash CR shareCapital; dividend declared DR RE CR dividendsPayable; paid DR dividendsPayable CR cash.
11. **VAT settlement:** if m is the last month of a VAT period, the period's net accrual is due; paid in m+1
    (refund received m + refundLagMonths). Opening vatControl belongs to the period containing the month before
    start and settles at that period's due month. Period membership via one `vatPeriodOf(month, cadence, alignment)`
    whose semantics match `vatPeriodHelper` (pinned by test, §8).

**Output:** per month: closing buckets, BS sections (current/non-current assets, liabilities, equity), `check`
= assets − liabilities − equity (must be 0 cents), direct CF by `CashGroup` (customers, suppliers, employees
incl. EMP201, other_operating = VAT + income tax + interest, investing = capex, financing = loans/equity/dividends),
indirect CF (NP + depreciation − ΔAR − ΔInv + ΔAP + ΔpayrollLiab + ΔVAT + ΔtaxPayable), runway (first month
cash < minimumCash, min cash and its month), `warnings[]` (depreciation/interest checks per 10c, opening provisional,
negative cash, unmapped buckets with balances).

**Opening must balance:** |assets − liabilities − equity| > 1 cent → typed `OpeningUnbalancedError` (no plug, no suspense).

## 6. Schema sketch (one migration — Confirmation Gate)

Next free 3-digit prefix at commit time (head 946 at plan time; P1–P5 will take more — re-check).

```sql
CREATE TABLE IF NOT EXISTS budget_three_way_assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  version_id uuid NOT NULL REFERENCES budget_versions(id) ON DELETE CASCADE,
  schema_version integer NOT NULL DEFAULT 1,
  doc jsonb NOT NULL,                 -- full doc (original/reforecast) or {overrides} (scenario)
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS budget_three_way_assumptions_version_uq ON budget_three_way_assumptions (company_id, version_id);
-- Forced RLS + policies exactly like budget_month_amounts (P1); company-match trigger (version.company_id = row.company_id);
-- lock trigger: refuse INSERT/UPDATE/DELETE when the version is 'locked' — attach P1's public.budget_month_amounts_refuse_locked() (reads only version_id/company_id), ENABLE ALWAYS.
-- Grants per the post-945/946 app-pool rules (read P1's migration and the 945/946 headers first).
INSERT INTO feature_flags (code, name, description, is_global)
  VALUES ('budgets_three_way', 'Budgets: balance sheet & cash', 'Three-way budget and scenarios (Demo review)', false)
  ON CONFLICT (code) DO NOTHING;   -- verify the conflict target exists; mirror migration 263's insert form
```

No computed figures are stored. Enabling the flag for ISAFlow Demo (`company_feature_overrides`) is a prod
write done by Hein through admin.isaflow.co.za, after deploy.

## 7. API (all `withAuth(withErrorHandler(...))`, `withFeature('budgets_three_way')`, `apiResponse`, company-scoped)

Route files in the folder style P1 (`budget-versions/`) and P2 (`budget-grid/`) use:

| Route (NEW) | Method | Contract |
|---|---|---|
| `pages/api/accounting/budget-three-way/index.ts` | GET `?version_id=` (default primary) | `{ version, months, balanceSheet, cashFlow:{direct,indirect}, runway, checks, warnings, assumptions(resolved+provenance), opening:{asAt, provisional} }` |
| `pages/api/accounting/budget-three-way/assumptions.ts` | GET / PUT | PUT body `{ version_id, doc, expected_updated_at }` → zod 400; 409 on stale `updated_at`; 423/409 typed on locked; write access; audit `entity='budget'` with before/after |
| `pages/api/accounting/budget-three-way/derive.ts` | POST `{ version_id }` | derived defaults + evidence (aging totals, trailing figures); no write |
| `pages/api/accounting/budget-three-way/compare.ts` | GET `?version_ids=a,b,c` (1–3, same company + fiscal_year) | per version: closing cash series, min cash, NP, closing AR/AP, net debt; Δ vs first |

Writes refused for non-Demo companies are not needed: the flag already 403s them.

## 8. UI

Page `pages/accounting/budgets/three-way.tsx` (NEW), wrapped in `FeatureGate feature="budgets_three_way"`; linked
from the budgets workspace versions bar; nav entry under Budgets in `navSections/accounting.ts` and
`navSections/accountants.ts`, hidden unless the flag is on (small feature filter in `AccountingNav.tsx` — existing
code path, so that PR needs Hein's diff read).
- **Header:** version switcher (P2's), opening as-at chip (amber when provisional), "Balances ✓" chip that turns red if any `check ≠ 0`.
- **Runway chart:** `CashPositionChart` (closing cash per month, minimum-cash line, negative months shaded); tooltip via `escapeHtml`.
- **Tabs:** Balance sheet (StatementGrid: sections, months, FY close, opening column) · Cash flow (direct with operating/investing/financing subtotals; indirect reconciliation block beneath; opening → closing cash) · Assumptions panel (form grouped as §4, each field shows source chip derived/manual + derive evidence; capex/loans/equity as editable lists; Save with concurrency; locked = read-only) · Compare (pick up to 3 versions; overlaid cash lines; KPI table with Δ coloured via `ibcs.varianceColor` — cash higher = favourable).
- Figures via `formatStatementFigure`/`formatPct`; dark + light; 1280 and 390 (horizontal scroll inside grid only).
- Components NEW under `src/components/accounting/budgets/threeWay/` (each < 300 lines; hooks `useThreeWay`, `useAssumptionsForm`).

## 9. Task DAG (each step: `verify:`)

All files named in T1–T13 are NEW, under NEW `src/modules/accounting/services/budgets/threeWay/` (plus its
`.claude.md`) and the NEW routes in §7.

```
T0 gate §1 ─► T1 types+schema ─► T2 daysMethod ─┬─► T5 engine ─► T6 cashFlow ─► T7 property tests ─┐
              T3 vatPeriodOf ───────────────────┤                                                  │
              T4 statutory (PAYE, IRP6) ────────┘                                                  │
T8 migration (gate) ─► T9 assumptionsRepo ─┐                                                       │
T10 opening+lookback readers ──────────────┼─► T12 threeWayService ─► T13 API ─► T14 UI ─► T15 golden/Playwright ─► T16 Demo handoff
T11 deriveAssumptions ─────────────────────┘          ▲───────────────────────────────────────────┘
```
- **T1** `budgets/threeWay/types.ts`, `assumptionsSchema.ts` (zod, deep-merge with array replace). verify: schema tests incl. merge + cycle/depth refusal.
- **T2** `daysMethod.ts`. verify: F1/F2 closing balances to the cent; days > 2 months walks into lookback.
- **T3** `vatSchedule.ts` `vatPeriodOf` + due month. verify: table test for all 12 months × {monthly, odd, even} equals `vatPeriodHelper.expectedVatPeriodAsOf` / `vatQuickPeriods` output.
- **T4** `statutorySchedule.ts`. verify: F4 payroll, F6 IRP6 (Feb and non-Feb year ends, 14-month transition year).
- **T5** `postings.ts` + `engine.ts`. verify: F1–F7 every bucket every month; `check = 0`.
- **T6** `cashFlow.ts`. verify: direct = indirect operating; opening + net = closing cash, all fixtures.
- **T7** property test (seeded PRNG, 500 random inputs). verify: invariants I1–I4 hold; mutation M9 red.
- **T8** migration (§6) — **STOP for Hein's OK before merge**. verify: integration step on GitHub as non-superuser; app_user refused on locked version.
- **T9** `assumptionsRepo.ts`. Writes pre-lock the version with P1's `lockVersionForWrite` first (P1's upgrade-deadlock rule; the attached lock trigger takes `FOR SHARE`). verify: real-PG concurrency 409, locked refusal (typed 409 via `mapBudgetDbError`), audit row, tenant isolation.
- **T10** `openingBalances.ts`, `actualsLookback.ts` (read-only SQL, `company_id` on every join). verify: I7 parity with `getBalanceSheet` and `getCashBalance` on fixture companies.
- **T11** `deriveAssumptions.ts` (pure core + DB adapter). verify: I6 steady state.
- **T12** `threeWayService.ts`, `compare.ts`. verify: I5 NP parity with P3's BvA reader for the same version; I8 empty-override scenario = base.
- **T13** routes §7. verify: route tests 400/403(flag)/404(other tenant)/409/locked.
- **T14** UI §8 + nav. verify: browser proof dark/light × 1280/390 on dev Demo, screenshots in evidence dir.
- **T15** Playwright acceptance (§10), file `tests/e2e/golden-paths/<next free letter>-budgets-three-way.spec.ts`, **dev-only** (in `playwright-golden.config.ts`'s `testIgnore` regex). verify: green on dev; with `GOLDEN_SKIP_A11Y=1`, `bunx playwright test --config playwright-golden.config.ts --list` does not list it (R5).
- **T16** handoff: after-hours deploy request; Hein enables flag on Demo; Hein review checklist.

Suggested PRs: **A** T1–T7 (pure, greenfield — may queue without Hein if all gates + blind `/review` + security review green) · **B** T8 (migration, gate) · **C** T9–T13 · **D** T14–T15 (nav filter touches existing code → Hein reads diff).

## 10. Tests, fixtures, mutations

Unit: `tests/unit/services/budgets/threeWay/*.test.ts` (NEW). Integration: `tests/integration/budgets-three-way-*.int.test.ts` (NEW).
Golden: `tests/e2e/golden-paths/<next free letter>-budgets-three-way.spec.ts` (NEW, dev-only).

**Hand-computed fixtures (pin these numbers; Rands):**
- **F1** Not VAT-registered. Open 28 Feb: cash 100 000, equity 100 000. Turnover 31 000/30 000/31 000 (Mar/Apr/May), supplier opex 15 500/15 000/15 500, D = 15, C = 0, lookback 0.
  AR close 15 000 each month; receipts 16 000 / 30 000 / 31 000; cash 100 500 / 115 500 / 131 000; RE 15 500 / 30 500 / 46 000; BS 115 500 / 130 500 / 146 000 both sides.
- **F2** D = 45, R1 000/day, Feb lookback 28 000 (28 d). AR close Mar = 31 000 + 14/28×28 000 = 45 000; Apr = 30 000 + 15/31×31 000 = 45 000.
- **F3** VAT monthly, invoice basis, shares 1, 15 %. Mar turnover 10 000, opex 4 000, D = C = 0. Output 1 500, input 600; Mar cash +6 900, VAT payable 900, RE 6 000; Apr cash −900, VAT 0.
- **F3b** Bi-monthly, period Apr–May. Turnover 10 000 Apr and May, nothing else; opening VAT payable 2 000 (period ended Mar). Apr pays 2 000; May accrues 3 000 total; June pays 3 000. Payment-basis variant with D = 31: VAT accrues on receipts.
- **F4** Payroll 100 000/month, p = 0.30, opening payroll liability 25 000. Month 1 cash out 95 000, liability close 30 000; month 2 out 100 000.
- **F5** COGS 60 000 in a 31-day month, I = 31, opening inventory 50 000, C = 0, no VAT. Close inventory 60 000; purchases paid 70 000.
- **F6** FY Mar–Feb, tax 12 000/month (FY 144 000), opening tax payable 30 000, Feb YE. Aug: 72 000 + 30 000 top-up; Feb: 72 000. Non-Feb YE variant: top-up month 7.
- **F7** Capex Apr 100 000 ex VAT claimable (cash 115 000, VAT asset 15 000); depreciation 2 000/m; loan drawdown 100 000 Apr, principal 5 000/m from May; interest 1 000/m. Investing −115 000 Apr; financing +100 000 Apr, −5 000 May.

**Invariants:** I1 `check = 0` every month (cents) · I2 opening cash + Σ net CF = closing cash · I3 direct operating = indirect operating · I4 every posting Σdr = Σcr · I5 Σ ΔRE from NP = version NP from P3's reader · I6 derive-then-flat P&L keeps AR/AP/Inv constant · I7 opening buckets = `getBalanceSheet` totals and cash = `getCashBalance` (real PG) · I8 empty override = base · I9 locked version refuses assumption writes as app_user · I10 other tenant's version → 404, no data.

**Mutations (each must turn a named test red; record in PR body):** M1 receipts use close instead of open AR (F1) · M2 VAT paid in period-end month (F3) · M3 alignment flipped (F3b, T3 table) · M4 depreciation credited to cash (I3, F7) · M5 statutory share ignored (F4) · M6 shallow merge of overrides (scenario test) · M7 drop `company_id` predicate in assumptions read (I10) · M8 drop lock trigger (I9) · M9 drop cent-residue carry (I1 property) · M10 IRP6 #1 in month 7 (F6).

**Playwright acceptance (dev, Demo-equivalent company, flag on):** open three-way for the primary version → "Balances ✓" chip, runway chart renders; edit debtor days 30 → 60 and save → closing cash month 3 drops by the hand-checked amount; create scenario "Worst" from base, override debtor days 90 → compare shows three lines and Δ cash; screenshots dark/light 1280/390.

## 11. Risks

- **R1 Wrong-but-balanced.** Double entry guarantees balance, not truth. Mitigation: fixtures F1–F7 pin timing; Hein reviews Demo before any client sees it.
- **R2 VAT alignment semantics disagree in the repo.** `sarsTaxPeriodsService` 'odd' = periods *starting* in odd months; `vatPeriodHelper` 'odd' = periods *ending* in odd months. P6 uses `vatPeriodHelper` (VAT201/compliance paths use it) and pins it with T3; report the disagreement in the handoff, do not fix `sarsTaxPeriodsService` here.
- **R3 Opening BS has no subtype per line.** `getBalanceSheet` returns `accountCode` only; T10 needs its own bucketed read and I7 parity to stay honest.
- **R4 Derived retained earnings.** Prod companies carry RE as a derived plug (see `balanceSheetService.ts` header); opening equity must include it or opening won't balance.
- **R5 Golden specs run in prod post-deploy verify; red = auto-rollback.** Resolved by the contract's golden-spec rule: the spec is dev-only (it needs the flag and writes assumptions, which on Demo would touch the primary version), listed in `playwright-golden.config.ts`'s `testIgnore` regex.
- **R6 Loan schedule reads lock.** `getOrComputeSchedule` takes `FOR SHARE` and persists; use `previewSchedule` only.
- **R7 Timezone.** Months are `YYYY-MM-01` strings end to end; no `Date` arithmetic in the engine.
- **R8 Lookback quality.** Demo needs ≥ 12 months of actuals or derived days default and the banner says so.
- **R9 Scope creep into a forecasting app.** §3 out-of-scope list is binding; new asks go to a later phase.

## 12. Acceptance

On ISAFlow Demo (prod, after an approved after-hours deploy, flag on for Demo only): a finance user opens
the three-way view of the primary FY version, sees a balanced budgeted BS for every month and a cash flow
whose closing cash equals the BS cash line; changes debtor days and sees cash move; builds Best/Worst
scenarios and compares runway. Every other company gets 403 from the API and no nav entry. Hein signs off
before the flag is widened.

## 13. Changes after MVP feedback

(empty — fill at phase start)
