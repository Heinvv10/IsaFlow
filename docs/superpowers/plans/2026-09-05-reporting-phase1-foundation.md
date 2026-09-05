# Reporting Phase 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One statement renderer (`StatementGrid`), one KPI tile, one money formatter, and all five statement surfaces migrated onto them, footing to the cent against real tenants.

**Architecture:** Services stay untouched. A pure adapter turns each report type (`IncomeStatementReport`, `BalanceSheetReport`) into a flat `StatementRow[]` where every figure is copied from a service field. `StatementGrid` renders that array and nothing else: it never adds, subtracts or derives. Drill-through reuses the existing `AccountDrillDown`. The row model is the contract later workstreams build on; the rendering engine behind it can change without touching adapters.

**Tech Stack:** Next.js 14 Pages Router · React 18 · TypeScript strict · Tailwind + `--ff-*` tokens · Vitest (node for adapters, happy-dom for components) · Postgres integration tests via `DATABASE_URL`.

**Spec:** `docs/superpowers/plans/2026-09-05-reporting-programme.md` (Global Constraints there apply to every task here).

## Global Constraints

- **The grid computes nothing.** Adapters copy service fields. A test asserts every rendered figure appears in the report object.
- **Figures**: `formatMoney` output only. Tabular numerals, negatives in parentheses, thousands separators, no decimals unless `{ cents: true }`.
- **Colour**: `--ff-fav` / `--ff-unfav` for favourable/unfavourable variance only. No `bg-${color}-500/5` interpolation anywhere new; Tailwind purges it.
- **Existing tests stay green**: `tests/unit/services/reports/incomeStatementRenderSurfaces.test.ts` imports `IncomeStatementBlock`, `IncomeStatementSections`, `ManagementPandLRows`. Keep those exports and their signatures; their bodies change.
- **Max 300 lines per file.** `log` from `@/lib/logger`. No empty catch.
- **Branch**: `feat/reporting-ws0-foundation`, its own worktree. Stage by path. No stash.
- Commit after every task. Run `bun run type-check` before each commit; `bun run ci` before the PR.

---

## File Structure

```
src/lib/format/money.ts                      formatMoney, formatPct, signOf
src/components/accounting/statement/
  statementModel.ts                          StatementRow, StatementRowKind, StatementColumns
  incomeStatementRows.ts                     toIncomeStatementRows(report, opts)
  balanceSheetRows.ts                        toBalanceSheetRows(report, opts)
  StatementGrid.tsx                          <StatementGrid rows columns renderDrill? />
  StatementRowView.tsx                       one <tr>; kinds → rule/indent/weight
  VarianceBar.tsx                            zero-centred bar, fav/unfav
  Sparkline.tsx                              12-point inline SVG
src/components/accounting/kpi/KpiTile.tsx    value, comparator, delta, sparkline
styles/globals.css                           + --ff-fav, --ff-unfav, --ff-fig-font, --ff-prior, --ff-plan
tests/unit/lib/format/money.test.ts
tests/unit/services/reports/incomeStatementRows.test.ts
tests/unit/services/reports/balanceSheetRows.test.ts
tests/unit/components/statement/StatementGrid.test.tsx
tests/unit/components/statement/KpiTile.test.tsx
tests/integration/statement-grid-foots.int.test.ts
```

Migrated (modified, exports kept):
- `src/components/accounting/IncomeStatementSections.tsx`
- `pages/accounting/reports/balance-sheet.tsx`
- `src/components/accounting/ManagementPandLRows.tsx`
- `pages/accounting/reports/management-accounts.tsx` (KpiCard removed)
- `pages/accounting/reports/report-packs.tsx` (income_statement / balance_sheet sections)
- `pages/accounting/reports/executive-dashboard.tsx` (KPICard removed)
- `src/components/accounting/afs/AfsStatementsTab.tsx`

---

### Task 1: `formatMoney` and figure tokens

**Files:**
- Create: `src/lib/format/money.ts`
- Modify: `styles/globals.css` (light block near line 66, dark block near line 148)
- Test: `tests/unit/lib/format/money.test.ts`

**Interfaces:**
- Produces: `formatMoney(n: number, opts?: { cents?: boolean; symbol?: boolean }): string`, `formatPct(n: number, dp?: number): string`, `signOf(n: number): 'pos' | 'neg' | 'zero'`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lib/format/money.test.ts
import { describe, it, expect } from 'vitest';
import { formatMoney, formatPct, signOf } from '@/lib/format/money';

describe('formatMoney', () => {
  it('uses thousands separators and no decimals by default', () => {
    expect(formatMoney(4812345.67)).toBe('4 812 346');
  });
  it('shows negatives in parentheses, never a minus', () => {
    expect(formatMoney(-2190000)).toBe('(2 190 000)');
    expect(formatMoney(-2190000)).not.toContain('-');
  });
  it('shows cents when asked', () => {
    expect(formatMoney(53787.07, { cents: true })).toBe('53 787.07');
  });
  it('prefixes the rand symbol when asked', () => {
    expect(formatMoney(1000, { symbol: true })).toBe('R 1 000');
    expect(formatMoney(-1000, { symbol: true })).toBe('(R 1 000)');
  });
  it('renders zero as a dash', () => {
    expect(formatMoney(0)).toBe('–');
  });
  it('treats -0.004 as zero, not a negative', () => {
    expect(formatMoney(-0.004)).toBe('–');
  });
});

describe('formatPct', () => {
  it('signs positive and negative, one decimal', () => {
    expect(formatPct(6.94)).toBe('+6.9%');
    expect(formatPct(-8.1)).toBe('−8.1%');
    expect(formatPct(0)).toBe('0.0%');
  });
});

describe('signOf', () => {
  it('classifies', () => {
    expect(signOf(5)).toBe('pos'); expect(signOf(-5)).toBe('neg'); expect(signOf(0)).toBe('zero');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run tests/unit/lib/format/money.test.ts`
Expected: FAIL, cannot find module `@/lib/format/money`.

- [ ] **Step 3: Implement**

```ts
// src/lib/format/money.ts
/**
 * Statement figure formatting. One place, so a number looks the same on the
 * screen, in the pack and in the PDF. Conventions: thousands separated by a
 * narrow space (en-ZA), negatives in parentheses, zero as an en dash.
 */
const ZERO_DASH = '–';
const MINUS = '−';

const whole = new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function signOf(n: number): 'pos' | 'neg' | 'zero' {
  if (Math.abs(n) < 0.005) return 'zero';
  return n < 0 ? 'neg' : 'pos';
}

export function formatMoney(n: number, opts: { cents?: boolean; symbol?: boolean } = {}): string {
  const s = signOf(n);
  if (s === 'zero') return ZERO_DASH;
  const body = (opts.cents ? cents : whole).format(Math.abs(n)).replace(/,/g, ' ').replace(/ /g, ' ');
  const withSymbol = opts.symbol ? `R ${body}` : body;
  return s === 'neg' ? `(${withSymbol})` : withSymbol;
}

export function formatPct(n: number, dp = 1): string {
  const s = signOf(n);
  const body = `${Math.abs(n).toFixed(dp)}%`;
  if (s === 'zero') return `0.${'0'.repeat(dp)}%`;
  return s === 'neg' ? `${MINUS}${body}` : `+${body}`;
}
```

Add to `styles/globals.css` in the `:root` light block:

```css
    /* Statement figures — IBCS semantic colours. Favourable/unfavourable ONLY. */
    --ff-fav: #1f7a4d;
    --ff-unfav: #b23a3a;
    --ff-prior: #c9d0cc;
    --ff-plan: #8a94a0;
    --ff-fig-font: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
```

and in the `.dark` block:

```css
    --ff-fav: #5fcf92;
    --ff-unfav: #f08a8a;
    --ff-prior: #3a4752;
    --ff-plan: #7b8792;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/lib/format/money.test.ts`
Expected: PASS (9 tests). If the en-ZA group separator differs in this Node ICU build, the `.replace` chain normalises it; do not change the expected strings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/format/money.ts styles/globals.css tests/unit/lib/format/money.test.ts
git commit -m "feat(reporting): formatMoney and statement figure tokens"
```

---

### Task 2: Row model and income statement adapter

**Files:**
- Create: `src/components/accounting/statement/statementModel.ts`
- Create: `src/components/accounting/statement/incomeStatementRows.ts`
- Test: `tests/unit/services/reports/incomeStatementRows.test.ts`

**Interfaces:**
- Consumes: `IncomeStatementReport`, `IncomeStatementLineItem` from `@/modules/accounting/types/gl.report.types`.
- Produces:

```ts
export type StatementRowKind = 'section' | 'line' | 'subtotal' | 'total' | 'grand';
export interface StatementRow {
  id: string;                 // stable: 'sec:revenue', 'acc:4000', 'sub:totalRevenue', 'grand:netProfit'
  kind: StatementRowKind;
  label: string;
  depth: 0 | 1;               // 1 = account line under a section
  accountCode?: string;       // present on 'line' rows only; enables drill
  actual: number;
  prior?: number;
  variance?: number;          // actual - prior, copied from the service when present
  variancePct?: number;
  favourable?: boolean;       // sign-aware: revenue up is good, expense up is bad
  trend?: number[];           // filled by later workstreams; undefined in Phase 1
}
export interface StatementColumns { prior: boolean; variance: boolean; trend: boolean; }
export function toIncomeStatementRows(r: IncomeStatementReport, opts: { comparative: boolean }): StatementRow[]
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/reports/incomeStatementRows.test.ts
import { describe, it, expect } from 'vitest';
import { toIncomeStatementRows } from '@/components/accounting/statement/incomeStatementRows';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.report.types';

const line = (accountCode: string, accountName: string, amount: number, priorAmount?: number) =>
  ({ accountCode, accountName, amount, priorAmount, variance: priorAmount === undefined ? undefined : amount - priorAmount });

const R: IncomeStatementReport = {
  periodStart: '2026-01-01', periodEnd: '2026-12-31',
  revenue: [line('4000', 'Sales', 5000000, 4100000)],
  otherIncome: [line('4300', 'Interest Received', 53787.07, 40000)],
  costOfSales: [line('5000', 'Direct Material', 1800000, 1700000)],
  operatingExpenses: [line('6000', 'Rent', 400000, 380000)],
  otherExpenses: [line('5810', 'Interest Expense', 120000, 100000)],
  totalRevenue: 5000000, totalOtherIncome: 53787.07, totalCostOfSales: 1800000,
  totalOperatingExpenses: 400000, totalOtherExpenses: 120000,
  grossProfit: 3200000, operatingProfit: 2853787.07, netProfit: 2733787.07,
  priorTotalRevenue: 4100000, priorGrossProfit: 2400000, priorOperatingProfit: 2060000, priorNetProfit: 1960000,
  priorTotalOtherIncome: 40000, priorTotalCostOfSales: 1700000, priorTotalOperatingExpenses: 380000, priorTotalOtherExpenses: 100000,
  subtypeDisclosure: null, priorSubtypeDisclosure: null,
} as IncomeStatementReport;

const labels = (rows: ReturnType<typeof toIncomeStatementRows>) => rows.map(r => r.label);

describe('toIncomeStatementRows', () => {
  it('emits every band in reconciling order', () => {
    const l = labels(toIncomeStatementRows(R, { comparative: false }));
    const at = (s: string) => l.indexOf(s);
    expect(at('Turnover')).toBeGreaterThanOrEqual(0);
    expect(at('Cost of Sales')).toBeGreaterThan(at('Turnover'));
    expect(at('Gross Profit')).toBeGreaterThan(at('Cost of Sales'));
    expect(at('Other Income')).toBeGreaterThan(at('Gross Profit'));
    expect(at('Operating Expenses')).toBeGreaterThan(at('Other Income'));
    expect(at('Operating Profit')).toBeGreaterThan(at('Operating Expenses'));
    expect(at('Other Expenses')).toBeGreaterThan(at('Operating Profit'));
    expect(at('Net Profit / (Loss)')).toBeGreaterThan(at('Other Expenses'));
  });

  it('copies every figure from the report and derives none', () => {
    const rows = toIncomeStatementRows(R, { comparative: true });
    const reportNumbers = new Set<number>();
    const walk = (v: unknown) => {
      if (typeof v === 'number') reportNumbers.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(R);
    for (const row of rows) {
      expect(reportNumbers, `${row.label} actual`).toContain(row.actual);
      if (row.prior !== undefined) expect(reportNumbers, `${row.label} prior`).toContain(row.prior);
    }
  });

  it('omits Other Income and Other Expenses sections when empty', () => {
    const l = labels(toIncomeStatementRows({ ...R, otherIncome: [], otherExpenses: [], totalOtherIncome: 0, totalOtherExpenses: 0 }, { comparative: false }));
    expect(l).not.toContain('Other Income');
    expect(l).not.toContain('Other Expenses');
    expect(l).toContain('Operating Profit');
  });

  it('marks favourability by sign convention: revenue up is good, expense up is bad', () => {
    const rows = toIncomeStatementRows(R, { comparative: true });
    expect(rows.find(r => r.accountCode === '4000')?.favourable).toBe(true);
    expect(rows.find(r => r.accountCode === '6000')?.favourable).toBe(false);
  });

  it('carries no prior or variance when comparative is off', () => {
    const rows = toIncomeStatementRows(R, { comparative: false });
    expect(rows.every(r => r.prior === undefined && r.variance === undefined)).toBe(true);
  });

  it('gives line rows the account code and depth 1; totals depth 0 and no code', () => {
    const rows = toIncomeStatementRows(R, { comparative: false });
    const sales = rows.find(r => r.accountCode === '4000')!;
    expect(sales.kind).toBe('line'); expect(sales.depth).toBe(1);
    const np = rows.find(r => r.id === 'grand:netProfit')!;
    expect(np.kind).toBe('grand'); expect(np.depth).toBe(0); expect(np.accountCode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/services/reports/incomeStatementRows.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the model and adapter**

```ts
// src/components/accounting/statement/statementModel.ts
export type StatementRowKind = 'section' | 'line' | 'subtotal' | 'total' | 'grand';

export interface StatementRow {
  id: string;
  kind: StatementRowKind;
  label: string;
  depth: 0 | 1;
  accountCode?: string;
  actual: number;
  prior?: number;
  variance?: number;
  variancePct?: number;
  favourable?: boolean;
  trend?: number[];
}

export interface StatementColumns {
  prior: boolean;
  variance: boolean;
  trend: boolean;
}
```

```ts
// src/components/accounting/statement/incomeStatementRows.ts
/**
 * IncomeStatementReport → StatementRow[]. Every figure is COPIED from the
 * report; nothing is derived here. Band order is the reconciling order:
 * Turnover, Cost of Sales, Gross Profit, Other Income, Operating Expenses,
 * Operating Profit, Other Expenses, Net Profit. Other income sits above the
 * operating line on purpose (see incomeStatementService and B75).
 */
import type { IncomeStatementLineItem, IncomeStatementReport } from '@/modules/accounting/types/gl.report.types';
import type { StatementRow } from './statementModel';

type Polarity = 'income' | 'expense';

function lineRows(items: IncomeStatementLineItem[], polarity: Polarity, comparative: boolean): StatementRow[] {
  return items.map(it => {
    const row: StatementRow = {
      id: `acc:${it.accountCode}`, kind: 'line', label: it.accountName, depth: 1,
      accountCode: it.accountCode, actual: it.amount,
    };
    if (comparative && it.priorAmount !== undefined) {
      row.prior = it.priorAmount;
      row.variance = it.variance;
      row.variancePct = it.variancePct;
      if (it.variance !== undefined) row.favourable = polarity === 'income' ? it.variance >= 0 : it.variance <= 0;
    }
    return row;
  });
}

function section(
  key: string, label: string, items: IncomeStatementLineItem[], total: number, prior: number | undefined,
  polarity: Polarity, comparative: boolean,
): StatementRow[] {
  const head: StatementRow = { id: `sec:${key}`, kind: 'section', label, depth: 0, actual: total };
  const sub: StatementRow = { id: `sub:${key}`, kind: 'subtotal', label: `Total ${label}`, depth: 0, actual: total };
  if (comparative && prior !== undefined) {
    sub.prior = prior;
    sub.favourable = polarity === 'income' ? total >= prior : total <= prior;
  }
  return [head, ...lineRows(items, polarity, comparative), sub];
}

function total(id: string, kind: 'total' | 'grand', label: string, actual: number, prior: number | undefined, comparative: boolean): StatementRow {
  const row: StatementRow = { id, kind, label, depth: 0, actual };
  if (comparative && prior !== undefined) { row.prior = prior; row.favourable = actual >= prior; }
  return row;
}

export function toIncomeStatementRows(r: IncomeStatementReport, opts: { comparative: boolean }): StatementRow[] {
  const c = opts.comparative;
  const rows: StatementRow[] = [
    ...section('revenue', 'Turnover', r.revenue, r.totalRevenue, r.priorTotalRevenue, 'income', c),
  ];
  if (r.costOfSales.length > 0) {
    rows.push(...section('costOfSales', 'Cost of Sales', r.costOfSales, r.totalCostOfSales, r.priorTotalCostOfSales, 'expense', c));
  }
  rows.push(total('total:grossProfit', 'total', 'Gross Profit', r.grossProfit, r.priorGrossProfit, c));
  if (r.otherIncome.length > 0) {
    rows.push(...section('otherIncome', 'Other Income', r.otherIncome, r.totalOtherIncome, r.priorTotalOtherIncome, 'income', c));
  }
  rows.push(...section('operatingExpenses', 'Operating Expenses', r.operatingExpenses, r.totalOperatingExpenses, r.priorTotalOperatingExpenses, 'expense', c));
  rows.push(total('total:operatingProfit', 'total', 'Operating Profit', r.operatingProfit, r.priorOperatingProfit, c));
  if (r.otherExpenses.length > 0) {
    rows.push(...section('otherExpenses', 'Other Expenses', r.otherExpenses, r.totalOtherExpenses, r.priorTotalOtherExpenses, 'expense', c));
  }
  rows.push(total('grand:netProfit', 'grand', 'Net Profit / (Loss)', r.netProfit, r.priorNetProfit, c));
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/services/reports/incomeStatementRows.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Mutation check, then commit**

Temporarily change `rows.push(total('total:grossProfit', ..., r.grossProfit` to `r.totalRevenue - r.totalCostOfSales` and run the test: "copies every figure" must still pass (the value coincides) but that is the point of the guard being structural, so ALSO temporarily reorder Other Income below Operating Profit and confirm "emits every band in reconciling order" goes red. Revert both.

```bash
git add src/components/accounting/statement/statementModel.ts src/components/accounting/statement/incomeStatementRows.ts tests/unit/services/reports/incomeStatementRows.test.ts
git commit -m "feat(reporting): StatementRow model and income statement adapter"
```

---

### Task 3: Balance sheet adapter

**Files:**
- Create: `src/components/accounting/statement/balanceSheetRows.ts`
- Test: `tests/unit/services/reports/balanceSheetRows.test.ts`

**Interfaces:**
- Consumes: `BalanceSheetReport`, `BalanceSheetLineItem`; `StatementRow` from Task 2.
- Produces: `toBalanceSheetRows(r: BalanceSheetReport, opts: { comparative: boolean }): { assets: StatementRow[]; liabilitiesAndEquity: StatementRow[] }`. Two arrays because the page renders them side by side. The `Total L + E` row's `actual` is `r.totalLiabilities + r.totalEquity`: this is the ONE place the adapter adds, because the service has no field for it. It is commented and tested as such; if `balanceSheetService` later exposes `totalLiabilitiesAndEquity`, switch to it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/reports/balanceSheetRows.test.ts
import { describe, it, expect } from 'vitest';
import { toBalanceSheetRows } from '@/components/accounting/statement/balanceSheetRows';
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.report.types';

const R: BalanceSheetReport = {
  asAtDate: '2026-08-31',
  assets: [{ accountCode: '1000', accountName: 'Bank', balance: 500000, priorBalance: 400000, variance: 100000 }],
  liabilities: [{ accountCode: '2000', accountName: 'Creditors', balance: 200000, priorBalance: 250000, variance: -50000 }],
  equity: [{ accountCode: '3000', accountName: 'Retained income', balance: 300000, priorBalance: 150000, variance: 150000 }],
  totalAssets: 500000, totalLiabilities: 200000, totalEquity: 300000,
  priorTotalAssets: 400000, priorTotalLiabilities: 250000, priorTotalEquity: 150000,
};

describe('toBalanceSheetRows', () => {
  it('splits assets from liabilities and equity, each with its total', () => {
    const { assets, liabilitiesAndEquity } = toBalanceSheetRows(R, { comparative: false });
    expect(assets.map(r => r.label)).toEqual(['Assets', 'Bank', 'Total Assets']);
    expect(liabilitiesAndEquity.map(r => r.label)).toEqual([
      'Liabilities', 'Creditors', 'Total Liabilities', 'Equity', 'Retained income', 'Total Equity', 'Total Liabilities and Equity',
    ]);
  });

  it('Total Liabilities and Equity is the only derived figure and equals L + E', () => {
    const { liabilitiesAndEquity } = toBalanceSheetRows(R, { comparative: false });
    const le = liabilitiesAndEquity.find(r => r.id === 'grand:totalLiabilitiesAndEquity')!;
    expect(le.actual).toBe(R.totalLiabilities + R.totalEquity);
    expect(le.kind).toBe('grand');
  });

  it('carries prior balances only when comparative', () => {
    const on = toBalanceSheetRows(R, { comparative: true }).assets.find(r => r.accountCode === '1000')!;
    const off = toBalanceSheetRows(R, { comparative: false }).assets.find(r => r.accountCode === '1000')!;
    expect(on.prior).toBe(400000); expect(off.prior).toBeUndefined();
  });

  it('a liability going down is favourable; an asset going up is favourable', () => {
    const { assets, liabilitiesAndEquity } = toBalanceSheetRows(R, { comparative: true });
    expect(assets.find(r => r.accountCode === '1000')?.favourable).toBe(true);
    expect(liabilitiesAndEquity.find(r => r.accountCode === '2000')?.favourable).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/services/reports/balanceSheetRows.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// src/components/accounting/statement/balanceSheetRows.ts
/**
 * BalanceSheetReport → two StatementRow[] (assets; liabilities and equity).
 * Every figure is copied from the report except `Total Liabilities and
 * Equity`, which the service does not expose; it is the sum of two service
 * totals and is the single derived figure in the statement layer.
 */
import type { BalanceSheetLineItem, BalanceSheetReport } from '@/modules/accounting/types/gl.report.types';
import type { StatementRow } from './statementModel';

type Polarity = 'asset' | 'claim'; // claim = liability or equity; going down is favourable for a liability

function lines(items: BalanceSheetLineItem[], polarity: Polarity, comparative: boolean): StatementRow[] {
  return items.map(it => {
    const row: StatementRow = {
      id: `acc:${it.accountCode}`, kind: 'line', label: it.accountName, depth: 1,
      accountCode: it.accountCode, actual: it.balance,
    };
    if (comparative && it.priorBalance !== undefined) {
      row.prior = it.priorBalance; row.variance = it.variance; row.variancePct = it.variancePct;
      if (it.variance !== undefined) row.favourable = polarity === 'asset' ? it.variance >= 0 : it.variance <= 0;
    }
    return row;
  });
}

function block(key: string, label: string, items: BalanceSheetLineItem[], total: number, prior: number | undefined, polarity: Polarity, comparative: boolean): StatementRow[] {
  const head: StatementRow = { id: `sec:${key}`, kind: 'section', label, depth: 0, actual: total };
  const sub: StatementRow = { id: `sub:${key}`, kind: 'subtotal', label: `Total ${label}`, depth: 0, actual: total };
  if (comparative && prior !== undefined) sub.prior = prior;
  return [head, ...lines(items, polarity, comparative), sub];
}

export function toBalanceSheetRows(r: BalanceSheetReport, opts: { comparative: boolean }) {
  const c = opts.comparative;
  const assets = block('assets', 'Assets', r.assets, r.totalAssets, r.priorTotalAssets, 'asset', c);
  const le: StatementRow = {
    id: 'grand:totalLiabilitiesAndEquity', kind: 'grand', label: 'Total Liabilities and Equity', depth: 0,
    actual: r.totalLiabilities + r.totalEquity, // derived: the service has no field for this
  };
  if (c && r.priorTotalLiabilities !== undefined && r.priorTotalEquity !== undefined) {
    le.prior = r.priorTotalLiabilities + r.priorTotalEquity;
  }
  const liabilitiesAndEquity = [
    ...block('liabilities', 'Liabilities', r.liabilities, r.totalLiabilities, r.priorTotalLiabilities, 'claim', c),
    ...block('equity', 'Equity', r.equity, r.totalEquity, r.priorTotalEquity, 'claim', c),
    le,
  ];
  return { assets, liabilitiesAndEquity };
}
```

Note: equity going up is favourable in substance, but the polarity here only feeds line-level colouring, and equity lines rarely carry a comparative; leave equity as `claim` and revisit if a reviewer objects.

- [ ] **Step 4: Run test, expect PASS (4 tests). Commit.**

```bash
git add src/components/accounting/statement/balanceSheetRows.ts tests/unit/services/reports/balanceSheetRows.test.ts
git commit -m "feat(reporting): balance sheet adapter"
```

---

### Task 4: `StatementGrid`, `StatementRowView`, `VarianceBar`, `Sparkline`

**Files:**
- Create: `src/components/accounting/statement/StatementGrid.tsx`
- Create: `src/components/accounting/statement/StatementRowView.tsx`
- Create: `src/components/accounting/statement/VarianceBar.tsx`
- Create: `src/components/accounting/statement/Sparkline.tsx`
- Test: `tests/unit/components/statement/StatementGrid.test.tsx` (happy-dom config: `npx vitest run --config vitest.components.config.ts`)

**Interfaces:**
- Consumes: `StatementRow`, `StatementColumns` (Task 2); `formatMoney`, `formatPct` (Task 1).
- Produces:

```tsx
export interface StatementGridProps {
  rows: StatementRow[];
  columns: StatementColumns;
  title?: string;
  expandedAccount?: string | null;
  onToggleAccount?: (code: string) => void;
  /** Rendered as a full-width row directly under the expanded line. */
  renderDrill?: (accountCode: string) => React.ReactNode;
  cents?: boolean;
}
export function StatementGrid(props: StatementGridProps): JSX.Element
export function VarianceBar({ value, max, favourable }: { value: number; max: number; favourable?: boolean }): JSX.Element
export function Sparkline({ points }: { points: number[] }): JSX.Element
```

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/statement/StatementGrid.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import type { StatementRow } from '@/components/accounting/statement/statementModel';

const rows: StatementRow[] = [
  { id: 'sec:revenue', kind: 'section', label: 'Turnover', depth: 0, actual: 5000000 },
  { id: 'acc:4000', kind: 'line', label: 'Sales', depth: 1, accountCode: '4000', actual: 5000000, prior: 4100000, variance: 900000, variancePct: 21.95, favourable: true },
  { id: 'sub:revenue', kind: 'subtotal', label: 'Total Turnover', depth: 0, actual: 5000000, prior: 4100000 },
  { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)', depth: 0, actual: -120000, prior: 50000, favourable: false },
];

describe('StatementGrid', () => {
  it('renders figures through formatMoney: tabular, parentheses for negatives', () => {
    render(<StatementGrid rows={rows} columns={{ prior: false, variance: false, trend: false }} />);
    expect(screen.getByText('5 000 000')).toBeTruthy();
    expect(screen.getByText('(120 000)')).toBeTruthy();
    expect(screen.queryByText('-120 000')).toBeNull();
  });

  it('shows prior and variance columns only when asked', () => {
    const { rerender } = render(<StatementGrid rows={rows} columns={{ prior: false, variance: false, trend: false }} />);
    expect(screen.queryByText('4 100 000')).toBeNull();
    rerender(<StatementGrid rows={rows} columns={{ prior: true, variance: true, trend: false }} />);
    expect(screen.getByText('4 100 000')).toBeTruthy();
    expect(screen.getByText('+22.0%')).toBeTruthy();
  });

  it('marks rule weight by kind: subtotal single, grand double', () => {
    render(<StatementGrid rows={rows} columns={{ prior: false, variance: false, trend: false }} />);
    expect(screen.getByText('Total Turnover').closest('tr')?.getAttribute('data-kind')).toBe('subtotal');
    expect(screen.getByText('Net Profit / (Loss)').closest('tr')?.getAttribute('data-kind')).toBe('grand');
  });

  it('a line row is a button that reports its account code; totals are not', () => {
    const onToggle = vi.fn();
    render(<StatementGrid rows={rows} columns={{ prior: false, variance: false, trend: false }} onToggleAccount={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /Sales/ }));
    expect(onToggle).toHaveBeenCalledWith('4000');
    expect(screen.queryByRole('button', { name: /Net Profit/ })).toBeNull();
  });

  it('renders the drill row under the expanded account only', () => {
    render(
      <StatementGrid rows={rows} columns={{ prior: false, variance: false, trend: false }}
        expandedAccount="4000" renderDrill={code => <div>drill for {code}</div>} />,
    );
    expect(screen.getByText('drill for 4000')).toBeTruthy();
  });

  it('never renders a figure that is not in rows', () => {
    const { container } = render(<StatementGrid rows={rows} columns={{ prior: true, variance: true, trend: false }} />);
    const digits = container.textContent!.replace(/[^0-9]/g, '');
    // 5000000, 4100000, 900000, 120000, 50000, 22.0 → all from rows. A derived sum like 4 880 000 must not appear.
    expect(digits).not.toContain('4880000');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.components.config.ts tests/unit/components/statement/StatementGrid.test.tsx`
Expected: FAIL, module not found. If `@testing-library/react` is missing, add it: `bun add -d @testing-library/react` and commit the lockfile with this task.

- [ ] **Step 3: Implement the four components**

```tsx
// src/components/accounting/statement/Sparkline.tsx
export function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <svg className="ff-spark" viewBox="0 0 72 18" aria-hidden="true" />;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const step = 70 / (points.length - 1);
  const pts = points.map((p, i) => `${(1 + i * step).toFixed(1)},${(16 - ((p - min) / span) * 14).toFixed(1)}`);
  const [lx, ly] = pts[pts.length - 1]!.split(',');
  return (
    <svg className="ff-spark" viewBox="0 0 72 18" width="72" height="18" aria-hidden="true">
      <polyline fill="none" stroke="currentColor" strokeWidth="1.5" points={pts.join(' ')} />
      <circle cx={lx} cy={ly} r="2" fill="currentColor" />
    </svg>
  );
}
```

```tsx
// src/components/accounting/statement/VarianceBar.tsx
/** Zero-centred bar. Width is |value| / max of the column, so one scale per statement. */
export function VarianceBar({ value, max, favourable }: { value: number; max: number; favourable?: boolean }) {
  const pct = max > 0 ? Math.min(50, (Math.abs(value) / max) * 50) : 0;
  const colour = favourable === undefined ? 'var(--ff-text-tertiary)' : favourable ? 'var(--ff-fav)' : 'var(--ff-unfav)';
  const side = value >= 0 ? { left: '50%' } : { right: '50%' };
  return (
    <div className="relative h-4 w-full" aria-hidden="true">
      <span className="absolute left-1/2 top-0 bottom-0 w-px bg-[var(--ff-border-secondary)]" />
      <span className="absolute top-0.5 h-3" style={{ ...side, width: `${pct}%`, background: colour }} />
    </div>
  );
}
```

```tsx
// src/components/accounting/statement/StatementRowView.tsx
import type { ReactNode } from 'react';
import { formatMoney, formatPct } from '@/lib/format/money';
import type { StatementColumns, StatementRow } from './statementModel';
import { VarianceBar } from './VarianceBar';
import { Sparkline } from './Sparkline';

const KIND_CLASS: Record<StatementRow['kind'], string> = {
  section: 'text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)]',
  line: 'text-[var(--ff-text-secondary)]',
  subtotal: 'font-semibold border-t border-[var(--ff-text-primary)]',
  total: 'font-semibold border-t border-[var(--ff-text-primary)]',
  grand: 'font-bold border-t border-[var(--ff-text-primary)] [border-bottom:3px_double_var(--ff-text-primary)]',
};

const FIG = 'text-right whitespace-nowrap [font-family:var(--ff-fig-font)] tabular-nums';

export function StatementRowView({ row, columns, maxVariance, cents, expanded, onToggle, drill }: {
  row: StatementRow; columns: StatementColumns; maxVariance: number; cents: boolean;
  expanded: boolean; onToggle?: (code: string) => void; drill?: ReactNode;
}) {
  const isSection = row.kind === 'section';
  const pad = row.depth === 1 ? 'pl-8' : 'pl-3';
  const label = row.kind === 'line' && onToggle ? (
    <button type="button" onClick={() => onToggle(row.accountCode!)} aria-expanded={expanded}
      className="text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)]">
      <span className="font-mono text-xs text-[var(--ff-text-tertiary)] mr-2">{row.accountCode}</span>{row.label}
    </button>
  ) : row.label;
  const colSpan = 2 + (columns.prior ? 1 : 0) + (columns.variance ? 2 : 0) + (columns.trend ? 1 : 0);
  return (
    <>
      <tr data-kind={row.kind} className={`${KIND_CLASS[row.kind]} text-sm`}>
        <td className={`${pad} py-1.5`}>{label}</td>
        <td className={`${FIG} py-1.5 pr-3`}>{isSection ? '' : formatMoney(row.actual, { cents })}</td>
        {columns.prior && <td className={`${FIG} py-1.5 pr-3 text-[var(--ff-text-tertiary)]`}>{isSection || row.prior === undefined ? '' : formatMoney(row.prior, { cents })}</td>}
        {columns.variance && (
          <>
            <td className="w-36 px-2">{!isSection && row.variance !== undefined && <VarianceBar value={row.variance} max={maxVariance} favourable={row.favourable} />}</td>
            <td className={`${FIG} py-1.5 pr-3 text-xs`} style={{ color: row.favourable === undefined ? undefined : row.favourable ? 'var(--ff-fav)' : 'var(--ff-unfav)' }}>
              {!isSection && row.variancePct !== undefined ? formatPct(row.variancePct) : ''}
            </td>
          </>
        )}
        {columns.trend && <td className="px-2 text-[var(--ff-text-secondary)]">{row.trend && <Sparkline points={row.trend} />}</td>}
      </tr>
      {expanded && drill && <tr data-kind="drill"><td colSpan={colSpan} className="p-0">{drill}</td></tr>}
    </>
  );
}
```

```tsx
// src/components/accounting/statement/StatementGrid.tsx
/**
 * The one statement renderer. Renders StatementRow[] and nothing else: it
 * does not add, subtract or derive. Adapters (incomeStatementRows,
 * balanceSheetRows) own the mapping from service output to rows.
 */
import type { ReactNode } from 'react';
import type { StatementColumns, StatementRow } from './statementModel';
import { StatementRowView } from './StatementRowView';

export interface StatementGridProps {
  rows: StatementRow[];
  columns: StatementColumns;
  title?: string;
  expandedAccount?: string | null;
  onToggleAccount?: (code: string) => void;
  renderDrill?: (accountCode: string) => ReactNode;
  cents?: boolean;
}

export function StatementGrid({ rows, columns, title, expandedAccount, onToggleAccount, renderDrill, cents = false }: StatementGridProps) {
  const maxVariance = rows.reduce((m, r) => (r.kind === 'line' && r.variance !== undefined ? Math.max(m, Math.abs(r.variance)) : m), 0);
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-secondary)]">
            <th className="text-left pl-3 py-2 font-medium">{title ?? ''}</th>
            <th className="text-right pr-3 py-2 font-medium">Actual</th>
            {columns.prior && <th className="text-right pr-3 py-2 font-medium">Prior</th>}
            {columns.variance && <><th className="py-2 font-medium">Variance</th><th className="text-right pr-3 py-2 font-medium">Δ%</th></>}
            {columns.trend && <th className="py-2 font-medium">12 mo</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <StatementRowView key={row.id} row={row} columns={columns} maxVariance={maxVariance} cents={cents}
              expanded={row.accountCode !== undefined && row.accountCode === expandedAccount}
              onToggle={onToggleAccount}
              drill={row.accountCode && renderDrill ? renderDrill(row.accountCode) : undefined} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Run test, expect PASS (6 tests). Run `bun run type-check`. Commit.**

```bash
git add src/components/accounting/statement/ tests/unit/components/statement/StatementGrid.test.tsx package.json bun.lock
git commit -m "feat(reporting): StatementGrid renderer with variance bar and sparkline"
```

---

### Task 5: `KpiTile`

**Files:**
- Create: `src/components/accounting/kpi/KpiTile.tsx`
- Test: `tests/unit/components/statement/KpiTile.test.tsx`

**Interfaces:**
- Consumes: `formatMoney`, `formatPct`, `Sparkline`.
- Produces:

```tsx
export interface KpiTileProps {
  label: string;
  value: number;
  kind: 'money' | 'pct' | 'ratio';
  comparator?: { label: string; value: number };   // e.g. { label: 'vs budget', value: 4500000 }
  deltaPct?: number;                                 // signed; colour uses favourable
  favourable?: boolean;
  trend?: number[];
  note?: string;
}
export function KpiTile(props: KpiTileProps): JSX.Element
```

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/statement/KpiTile.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KpiTile } from '@/components/accounting/kpi/KpiTile';

describe('KpiTile', () => {
  it('formats money, pct and ratio by kind', () => {
    const { rerender } = render(<KpiTile label="Revenue" value={4812345} kind="money" />);
    expect(screen.getByText('R 4 812 345')).toBeTruthy();
    rerender(<KpiTile label="GP%" value={54.49} kind="pct" />);
    expect(screen.getByText('54.5%')).toBeTruthy();
    rerender(<KpiTile label="Current ratio" value={1.847} kind="ratio" />);
    expect(screen.getByText('1.85')).toBeTruthy();
  });
  it('shows the comparator and a signed delta coloured by favourability', () => {
    render(<KpiTile label="Revenue" value={4812345} kind="money" comparator={{ label: 'vs budget', value: 4500000 }} deltaPct={6.94} favourable />);
    expect(screen.getByText(/vs budget/)).toBeTruthy();
    expect(screen.getByText('R 4 500 000')).toBeTruthy();
    const delta = screen.getByText('+6.9%');
    expect(delta.getAttribute('data-fav')).toBe('true');
  });
  it('renders without comparator, delta or trend', () => {
    const { container } = render(<KpiTile label="Cash" value={0} kind="money" />);
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText('–')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL (module not found).**

- [ ] **Step 3: Implement**

```tsx
// src/components/accounting/kpi/KpiTile.tsx
/**
 * The one KPI tile. Replaces KpiCard (management-accounts) and KPICard
 * (executive-dashboard). Value, comparator, signed delta, optional sparkline.
 * Colour is semantic only: favourable / unfavourable.
 */
import { formatMoney, formatPct } from '@/lib/format/money';
import { Sparkline } from '@/components/accounting/statement/Sparkline';

export interface KpiTileProps {
  label: string;
  value: number;
  kind: 'money' | 'pct' | 'ratio';
  comparator?: { label: string; value: number };
  deltaPct?: number;
  favourable?: boolean;
  trend?: number[];
  note?: string;
}

function fmt(v: number, kind: KpiTileProps['kind']): string {
  if (kind === 'money') return formatMoney(v, { symbol: true });
  if (kind === 'pct') return `${v.toFixed(1)}%`;
  return v.toFixed(2);
}

export function KpiTile({ label, value, kind, comparator, deltaPct, favourable, trend, note }: KpiTileProps) {
  const deltaColour = favourable === undefined ? 'var(--ff-text-tertiary)' : favourable ? 'var(--ff-fav)' : 'var(--ff-unfav)';
  return (
    <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4 flex flex-col gap-2">
      <span className="text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)]">{label}</span>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-2xl font-semibold [font-family:var(--ff-fig-font)] tabular-nums text-[var(--ff-text-primary)]">{fmt(value, kind)}</span>
        {deltaPct !== undefined && (
          <span data-fav={favourable === undefined ? undefined : String(favourable)}
            className="text-sm [font-family:var(--ff-fig-font)] tabular-nums" style={{ color: deltaColour }}>{formatPct(deltaPct)}</span>
        )}
      </div>
      {(comparator || trend) && (
        <div className="flex items-center justify-between gap-3 text-xs text-[var(--ff-text-tertiary)]">
          {comparator && <span>{comparator.label} <span className="[font-family:var(--ff-fig-font)] tabular-nums">{fmt(comparator.value, kind)}</span></span>}
          {trend && trend.length > 1 && <span className="text-[var(--ff-text-secondary)]"><Sparkline points={trend} /></span>}
        </div>
      )}
      {note && <span className="text-xs text-[var(--ff-text-secondary)]">{note}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Run, expect PASS (3 tests). Commit.**

```bash
git add src/components/accounting/kpi/KpiTile.tsx tests/unit/components/statement/KpiTile.test.tsx
git commit -m "feat(reporting): KpiTile"
```

---

### Task 6: Migrate the income statement page

**Files:**
- Modify: `src/components/accounting/IncomeStatementSections.tsx` (keep the export and its props; replace the body from the opening `<div className="divide-y ...">` through the Net Profit block with a `StatementGrid`; keep the `subtypeDisclosure` notice and the margin stats blocks below it unchanged)
- Test: existing `tests/unit/services/reports/incomeStatementRenderSurfaces.test.ts` (unchanged) must stay green.

**Interfaces:**
- Consumes: `toIncomeStatementRows`, `StatementGrid`, existing `AccountDrillDown({ accountCode, periodStart, periodEnd, asTableRow, colSpan })`.

- [ ] **Step 1: Run the existing test first, confirm it passes on the old body**

Run: `npx vitest run tests/unit/services/reports/incomeStatementRenderSurfaces.test.ts`
Expected: PASS.

- [ ] **Step 2: Replace the body**

Keep the signature. New body of `IncomeStatementSections`:

```tsx
  const rows = toIncomeStatementRows(report, { comparative: showComparative });
  return (
    <div>
      <StatementGrid
        rows={rows}
        columns={{ prior: showComparative, variance: showComparative, trend: false }}
        title="Statement of Comprehensive Income"
        expandedAccount={expandedAccount}
        onToggleAccount={onToggleAccount}
        cents
        renderDrill={code => (
          <AccountDrillDown accountCode={code} periodStart={periodStart} periodEnd={periodEnd} asTableRow={false} />
        )}
      />
      {/* subtypeDisclosure block: unchanged */}
      {/* margin stats block: unchanged */}
    </div>
  );
```

Delete the local `Section` component and its `bg-${color}` classes. Remove now-unused imports (`ChevronDown`, `ChevronRight`, `formatCurrency` if no longer referenced; the margin stats still use `toFixed`, and the disclosure line still uses `formatCurrency`, so check before removing). `onEvidence` stays in the props (the page passes it) even if unused here; leave a one-line comment that the evidence button now lives in `AccountDrillDown` in a later workstream, and prefix the param with `_` to satisfy lint.

- [ ] **Step 3: Run the existing test again**

Run: `npx vitest run tests/unit/services/reports/incomeStatementRenderSurfaces.test.ts`
Expected: PASS. The test checks labels and digit substrings; `formatMoney(..., { cents: true })` keeps the digits, so `digits(r.operatingProfit)` still matches. If a label assertion fails, the adapter's label is wrong, not the test.

- [ ] **Step 4: Browser proof**

Start the dev server from THIS worktree (port from `bun run dev`; do not touch another session's server). Log in, open `/accounting/reports/income-statement`, toggle "Compare prior", click an account to expand the drill. Save a screenshot to `docs/superpowers/plans/screenshots/2026-09-ws0-income-statement.png`.

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/IncomeStatementSections.tsx docs/superpowers/plans/screenshots/2026-09-ws0-income-statement.png
git commit -m "feat(reporting): income statement renders through StatementGrid"
```

---

### Task 7: Migrate the balance sheet page

**Files:**
- Modify: `pages/accounting/reports/balance-sheet.tsx` (lines ~205–275: the two-column assets / liabilities-and-equity blocks)
- Test: `tests/unit/services/reports/balanceSheetRows.test.ts` already covers the adapter; add a render test only if the page body is extracted (see note).

**Interfaces:**
- Consumes: `toBalanceSheetRows`, `StatementGrid`, existing `BalanceSheetRow` props (`rowProps`, `expandedAccount`) which become `expandedAccount`/`onToggleAccount`/`renderDrill`.

- [ ] **Step 1: Replace the two blocks**

```tsx
const { assets, liabilitiesAndEquity } = toBalanceSheetRows(report, { comparative: showComparative });
const columns = { prior: showComparative, variance: showComparative, trend: false };
const drill = (code: string) => <AccountDrillDown accountCode={code} periodStart={fiscalYearStart} periodEnd={asAtDate} asTableRow={false} />;
...
<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
  <StatementGrid rows={assets} columns={columns} title="Assets" cents expandedAccount={expandedAccount} onToggleAccount={toggleAccount} renderDrill={drill} />
  <StatementGrid rows={liabilitiesAndEquity} columns={columns} title="Liabilities and Equity" cents expandedAccount={expandedAccount} onToggleAccount={toggleAccount} renderDrill={drill} />
</div>
```

`fiscalYearStart`: the page already computes the drill window for `BalanceSheetRow`; reuse whatever it passes today (read `rowProps`). Keep the balanced / out-of-balance banner exactly as is; it reads service totals. Delete `BalanceSheetRow` and `compHeader` if nothing else uses them.

- [ ] **Step 2: Type-check, browser proof, commit**

Run: `bun run type-check`. Open `/accounting/reports/balance-sheet`, compare on, expand an account. Screenshot to `docs/superpowers/plans/screenshots/2026-09-ws0-balance-sheet.png`.

```bash
git add pages/accounting/reports/balance-sheet.tsx docs/superpowers/plans/screenshots/2026-09-ws0-balance-sheet.png
git commit -m "feat(reporting): balance sheet renders through StatementGrid"
```

Note: the page is over 280 lines. If the edit pushes it past 300, extract the body from the `report ?` branch into `src/components/accounting/BalanceSheetBody.tsx` in this same task.

---

### Task 8: Migrate management accounts and report packs

**Files:**
- Modify: `src/components/accounting/ManagementPandLRows.tsx` (keep export and `{ is }` prop)
- Modify: `pages/accounting/reports/management-accounts.tsx` (delete `KpiCard`, use `KpiTile`)
- Modify: `pages/accounting/reports/report-packs.tsx` (`income_statement` and `balance_sheet` branches of `SectionCard`)
- Test: existing render-surfaces test (ManagementPandLRows part) stays green.

- [ ] **Step 1: `ManagementPandLRows`**

The pack gives this component a `Record<string, number>` of totals, not line items. Build rows from the totals and render the grid:

```tsx
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import type { StatementRow } from '@/components/accounting/statement/statementModel';

export function ManagementPandLRows({ is }: { is: Record<string, number> | undefined }) {
  const n = (k: string) => is?.[k] ?? 0;
  const rows: StatementRow[] = [
    { id: 'sub:revenue', kind: 'subtotal', label: 'Turnover', depth: 0, actual: n('totalRevenue') },
    { id: 'sub:costOfSales', kind: 'line', label: 'Cost of Sales', depth: 0, actual: n('totalCostOfSales') },
    { id: 'total:grossProfit', kind: 'total', label: 'Gross Profit', depth: 0, actual: n('grossProfit') },
    ...(n('totalOtherIncome') !== 0 ? [{ id: 'sub:otherIncome', kind: 'line' as const, label: 'Other Income', depth: 0 as const, actual: n('totalOtherIncome') }] : []),
    { id: 'sub:operatingExpenses', kind: 'line', label: 'Operating Expenses', depth: 0, actual: n('totalOperatingExpenses') },
    { id: 'total:operatingProfit', kind: 'total', label: 'Operating Profit', depth: 0, actual: n('operatingProfit') },
    ...(n('totalOtherExpenses') !== 0 ? [{ id: 'sub:otherExpenses', kind: 'line' as const, label: 'Other Expenses', depth: 0 as const, actual: n('totalOtherExpenses') }] : []),
    { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit', depth: 0, actual: n('netProfit') },
  ];
  return <StatementGrid rows={rows} columns={{ prior: false, variance: false, trend: false }} cents />;
}
```

Keep `KVRow` exported (other code may import it; grep first, delete only if unused).

- [ ] **Step 2: `management-accounts.tsx` KPI row**

Delete `KpiCard`. Replace each usage with `KpiTile`, for example:

```tsx
<KpiTile label="Revenue" value={report.kpis.revenue} kind="money" />
<KpiTile label="Gross profit" value={report.kpis.grossProfit} kind="money" note={`${report.kpis.grossProfitPct.toFixed(1)}% margin`} />
<KpiTile label="Net profit" value={report.kpis.netProfit} kind="money" note={`${report.kpis.netProfitPct.toFixed(1)}% margin`} />
<KpiTile label="Cash" value={report.kpis.cashPosition} kind="money" />
```

- [ ] **Step 3: `report-packs.tsx`**

In `SectionCard`, replace the `income_statement` branch's seven `KVItem`s with `<ManagementPandLRows is={d as Record<string, number>} />` wrapped in `<div className="col-span-3">`. The pack's `income_statement` section data keys are `revenue`, `costOfSales`, `grossProfit`, `operatingExpenses`, `netProfit` (see `reportPackService`), not the `totalRevenue` keys `ManagementPandLRows` reads. Add a four-line mapper in `report-packs.tsx`:

```tsx
const packToTotals = (d: Record<string, unknown>): Record<string, number> => ({
  totalRevenue: Number(d.revenue ?? 0), totalCostOfSales: Number(d.costOfSales ?? 0), grossProfit: Number(d.grossProfit ?? 0),
  totalOtherIncome: Number(d.otherIncome ?? 0), totalOperatingExpenses: Number(d.operatingExpenses ?? 0),
  operatingProfit: Number(d.operatingProfit ?? 0), totalOtherExpenses: Number(d.otherExpenses ?? 0), netProfit: Number(d.netProfit ?? 0),
});
```

Check `reportPackService.ts` for the exact keys of the `income_statement` section before writing this; if `operatingProfit` is absent from the section data, add it to the section builder in `reportPackService.ts` (it is already on `ReportPackInput`). Replace the `balance_sheet` branch's `KVItem`s with a small `StatementGrid` of `subtotal` rows for Total Assets, Total Liabilities, Total Equity, and a `grand` row for Total Liabilities and Equity whose `actual` is `Number(d.totalLiabilities) + Number(d.totalEquity)` (same derived-figure exception as Task 3, comment it).

- [ ] **Step 4: Tests, type-check, browser proof, commit**

Run: `npx vitest run tests/unit/services/reports/incomeStatementRenderSurfaces.test.ts` (PASS) and `bun run type-check`. Open `/accounting/reports/management-accounts` and `/accounting/reports/report-packs` (generate a Management pack). Screenshots to `docs/superpowers/plans/screenshots/2026-09-ws0-management-accounts.png` and `...-report-packs.png`.

```bash
git add src/components/accounting/ManagementPandLRows.tsx pages/accounting/reports/management-accounts.tsx pages/accounting/reports/report-packs.tsx src/modules/accounting/services/reports/reportPackService.ts docs/superpowers/plans/screenshots/
git commit -m "feat(reporting): management accounts and packs render through StatementGrid and KpiTile"
```

---

### Task 9: Migrate the AFS statements tab and the executive dashboard tiles

**Files:**
- Modify: `src/components/accounting/afs/AfsStatementsTab.tsx` (keep `IncomeStatementBlock({ report, periodStart, periodEnd })` and `AfsStatementsTab` exports; replace `ISSection`, `BSSection`, `AccountRow`, `BalanceSheetBlock` bodies)
- Modify: `pages/accounting/reports/executive-dashboard.tsx` (delete `KPICard`, use `KpiTile`)
- Test: existing render-surfaces test, AFS section, stays green.

- [ ] **Step 1: `IncomeStatementBlock`**

```tsx
export function IncomeStatementBlock({ report, periodStart, periodEnd }: { report: IncomeStatementReport; periodStart: string; periodEnd: string }) {
  const rows = toIncomeStatementRows(report, { comparative: false });
  return (
    <section>
      <h3 className="text-sm font-bold uppercase tracking-wide mb-1 text-[var(--ff-text-primary)]">Statement of Comprehensive Income</h3>
      <p className="text-xs text-[var(--ff-text-tertiary)] mb-3">{periodStart} to {periodEnd}</p>
      <StatementGrid rows={rows} columns={{ prior: false, variance: false, trend: false }} cents />
    </section>
  );
}
```

The heading changes from "Income Statement (Profit & Loss)" to the IFRS for SMEs name. The existing test asserts band labels, not the heading. `BalanceSheetBlock` becomes the same shape with `toBalanceSheetRows` and the heading "Statement of Financial Position", two grids stacked (not side by side; the AFS tab is narrower).

- [ ] **Step 2: `executive-dashboard.tsx`**

Delete `KPICard` and `fmt`. Replace usages:

```tsx
<KpiTile label="Revenue" value={summary.kpis.revenue} kind="money" deltaPct={summary.kpis.revenueGrowth} favourable={summary.kpis.revenueGrowth >= 0} />
<KpiTile label="Net profit" value={summary.kpis.netProfit} kind="money" deltaPct={summary.kpis.profitGrowth} favourable={summary.kpis.profitGrowth >= 0} />
<KpiTile label="Gross margin" value={summary.kpis.grossProfitMargin} kind="pct" />
<KpiTile label="Net margin" value={summary.kpis.netProfitMargin} kind="pct" />
```

Do the same for the cash-position tiles (`kind="money"`) and ratio tiles (`kind="ratio"`). Recharts on this page stays; WS1 replaces it.

- [ ] **Step 3: Tests, type-check, browser proof, commit**

Run the render-surfaces test and `bun run type-check`. Open an AFS document's Statements tab and `/accounting/reports/executive-dashboard`. Screenshots `...-afs-statements.png`, `...-executive-dashboard.png`.

```bash
git add src/components/accounting/afs/AfsStatementsTab.tsx pages/accounting/reports/executive-dashboard.tsx docs/superpowers/plans/screenshots/
git commit -m "feat(reporting): AFS statements and executive dashboard on StatementGrid and KpiTile"
```

---

### Task 10: Footing integration test against real tenants

**Files:**
- Create: `tests/integration/statement-grid-foots.int.test.ts`

**Interfaces:**
- Consumes: `getIncomeStatement(companyId, start, end)`, `getBalanceSheet(companyId, asAt)` from the services; `toIncomeStatementRows`, `toBalanceSheetRows`; `renderToStaticMarkup` of `IncomeStatementBlock`.

This test is NOT the skip-when-no-DB kind. Without `DATABASE_URL` it must FAIL with a clear message, so it cannot score a pass by skipping. It runs under `bun run test:integration` on the lead's machine against `isaflow_dev`, which is a copy of production data for these two companies.

- [ ] **Step 1: Write the test**

```ts
// tests/integration/statement-grid-foots.int.test.ts
/**
 * The grid foots. For two real tenants, every figure the grid renders is a
 * figure the service returned, and the statement reconciles top to bottom.
 * Deliberately fails (not skips) without DATABASE_URL: a footing test that can
 * pass by not running is not a footing test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { toIncomeStatementRows } from '@/components/accounting/statement/incomeStatementRows';
import { toBalanceSheetRows } from '@/components/accounting/statement/balanceSheetRows';
import { IncomeStatementBlock } from '@/components/accounting/afs/AfsStatementsTab';

const TENANTS = [
  { name: 'Britech (Brightsphere)', id: 'd27bac33-0000-0000-0000-000000000000' }, // replace with the full id from project memory
  { name: 'Velocity Fibre', id: '<velocity company_id>' },
];
const PERIOD = { start: '2026-03-01', end: '2026-08-31' };

beforeAll(() => {
  if (!process.env.DATABASE_URL) throw new Error('statement-grid-foots requires DATABASE_URL; it does not skip');
});

const numbersIn = (v: unknown, out = new Set<number>()): Set<number> => {
  if (typeof v === 'number') out.add(Math.round(v * 100));
  else if (Array.isArray(v)) v.forEach(x => numbersIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => numbersIn(x, out));
  return out;
};

describe.each(TENANTS)('$name', ({ id }) => {
  it('income statement: every grid figure is a service figure, and the statement reconciles', async () => {
    const r = await getIncomeStatement(id, PERIOD.start, PERIOD.end, { comparePeriod: true } as never);
    const service = numbersIn(r);
    for (const row of toIncomeStatementRows(r, { comparative: true })) {
      expect(service, row.label).toContain(Math.round(row.actual * 100));
      if (row.prior !== undefined) expect(service, `${row.label} prior`).toContain(Math.round(row.prior * 100));
    }
    expect(r.totalRevenue - r.totalCostOfSales).toBeCloseTo(r.grossProfit, 2);
    expect(r.grossProfit + r.totalOtherIncome - r.totalOperatingExpenses).toBeCloseTo(r.operatingProfit, 2);
    expect(r.operatingProfit - r.totalOtherExpenses).toBeCloseTo(r.netProfit, 2);
    const html = renderToStaticMarkup(IncomeStatementBlock({ report: r, periodStart: PERIOD.start, periodEnd: PERIOD.end }) as never);
    expect(html.replace(/[^0-9]/g, '')).toContain(Math.abs(r.netProfit).toFixed(2).replace('.', ''));
  });

  it('balance sheet: grid figures are service figures and A = L + E', async () => {
    const r = await getBalanceSheet(id, PERIOD.end);
    const service = numbersIn(r);
    const { assets, liabilitiesAndEquity } = toBalanceSheetRows(r, { comparative: false });
    for (const row of [...assets, ...liabilitiesAndEquity]) {
      if (row.id === 'grand:totalLiabilitiesAndEquity') continue; // the one derived figure
      expect(service, row.label).toContain(Math.round(row.actual * 100));
    }
    expect(r.totalAssets).toBeCloseTo(r.totalLiabilities + r.totalEquity, 2);
  });
});
```

Look up the two company ids with `psql "$DATABASE_URL" -c "select id, name from companies where name ilike '%bright%' or name ilike '%velocity%'"` and paste them in. Check `getIncomeStatement`'s options type for the comparative flag name and replace the `as never` cast with the real option.

- [ ] **Step 2: Run it**

Run: `DATABASE_URL=<isaflow_dev url> npx vitest run --config vitest.integration.config.ts tests/integration/statement-grid-foots.int.test.ts`
Expected: PASS for both tenants. If A ≠ L + E for a tenant, that is a ledger finding, not a grid bug: record the difference in the PR and do not loosen the assertion.

Run without the env var: expected FAIL with the "requires DATABASE_URL" message.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/statement-grid-foots.int.test.ts
git commit -m "test(reporting): StatementGrid foots against Britech and Velocity"
```

---

### Task 11: CI, blind review, PR

- [ ] **Step 1:** `bun run ci` in the worktree. Fix anything red. Note: the CI build clobbers `.next` of a dev server running in the same tree; stop your dev server first.
- [ ] **Step 2:** Mutation evidence. In the PR description, paste the command and red output for: (a) reordering Other Income in `incomeStatementRows.ts`, (b) changing `formatMoney` to emit a minus sign. Revert both.
- [ ] **Step 3:** Push with `timeout 420 git push -u origin feat/reporting-ws0-foundation`. Open the PR with the five screenshots embedded and the footing test output pasted.
- [ ] **Step 4:** Run `/review` (blind). Fix every HIGH, MEDIUM and LOW. Re-run `bun run ci`.
- [ ] **Step 5:** Hand to the programme lead for merge. Do not merge yourself.

---

## Parallel mini-plan: WS-E ECharts wrapper (no grid dependency)

Branch `feat/reporting-ws-echarts`, own worktree, `coder` (sonnet). Ships as its own PR; nothing in WS0 imports it.

**Files:** `src/lib/charts/echarts.ts` (registry), `src/lib/charts/theme.ts`, `src/components/charts/EChart.tsx`, `tests/unit/lib/charts/theme.test.ts`.

- [ ] `bun add echarts` (pin the version the lockfile resolves). No `echarts-for-react`; the wrapper is 40 lines and avoids a dependency that lags ECharts majors.
- [ ] `echarts.ts`: `import * as echarts from 'echarts/core'`, register only `BarChart, LineChart, CustomChart, SankeyChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, SVGRenderer, CanvasRenderer`; export `echarts`.
- [ ] `theme.ts`: `buildTheme(getVar: (name: string) => string)` reads `--ff-text-primary`, `--ff-text-tertiary`, `--ff-border-light`, `--ff-fav`, `--ff-unfav`, `--ff-prior`, `--ff-plan`, `--ff-fig-font` and returns an ECharts theme object with `textStyle.fontFamily`, axis line/label colours, and a `color` palette of exactly `[ink, prior, plan]` so actual/prior/plan map to IBCS fills by series order. Test: given a stub `getVar`, the theme's `color[0]` is the ink value and `textStyle.fontFamily` is the figure font.
- [ ] `EChart.tsx`: `({ option, height = 280, renderer = 'canvas' })`, `useRef` + `useEffect` init/dispose, `ResizeObserver` resize, re-`setOption` on `option` change with `notMerge: true`. Registers the theme once per document by reading `getComputedStyle(document.documentElement)`. Exported through `dynamic(() => import(...), { ssr: false })` from a sibling `EChartClient.ts` so pages never import ECharts on the server.
- [ ] Prove it: temporarily render `<EChart option={{ xAxis: { type: 'category', data: ['a','b'] }, yAxis: {}, series: [{ type: 'bar', data: [1,2] }] }} />` on `/accounting/reports/executive-dashboard`, screenshot, then remove the temporary render before the PR. Bundle check: `bun run build` and confirm the echarts chunk is under 450 KB gzipped in the build output.

## Parallel mini-plan: WS-P Playwright PDF pipeline (no grid dependency)

Branch `feat/reporting-ws-pdf`, own worktree, `coder` (sonnet). Decision pending from Hein: Chromium on the host vs Gotenberg in Docker (programme doc). Until decided, build against Playwright's bundled Chromium in dev and expose the renderer behind one interface so the transport can change:

**Files:** `src/lib/pdf/renderPagePdf.ts`, `src/lib/pdf/printAuth.ts`, `styles/print.css`, `tests/unit/lib/pdf/printAuth.test.ts`.

- [ ] `printAuth.ts`: `mintPrintToken(companyId, userId, path, ttlSeconds = 120)` and `verifyPrintToken(token)`, HMAC over `company_id|user_id|path|exp` with a `PRINT_TOKEN_SECRET` env var; single use is not required (2-minute TTL). Test: round-trips, rejects expired, rejects a token for another path.
- [ ] `renderPagePdf.ts`: `renderPagePdf({ companyId, userId, path, landscape?: boolean }): Promise<Buffer>` launches Chromium, sets a cookie or header the middleware accepts (`withAuth` must honour the print token: add a narrow branch that resolves user + company from a valid print token when the request path matches the token's path; this is the only auth change, and it gets the adversarial reviewer), navigates to `${APP_URL}${path}?print=1`, waits for `[data-print-ready="true"]`, calls `page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' }, displayHeaderFooter: true, footerTemplate: '<div style="font-size:9px;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' })`.
- [ ] `print.css`: `@media print` rules that hide `AppLayout` chrome, force light tokens, break before `[data-print-break]`, keep `tr` unsplit. Pages opt in by setting `data-print-ready` once their data has loaded.
- [ ] Prove it: a one-off script `scripts/pdf/try-render.ts` that renders `/accounting/reports/management-accounts` for the demo company to `scratch/management-accounts.pdf`; attach the PDF to the PR.

## Self-review

- Spec coverage: five surfaces (Tasks 6–9), KpiTile replacing both cards (8, 9), formatter (1), footing gate (10), screenshots (6–9), blind review (11). WS-E and WS-P parallel per grill decision 2. Benchmarking absent per decision 4.
- Types: `StatementRow`, `StatementColumns` defined in Task 2 and used unchanged in 3, 4, 8, 9, 10. `toBalanceSheetRows` returns `{ assets, liabilitiesAndEquity }` in 3, 7, 9, 10. `KpiTileProps.kind` values match in 5, 8, 9.
- Placeholders: the two company ids in Task 10 and the `getIncomeStatement` comparative option name are look-ups the implementer performs with the commands given; they are not TBDs.
