# Reporting WS1: Charts and Presentation Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An IBCS chart set on the merged ECharts wrapper (profit waterfall, cash-flow sankey, budget bullet row, 12-month small multiples, cash position), the trend and budget columns of `StatementRow` actually populated from services, an owner/accountant density toggle, and a chrome-free keyboard-paged presentation route for report packs.

**Architecture:** Every chart is two files: a **pure option builder** (`buildXOption(data, palette) → EChartsCoreOption`, plain `.ts`, no React, no DOM) and a thin component that fetches nothing, resolves the palette from the `--ff-*` tokens through WS-E's `buildTheme`, and hands the option to `EChartClient`. The builders are where the IBCS rules live and where the tests bite. Statement trend and budget columns are populated by pure adapters in `statementRows/` fed by two services, exactly as `prior` already is — the grid still computes nothing. Presentation mode is a separate route that composes the same components with no `AppLayout`.

**Tech Stack:** Next.js 14 Pages Router · React 18 · TypeScript strict · Apache ECharts 5 through `@/lib/charts/echarts` (already registered: Bar, Line, Custom, Sankey, Grid, Tooltip, Legend, DataZoom, MarkLine, SVG + Canvas renderers) · Tailwind + `--ff-*` tokens · Vitest node config for builders, `vitest.components.config.ts` (happy-dom) for components · Postgres via `sql` from `@/lib/neon`.

**Spec:** `docs/superpowers/plans/2026-09-05-reporting-programme.md` (its Global Constraints apply to every task here). Foundation contract: `docs/superpowers/plans/2026-09-05-reporting-phase1-foundation.md`.

## Global Constraints

- **No new dependencies.** ECharts, React, Tailwind and Vitest are already installed. If a chart seems to need a package, it needs a different chart.
- **The grid and the charts compute nothing.** Every figure a chart or a row shows is a field a service returned. The one derivation allowed anywhere in this workstream is a waterfall bar's *geometry* (`placeholder = min(start, end)`, `height = |end − start|`), which is layout, not a figure — and the label printed on that bar is `step.value` from the service, never the geometry.
- **IBCS notation, enforced in `ibcs.ts` and nowhere else:** actual = solid ink, prior = light grey (`--ff-prior`), budget = outline (transparent fill, ink border), forecast = hatched (ECharts `decal`). `--ff-fav` / `--ff-unfav` appear **only** on a variance mark. A category is never coloured by its name.
- **Same unit, same scale per page.** Small multiples share one explicit `min`/`max` across every panel. No axis is truncated: every value axis domain includes 0.
- **Every chart type gets a unit test on its option-building function**, and each such test must be mutation-sensitive. Each chart task ends by naming one production mutation that turns the new test red, and running it.
- **Browser proof per page** on the dev server (`bun run dev`, port 3200) with the QA login `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` read from the worktree `.env.local`. Never print, echo or paste those values; never commit them. Attach the screenshot to the PR.
- **Repo rules:** max 300 lines per file, no `any`, `log` from `@/lib/logger` never `console`, `company_id` on every query, `withAuth(withErrorHandler(...))` on every route, `apiResponse.*` for every response, `IF NOT EXISTS` on any DDL (this plan adds none).
- **Branch:** `feat/reporting-ws1-charts`, its own worktree. Stage by explicit path. No `git add -A`. No `git stash`. Commit after every task; `bun run type-check` before each commit, `bun run ci` before the PR.
- **File ownership.** This workstream may only create or modify the files in the File Structure below. A change anywhere else — including `IncomeStatementSections.tsx`, `income-statement.tsx`, `balance-sheet.tsx` and `report-packs.tsx` — is a request to that file's owner, listed at the bottom of this plan. Do not commit it.

---

## File Structure

Owned by this workstream:

```
src/components/accounting/charts/
  chartTypes.ts            ChartPalette, DEFAULT_PALETTE, paletteFromTheme
  ibcs.ts                  SeriesRole → itemStyle; varianceColor; axisDomain
  ChartFrame.tsx           title + unit note + palette resolution + EChartClient
  waterfallOption.ts       buildWaterfallOption(steps, palette, opts)
  ProfitWaterfall.tsx
  sankeyOption.ts          buildCashFlowSankeyOption(report, palette), canRenderSankey
  CashFlowSankey.tsx
  bulletOption.ts          buildBudgetBulletOption(lines, palette, opts)
  BudgetBulletRow.tsx
  smallMultiplesOption.ts  buildSmallMultiplesOption(panels, palette, opts)
  SmallMultiples.tsx
  cashPositionOption.ts    buildCashPositionOption(points, palette)
  CashPositionChart.tsx

src/components/accounting/reportControls/        (ownership request #1)
  useDensity.ts            'owner' | 'accountant', localStorage + /api/auth/preferences
  DensityToggle.tsx
  ComparatorControls.tsx   prior / budget / trend checkboxes → StatementColumns

src/components/accounting/present/
  presentSlides.ts         ReportPack sections → Slide[] (pure)
  PresentDeck.tsx          full-screen, keyboard-paged shell
  PresentSlide.tsx         slide kind → grid or chart
pages/accounting/reports/present/[pack].tsx

src/modules/accounting/services/reports/
  trendRowsService.ts      getMonthlyMovements, getMonthlyBalances (DB)
  statementRows/
    comparators.ts         applyTrend, applyBudgetComparator (pure, additive)

pages/api/accounting/                            (ownership request #2)
  reports-account-trends.ts
  reports-budget-comparator.ts

pages/accounting/reports/executive-dashboard.tsx  (modified: Recharts → ECharts, density)

tests/unit/services/reports/charts/ibcs.test.ts
tests/unit/services/reports/charts/waterfallOption.test.ts
tests/unit/services/reports/charts/sankeyOption.test.ts
tests/unit/services/reports/charts/bulletOption.test.ts
tests/unit/services/reports/charts/smallMultiplesOption.test.ts
tests/unit/services/reports/charts/cashPositionOption.test.ts
tests/unit/services/reports/statementComparators.test.ts
tests/unit/services/reports/presentSlides.test.ts
tests/unit/components/charts/ChartFrame.test.tsx
tests/unit/components/charts/PresentDeck.test.tsx
tests/unit/components/charts/DensityToggle.test.tsx
tests/unit/components/charts/ComparatorControls.test.tsx
tests/integration/accountTrends.int.test.ts
```

Read but never modified: `src/lib/charts/theme.ts`, `src/lib/charts/echarts.ts`, `src/components/charts/EChart*.tsx`, `src/components/accounting/statement/**`, `src/lib/format/money.ts`, `src/modules/accounting/services/reports/waterfallDataService.ts`, `budgetVarianceService.ts`, `trendAnalysisService.ts`.

**Test placement rule.** `vitest.config.ts` includes `tests/unit/**/*.test.ts` and runs in the **node** environment; `vitest.components.config.ts` includes `tests/unit/components/**/*.test.{ts,tsx}` in **happy-dom**. Option builders are `.ts` with no JSX so they run under the node config. Anything importing a `.tsx` component goes under `tests/unit/components/` with a `.test.tsx` extension. `bun run ci` runs both.

---

### Task 1: Palette and IBCS series styling

The one place a role becomes ink. Everything downstream imports from here, so it is written and tested first.

**Files:**
- Create: `src/components/accounting/charts/chartTypes.ts`
- Create: `src/components/accounting/charts/ibcs.ts`
- Test: `tests/unit/services/reports/charts/ibcs.test.ts`

**Interfaces:**
- Consumes: `buildTheme(getVar) → EChartsTheme` from `@/lib/charts/theme` (its `color` is `[ink, prior, plan]`, plus `favColor`, `unfavColor`, `textStyle.fontFamily`, `categoryAxis.axisLabel.color`, `categoryAxis.axisLine.lineStyle.color`).
- Produces:
  - `interface ChartPalette { ink; prior; plan; fav; unfav; figFont; axisLine; axisLabel }` — all `string`.
  - `const DEFAULT_PALETTE: ChartPalette` (SSR / test fixture).
  - `paletteFromTheme(theme: EChartsTheme): ChartPalette`.
  - `type SeriesRole = 'actual' | 'prior' | 'budget' | 'forecast'`.
  - `roleStyle(role: SeriesRole, palette: ChartPalette): RoleStyle` where `interface RoleStyle { color: string; borderColor?: string; borderWidth?: number; decal?: { symbol: string; dashArrayX: number[]; dashArrayY: number[]; rotation: number; color: string } }`.
  - `varianceColor(favourable: boolean | undefined, palette: ChartPalette): string | undefined`.
  - `axisDomain(values: number[]): { min: number; max: number }` — always includes 0, with 8% headroom.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/reports/charts/ibcs.test.ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_PALETTE, paletteFromTheme } from '@/components/accounting/charts/chartTypes';
import { roleStyle, varianceColor, axisDomain } from '@/components/accounting/charts/ibcs';
import { buildTheme } from '@/lib/charts/theme';

const P = DEFAULT_PALETTE;

describe('roleStyle', () => {
  it('draws actual as solid ink with no border', () => {
    const s = roleStyle('actual', P);
    expect(s.color).toBe(P.ink);
    expect(s.borderWidth ?? 0).toBe(0);
    expect(s.decal).toBeUndefined();
  });

  it('draws prior in the light grey token, never in ink', () => {
    const s = roleStyle('prior', P);
    expect(s.color).toBe(P.prior);
    expect(s.color).not.toBe(P.ink);
  });

  it('draws budget as an outline: transparent fill, ink border', () => {
    const s = roleStyle('budget', P);
    expect(s.color).toBe('transparent');
    expect(s.borderColor).toBe(P.ink);
    expect(s.borderWidth).toBeGreaterThan(0);
  });

  it('draws forecast hatched', () => {
    const s = roleStyle('forecast', P);
    expect(s.decal).toBeDefined();
    expect(s.decal?.rotation).toBeCloseTo(-Math.PI / 4);
  });

  it('never returns the favourable or unfavourable colour for a role', () => {
    for (const role of ['actual', 'prior', 'budget', 'forecast'] as const) {
      const s = roleStyle(role, P);
      expect([s.color, s.borderColor]).not.toContain(P.fav);
      expect([s.color, s.borderColor]).not.toContain(P.unfav);
    }
  });
});

describe('varianceColor', () => {
  it('is the only place green and red are issued', () => {
    expect(varianceColor(true, P)).toBe(P.fav);
    expect(varianceColor(false, P)).toBe(P.unfav);
  });
  it('leaves an unknown polarity uncoloured rather than guessing', () => {
    expect(varianceColor(undefined, P)).toBeUndefined();
  });
});

describe('axisDomain', () => {
  it('always includes zero, so no bar is drawn on a truncated axis', () => {
    expect(axisDomain([100, 120, 140]).min).toBe(0);
    expect(axisDomain([-40, -10]).max).toBe(0);
  });
  it('spans both signs when the data does', () => {
    const d = axisDomain([-50, 200]);
    expect(d.min).toBeLessThan(-50);
    expect(d.max).toBeGreaterThan(200);
  });
  it('gives a flat all-zero series a usable domain instead of min === max', () => {
    const d = axisDomain([0, 0, 0]);
    expect(d.max).toBeGreaterThan(d.min);
  });
});

describe('paletteFromTheme', () => {
  it('takes ink, prior and plan from the theme colour order, not by index guess', () => {
    const theme = buildTheme(() => '');
    const p = paletteFromTheme(theme);
    expect(p.ink).toBe(theme.color[0]);
    expect(p.prior).toBe(theme.color[1]);
    expect(p.plan).toBe(theme.color[2]);
    expect(p.fav).toBe(theme.favColor);
    expect(p.unfav).toBe(theme.unfavColor);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/ibcs.test.ts`
Expected: FAIL, cannot resolve `@/components/accounting/charts/chartTypes`.

- [ ] **Step 3: Implement `chartTypes.ts`**

```ts
// src/components/accounting/charts/chartTypes.ts
/**
 * The colours a chart is allowed to use, resolved once per page from the
 * `--ff-*` tokens through WS-E's `buildTheme`.
 *
 * Option builders take a palette as an ARGUMENT rather than reading
 * `document` themselves: that is what makes them pure, testable under the
 * node vitest config, and safe to call during SSR.
 */
import type { EChartsTheme } from '@/lib/charts/theme';

export interface ChartPalette {
  ink: string;
  prior: string;
  plan: string;
  fav: string;
  unfav: string;
  figFont: string;
  axisLine: string;
  axisLabel: string;
}

/** Used during SSR and in tests. Same values as the theme's own fallbacks. */
export const DEFAULT_PALETTE: ChartPalette = {
  ink: '#15202b',
  prior: '#c9d0cc',
  plan: '#8a94a0',
  fav: '#1f7a4d',
  unfav: '#b23a3a',
  figFont: 'ui-monospace, monospace',
  axisLine: '#e5e7eb',
  axisLabel: '#9ca3af',
};

export function paletteFromTheme(theme: EChartsTheme): ChartPalette {
  return {
    ink: theme.color[0],
    prior: theme.color[1],
    plan: theme.color[2],
    fav: theme.favColor,
    unfav: theme.unfavColor,
    figFont: theme.textStyle.fontFamily,
    axisLine: theme.categoryAxis.axisLine.lineStyle.color,
    axisLabel: theme.categoryAxis.axisLabel.color,
  };
}
```

- [ ] **Step 4: Implement `ibcs.ts`**

```ts
// src/components/accounting/charts/ibcs.ts
/**
 * IBCS notation, in one file.
 *
 * The rule this file exists to enforce: a series is styled by its ROLE
 * (actual / prior / budget / forecast), never by its category name, and
 * green and red are issued only by `varianceColor` — so a reader can tell
 * a favourable variance from a category that happens to be called "cash".
 */
import type { ChartPalette } from './chartTypes';

export type SeriesRole = 'actual' | 'prior' | 'budget' | 'forecast';

export interface RoleStyle {
  color: string;
  borderColor?: string;
  borderWidth?: number;
  decal?: {
    symbol: string;
    dashArrayX: number[];
    dashArrayY: number[];
    rotation: number;
    color: string;
  };
}

export function roleStyle(role: SeriesRole, palette: ChartPalette): RoleStyle {
  switch (role) {
    case 'actual':
      return { color: palette.ink, borderWidth: 0 };
    case 'prior':
      return { color: palette.prior, borderWidth: 0 };
    case 'budget':
      // Outline: the plan is a reference the actual is read against, so it
      // must not carry ink weight of its own.
      return { color: 'transparent', borderColor: palette.ink, borderWidth: 1.5 };
    case 'forecast':
      return {
        color: 'transparent',
        borderColor: palette.plan,
        borderWidth: 1,
        decal: {
          symbol: 'rect',
          dashArrayX: [1, 0],
          dashArrayY: [2, 5],
          rotation: -Math.PI / 4,
          color: palette.plan,
        },
      };
  }
}

export function varianceColor(
  favourable: boolean | undefined,
  palette: ChartPalette,
): string | undefined {
  if (favourable === undefined) return undefined;
  return favourable ? palette.fav : palette.unfav;
}

/**
 * A value-axis domain that always contains zero and never truncates. A bar
 * chart whose axis starts at 90% of the smallest bar makes a 2% movement
 * look like a collapse; IBCS forbids it and so does this function.
 */
export function axisDomain(values: number[]): { min: number; max: number } {
  const finite = values.filter(Number.isFinite);
  const lo = Math.min(0, ...finite);
  const hi = Math.max(0, ...finite);
  const span = hi - lo;
  if (span === 0) return { min: lo === 0 ? 0 : lo * 1.08, max: hi === 0 ? 1 : hi * 1.08 };
  const pad = span * 0.08;
  return { min: lo === 0 ? 0 : lo - pad, max: hi === 0 ? 0 : hi + pad };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/ibcs.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Prove the test bites**

Change `case 'budget'` to return `{ color: palette.ink }`. Re-run: the outline test fails. Revert.

- [ ] **Step 7: Commit**

```bash
cd <worktree>
git add src/components/accounting/charts/chartTypes.ts src/components/accounting/charts/ibcs.ts tests/unit/services/reports/charts/ibcs.test.ts
git commit -m "feat(charts): IBCS role styling and a palette resolved from the ff tokens"
```

---

### Task 2: `ChartFrame` — palette resolution and the unit note

Every chart on a page shares one palette and one unit statement. `ChartFrame` is the only component that touches `document`.

**Files:**
- Create: `src/components/accounting/charts/ChartFrame.tsx`
- Test: `tests/unit/components/charts/ChartFrame.test.tsx`

**Interfaces:**
- Consumes: `DEFAULT_PALETTE`, `paletteFromTheme` (Task 1); `buildTheme` from `@/lib/charts/theme`; `EChartClient` from `@/components/charts/EChartClient`.
- Produces:
  - `useChartPalette(): ChartPalette` — `DEFAULT_PALETTE` on the server and first paint, token-resolved after mount.
  - `<ChartFrame title unit height? renderer? children />` where `children: (palette: ChartPalette) => EChartsCoreOption | null`. A `null` option renders the `unavailable` message instead of a chart.
  - `ChartFrameProps { title: string; unit: string; height?: number; renderer?: 'canvas' | 'svg'; unavailable?: string; children: (p: ChartPalette) => EChartsCoreOption | null }`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/charts/ChartFrame.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChartFrame } from '@/components/accounting/charts/ChartFrame';

vi.mock('@/components/charts/EChartClient', () => ({
  EChartClient: ({ option }: { option: Record<string, unknown> }) => (
    <div data-testid="echart" data-option={JSON.stringify(option)} />
  ),
}));

afterEach(cleanup);

describe('ChartFrame', () => {
  it('states the unit next to the title, so a reader never guesses the scale', () => {
    render(
      <ChartFrame title="Profit bridge" unit="Rand, period to date">
        {() => ({ series: [] })}
      </ChartFrame>,
    );
    expect(screen.getByText('Profit bridge')).toBeTruthy();
    expect(screen.getByText('Rand, period to date')).toBeTruthy();
  });

  it('passes a palette to the builder and renders what it returns', () => {
    render(
      <ChartFrame title="T" unit="Rand">
        {(p) => ({ series: [{ type: 'bar', itemStyle: { color: p.ink } }] })}
      </ChartFrame>,
    );
    const opt = JSON.parse(screen.getByTestId('echart').getAttribute('data-option') ?? '{}');
    expect(opt.series[0].itemStyle.color).toBeTruthy();
  });

  it('states the condition instead of drawing an empty chart when the builder returns null', () => {
    render(
      <ChartFrame title="T" unit="Rand" unavailable="Opening cash is negative; a flow diagram would misstate it.">
        {() => null}
      </ChartFrame>,
    );
    expect(screen.queryByTestId('echart')).toBeNull();
    expect(screen.getByText(/Opening cash is negative/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run --config vitest.components.config.ts tests/unit/components/charts/ChartFrame.test.tsx`
Expected: FAIL, cannot resolve `ChartFrame`.

- [ ] **Step 3: Implement**

```tsx
// src/components/accounting/charts/ChartFrame.tsx
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { EChartClient } from '@/components/charts/EChartClient';
import { buildTheme } from '@/lib/charts/theme';
import { DEFAULT_PALETTE, paletteFromTheme, type ChartPalette } from './chartTypes';

/**
 * The palette, resolved once after mount. `DEFAULT_PALETTE` is returned on
 * the server and for the first client paint so the markup matches and React
 * does not warn about a hydration mismatch.
 */
export function useChartPalette(): ChartPalette {
  const [resolved, setResolved] = useState<ChartPalette | null>(null);
  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    setResolved(paletteFromTheme(buildTheme((name) => styles.getPropertyValue(name).trim())));
  }, []);
  return resolved ?? DEFAULT_PALETTE;
}

export interface ChartFrameProps {
  title: string;
  /** The unit and basis, stated in words. IBCS requires it and a reader who
   *  has to guess whether a bar is thousands or millions will guess wrong. */
  unit: string;
  height?: number;
  renderer?: 'canvas' | 'svg';
  /** Shown in place of the chart when the builder returns null. */
  unavailable?: string;
  children: (palette: ChartPalette) => EChartsCoreOption | null;
}

export function ChartFrame({
  title, unit, height = 280, renderer = 'canvas', unavailable, children,
}: ChartFrameProps): ReactElement {
  const palette = useChartPalette();
  const option = useMemo(() => children(palette), [children, palette]);

  return (
    <figure className="m-0 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-5">
      <figcaption className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">{title}</h2>
        <span className="text-xs text-[var(--ff-text-tertiary)]">{unit}</span>
      </figcaption>
      {option === null ? (
        <p className="py-8 text-center text-sm text-[var(--ff-text-secondary)]">
          {unavailable ?? 'Not meaningful for this period.'}
        </p>
      ) : (
        <EChartClient option={option} height={height} renderer={renderer} />
      )}
    </figure>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd <worktree> && npx vitest run --config vitest.components.config.ts tests/unit/components/charts/ChartFrame.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Prove the test bites**

Delete the `<span>{unit}</span>` line. Re-run: the unit test fails. Restore it.

- [ ] **Step 6: Commit**

```bash
cd <worktree>
git add src/components/accounting/charts/ChartFrame.tsx tests/unit/components/charts/ChartFrame.test.tsx
git commit -m "feat(charts): ChartFrame resolves the palette and states the unit"
```

---

### Task 3: Profit waterfall

**Files:**
- Create: `src/components/accounting/charts/waterfallOption.ts`
- Create: `src/components/accounting/charts/ProfitWaterfall.tsx`
- Test: `tests/unit/services/reports/charts/waterfallOption.test.ts`

**Interfaces:**
- Consumes: `WaterfallStep { label; start; end; value; isSubtotal; color }` from `@/modules/accounting/services/reports/waterfallDataService` (the API `GET /api/accounting/reports-waterfall?type=profit&from&to` returns `{ steps }`); `roleStyle`, `varianceColor`, `axisDomain` (Task 1); `formatMoney` from `@/lib/format/money`.
- Produces:
  - `buildWaterfallOption(steps: WaterfallStep[], palette: ChartPalette, opts?: { cents?: boolean }): EChartsCoreOption`.
  - `<ProfitWaterfall steps title? unit? />`.

The `color` field on `WaterfallStep` is **ignored**. It is a legacy `'green' | 'red' | 'blue' | 'teal'` hint that colours a category by its name, which IBCS forbids. Movements take ink; subtotals take ink at full opacity with a rule; the direction is already carried by the bar's position.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/reports/charts/waterfallOption.test.ts
import { describe, it, expect } from 'vitest';
import { buildProfitWaterfall } from '@/modules/accounting/services/reports/waterfallDataService';
import { buildWaterfallOption } from '@/components/accounting/charts/waterfallOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const STEPS = buildProfitWaterfall({
  revenue: 1_000_000,
  costOfSales: 400_000,
  grossProfit: 600_000,
  operatingExpenses: 250_000,
  otherIncome: 0,
  otherExpenses: 0,
  netProfit: 350_000,
});

type Series = { name?: string; type: string; stack?: string; data: unknown[] };
const seriesOf = (o: Record<string, unknown>) => o['series'] as Series[];
const catAxis = (o: Record<string, unknown>) => o['xAxis'] as { data: string[] };
const valAxis = (o: Record<string, unknown>) => o['yAxis'] as { min: number; max: number };

describe('buildWaterfallOption', () => {
  const opt = buildWaterfallOption(STEPS, DEFAULT_PALETTE) as unknown as Record<string, unknown>;

  it('draws one bar per service step, in service order', () => {
    expect(catAxis(opt).data).toEqual(STEPS.map((s) => s.label));
  });

  it('carries the service value on the bar, never a value it derived', () => {
    const bars = seriesOf(opt).find((s) => s.name === 'bar')!;
    const values = (bars.data as Array<{ value: number }>).map((d) => d.value);
    expect(values).toEqual(STEPS.map((s) => Math.abs(s.end - s.start)));
    // and the LABEL is the service figure, not the geometry
    const labels = (bars.data as Array<{ figure: number }>).map((d) => d.figure);
    expect(labels).toEqual(STEPS.map((s) => s.value));
  });

  it('offsets each movement with a transparent placeholder at min(start, end)', () => {
    const pad = seriesOf(opt).find((s) => s.name === 'placeholder')!;
    expect(pad.data).toEqual(STEPS.map((s) => Math.min(s.start, s.end)));
    expect(pad.stack).toBe(seriesOf(opt).find((s) => s.name === 'bar')!.stack);
  });

  it('never colours a bar by the step name hint', () => {
    const bars = seriesOf(opt).find((s) => s.name === 'bar')!;
    const colours = new Set(
      (bars.data as Array<{ itemStyle: { color: string } }>).map((d) => d.itemStyle.color),
    );
    expect(colours.has(DEFAULT_PALETTE.fav)).toBe(false);
    expect(colours.has(DEFAULT_PALETTE.unfav)).toBe(false);
  });

  it('anchors the value axis at zero', () => {
    expect(valAxis(opt).min).toBe(0);
  });

  it('renders an empty step list as an empty chart rather than throwing', () => {
    const empty = buildWaterfallOption([], DEFAULT_PALETTE) as unknown as Record<string, unknown>;
    expect(catAxis(empty).data).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/waterfallOption.test.ts`
Expected: FAIL, cannot resolve `waterfallOption`.

- [ ] **Step 3: Implement the builder**

```ts
// src/components/accounting/charts/waterfallOption.ts
/**
 * Profit bridge. ECharts has no waterfall series, so the standard shape is
 * used: a transparent placeholder bar stacked under a visible one.
 *
 * The placeholder height is GEOMETRY (`min(start, end)`) and the bar height
 * is `|end − start|`; the number PRINTED on the bar is `step.value`, which is
 * the service's own signed figure. That separation is the whole reason this
 * builder is allowed to do arithmetic at all.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { axisDomain, roleStyle } from './ibcs';

const STACK = 'bridge';

export function buildWaterfallOption(
  steps: WaterfallStep[],
  palette: ChartPalette,
  opts: { cents?: boolean } = {},
): EChartsCoreOption {
  const actual = roleStyle('actual', palette);
  const bars = steps.map((s) => ({
    value: Math.abs(s.end - s.start),
    figure: s.value,
    itemStyle: s.isSubtotal
      ? { color: actual.color, borderColor: actual.color, borderWidth: 0 }
      : { color: actual.color, opacity: 0.72 },
  }));

  return {
    grid: { left: 8, right: 8, top: 28, bottom: 24, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: (p: { dataIndex: number }) => {
        const s = steps[p.dataIndex];
        return s ? `${s.label}<br/>${formatMoney(s.value, { cents: opts.cents, symbol: true })}` : '';
      },
    },
    xAxis: {
      type: 'category',
      data: steps.map((s) => s.label),
      axisLabel: { color: palette.axisLabel, interval: 0, hideOverlap: true },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: {
      type: 'value',
      ...axisDomain(steps.flatMap((s) => [s.start, s.end])),
      axisLabel: { color: palette.axisLabel, formatter: (v: number) => formatMoney(v) },
      splitLine: { lineStyle: { color: palette.axisLine } },
    },
    series: [
      {
        name: 'placeholder',
        type: 'bar',
        stack: STACK,
        silent: true,
        itemStyle: { color: 'transparent' },
        emphasis: { itemStyle: { color: 'transparent' } },
        data: steps.map((s) => Math.min(s.start, s.end)),
      },
      {
        name: 'bar',
        type: 'bar',
        stack: STACK,
        data: bars,
        label: {
          show: true,
          position: 'top',
          color: palette.ink,
          fontFamily: palette.figFont,
          fontSize: 10,
          formatter: (p: { data: { figure: number } }) =>
            formatMoney(p.data.figure, { cents: opts.cents }),
        },
      },
    ],
  };
}
```

- [ ] **Step 4: Implement the component**

```tsx
// src/components/accounting/charts/ProfitWaterfall.tsx
import { useCallback } from 'react';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildWaterfallOption } from './waterfallOption';

export function ProfitWaterfall({
  steps, title = 'Profit bridge', unit = 'Rand, selected period', height = 300,
}: { steps: WaterfallStep[]; title?: string; unit?: string; height?: number }) {
  const build = useCallback(
    (p: ChartPalette) => (steps.length === 0 ? null : buildWaterfallOption(steps, p)),
    [steps],
  );
  return (
    <ChartFrame title={title} unit={unit} height={height} unavailable="Nothing posted in this period.">
      {build}
    </ChartFrame>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/waterfallOption.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Prove the test bites**

Change the label formatter to use `p.data.value` instead of `p.data.figure`, and the `figure` field to `Math.abs(s.value)`. Re-run: the "carries the service value" test fails on the Cost of Sales step, whose `value` is negative. Revert.

- [ ] **Step 7: Commit**

```bash
cd <worktree>
git add src/components/accounting/charts/waterfallOption.ts src/components/accounting/charts/ProfitWaterfall.tsx tests/unit/services/reports/charts/waterfallOption.test.ts
git commit -m "feat(charts): profit bridge on ECharts, bar geometry separated from the printed figure"
```

---

### Task 4: Cash-flow sankey

**Files:**
- Create: `src/components/accounting/charts/sankeyOption.ts`
- Create: `src/components/accounting/charts/CashFlowSankey.tsx`
- Test: `tests/unit/services/reports/charts/sankeyOption.test.ts`

**Interfaces:**
- Consumes: the report from `GET /api/accounting/reports-cash-flow`, shape
  `CashFlowReport { period_start: string; period_end: string; opening_cash: number; sections: Array<{ section: string; items: Array<{ label: string; amount: number }>; total: number }>; net_change: number; closing_cash: number }`.
  Declare this interface in `sankeyOption.ts` and export it — no other file owns it.
- Produces:
  - `canRenderSankey(report: CashFlowReport): boolean`.
  - `buildCashFlowSankeyOption(report: CashFlowReport, palette: ChartPalette): EChartsCoreOption`.
  - `<CashFlowSankey report />`.

A sankey link value must be positive. Opening cash and every positive item flow **into** a central `Cash` node; every negative item and the closing balance flow **out** of it. A negative opening or closing balance cannot be drawn as a flow, so `canRenderSankey` returns false and the component states that rather than drawing a diagram that misstates the position.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/reports/charts/sankeyOption.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildCashFlowSankeyOption, canRenderSankey, type CashFlowReport,
} from '@/components/accounting/charts/sankeyOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const REPORT: CashFlowReport = {
  period_start: '2026-01-01',
  period_end: '2026-08-31',
  opening_cash: 200_000,
  sections: [
    { section: 'Operating Activities', total: 130_000, items: [
      { label: 'Net Income', amount: 180_000 },
      { label: 'Change in Accounts Receivable', amount: -70_000 },
      { label: 'Change in Accounts Payable', amount: 20_000 },
    ] },
    { section: 'Investing Activities', total: -50_000, items: [
      { label: 'Fixed Asset Changes', amount: -50_000 },
    ] },
    { section: 'Financing Activities', total: 0, items: [
      { label: 'Equity Changes', amount: 0 },
    ] },
  ],
  net_change: 80_000,
  closing_cash: 280_000,
};

type Link = { source: string; target: string; value: number };
const linksOf = (o: Record<string, unknown>) =>
  ((o['series'] as Array<{ links: Link[] }>)[0]!).links;
const nodesOf = (o: Record<string, unknown>) =>
  ((o['series'] as Array<{ data: Array<{ name: string }> }>)[0]!).data;

describe('buildCashFlowSankeyOption', () => {
  const opt = buildCashFlowSankeyOption(REPORT, DEFAULT_PALETTE) as unknown as Record<string, unknown>;

  it('balances: everything into Cash equals everything out of it', () => {
    const links = linksOf(opt);
    const into = links.filter((l) => l.target === 'Cash').reduce((s, l) => s + l.value, 0);
    const outOf = links.filter((l) => l.source === 'Cash').reduce((s, l) => s + l.value, 0);
    expect(into).toBeCloseTo(outOf, 2);
  });

  it('opens with the opening balance and closes with the closing balance', () => {
    const links = linksOf(opt);
    expect(links.find((l) => l.source === 'Opening cash')?.value).toBe(200_000);
    expect(links.find((l) => l.target === 'Closing cash')?.value).toBe(280_000);
  });

  it('sends outflows out of Cash as positive magnitudes', () => {
    const ar = linksOf(opt).find((l) => l.target === 'Change in Accounts Receivable');
    expect(ar?.source).toBe('Cash');
    expect(ar?.value).toBe(70_000);
  });

  it('drops zero-amount items rather than drawing a zero-width ribbon', () => {
    expect(nodesOf(opt).map((n) => n.name)).not.toContain('Equity Changes');
  });

  it('never uses the favourable or unfavourable colour', () => {
    const json = JSON.stringify(opt);
    expect(json).not.toContain(DEFAULT_PALETTE.fav);
    expect(json).not.toContain(DEFAULT_PALETTE.unfav);
  });
});

describe('canRenderSankey', () => {
  it('accepts a period with positive opening and closing balances', () => {
    expect(canRenderSankey(REPORT)).toBe(true);
  });
  it('refuses an overdrawn closing balance instead of misdrawing it', () => {
    expect(canRenderSankey({ ...REPORT, closing_cash: -10_000 })).toBe(false);
  });
  it('refuses an overdrawn opening balance', () => {
    expect(canRenderSankey({ ...REPORT, opening_cash: -1 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/sankeyOption.test.ts`
Expected: FAIL, cannot resolve `sankeyOption`.

- [ ] **Step 3: Implement the builder**

```ts
// src/components/accounting/charts/sankeyOption.ts
/**
 * Where the cash came from and where it went, as flows through one node.
 *
 * Every ribbon is a figure from the cash-flow report; nothing here nets,
 * re-signs or reclassifies. Outflows are drawn as positive magnitudes
 * leaving `Cash` because a sankey link value cannot be negative — the
 * DIRECTION carries the sign, which is also how a reader reads it.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { roleStyle } from './ibcs';

export interface CashFlowReport {
  period_start: string;
  period_end: string;
  opening_cash: number;
  sections: Array<{ section: string; items: Array<{ label: string; amount: number }>; total: number }>;
  net_change: number;
  closing_cash: number;
}

const CASH = 'Cash';
const OPENING = 'Opening cash';
const CLOSING = 'Closing cash';

export function canRenderSankey(report: CashFlowReport): boolean {
  return report.opening_cash >= 0 && report.closing_cash >= 0;
}

export function buildCashFlowSankeyOption(
  report: CashFlowReport,
  palette: ChartPalette,
): EChartsCoreOption {
  const links: Array<{ source: string; target: string; value: number }> = [];
  const names = new Set<string>([CASH]);

  if (report.opening_cash > 0) {
    links.push({ source: OPENING, target: CASH, value: report.opening_cash });
    names.add(OPENING);
  }

  for (const section of report.sections) {
    for (const item of section.items) {
      if (item.amount === 0) continue;
      names.add(item.label);
      if (item.amount > 0) links.push({ source: item.label, target: CASH, value: item.amount });
      else links.push({ source: CASH, target: item.label, value: -item.amount });
    }
  }

  if (report.closing_cash > 0) {
    links.push({ source: CASH, target: CLOSING, value: report.closing_cash });
    names.add(CLOSING);
  }

  const actual = roleStyle('actual', palette);
  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: { name: string; value: number }) =>
        `${p.name}<br/>${formatMoney(p.value, { symbol: true })}`,
    },
    series: [
      {
        type: 'sankey',
        data: [...names].map((name) => ({ name, itemStyle: { color: actual.color } })),
        links,
        emphasis: { focus: 'adjacency' },
        label: { color: palette.axisLabel, fontFamily: palette.figFont, fontSize: 11 },
        lineStyle: { color: 'source', opacity: 0.28 },
      },
    ],
  };
}
```

Note the balance property this shape gives for free: inflows plus opening equal outflows plus closing by construction of the report, so the "into Cash equals out of Cash" test is a real check on the report, not on the builder's arithmetic.

- [ ] **Step 4: Implement the component**

```tsx
// src/components/accounting/charts/CashFlowSankey.tsx
import { useCallback } from 'react';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildCashFlowSankeyOption, canRenderSankey, type CashFlowReport } from './sankeyOption';

export function CashFlowSankey({
  report, height = 340,
}: { report: CashFlowReport; height?: number }) {
  const build = useCallback(
    (p: ChartPalette) => (canRenderSankey(report) ? buildCashFlowSankeyOption(report, p) : null),
    [report],
  );
  return (
    <ChartFrame
      title="Cash flow"
      unit="Rand, selected period"
      height={height}
      unavailable="The cash balance is negative in this period, so the flows cannot be drawn without misstating the position. The statement below carries the figures."
    >
      {build}
    </ChartFrame>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/sankeyOption.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Prove the test bites**

Change the negative branch to `links.push({ source: item.label, target: CASH, value: item.amount })`. Re-run: the outflow-direction test and the balance test both fail. Revert.

- [ ] **Step 7: Commit**

```bash
cd <worktree>
git add src/components/accounting/charts/sankeyOption.ts src/components/accounting/charts/CashFlowSankey.tsx tests/unit/services/reports/charts/sankeyOption.test.ts
git commit -m "feat(charts): cash-flow sankey, refusing to draw an overdrawn balance"
```

---

### Task 5: Budget bullet row

**Files:**
- Create: `src/components/accounting/charts/bulletOption.ts`
- Create: `src/components/accounting/charts/BudgetBulletRow.tsx`
- Test: `tests/unit/services/reports/charts/bulletOption.test.ts`

**Interfaces:**
- Consumes: `BudgetVsActualLine { account_code; account_name; account_type; budget_amount; actual_amount; variance; variance_pct }` from `@/modules/accounting/services/reports/budgetVsActualLines`.
- Produces:
  - `buildBudgetBulletOption(lines: BudgetVsActualLine[], palette: ChartPalette, opts?: { limit?: number }): EChartsCoreOption`.
  - `<BudgetBulletRow lines limit? />`.

**The sign trap, pinned by a test.** `budgetVsActualLines.computeVariance` returns a **favourably signed** variance: for revenue it is `actual − budget`, for an expense it is `budget − actual`. So a positive `variance` always means *favourable* and never means *bigger than budget*. The bullet's variance colour comes from `variance >= 0`; the bar lengths come from `actual_amount` and `budget_amount` directly. Never subtract them here.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/reports/charts/bulletOption.test.ts
import { describe, it, expect } from 'vitest';
import { buildBudgetVsActualLines } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { buildBudgetBulletOption } from '@/components/accounting/charts/bulletOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const LINES = buildBudgetVsActualLines(
  [
    { id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 900_000 },
    { id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 130_000 },
  ],
  { '1000': 1_000_000, '6000': 120_000 },
);

type Series = { name?: string; type: string; data: unknown[]; itemStyle?: Record<string, unknown> };
const seriesOf = (o: Record<string, unknown>) => o['series'] as Series[];
const named = (o: Record<string, unknown>, n: string) => seriesOf(o).find((s) => s.name === n)!;

describe('buildBudgetBulletOption', () => {
  const opt = buildBudgetBulletOption(LINES, DEFAULT_PALETTE) as unknown as Record<string, unknown>;

  it('draws budget as an outline reference and actual as solid ink', () => {
    expect(named(opt, 'Budget').itemStyle?.['color']).toBe('transparent');
    expect(named(opt, 'Budget').itemStyle?.['borderColor']).toBe(DEFAULT_PALETTE.ink);
    expect(named(opt, 'Actual').itemStyle?.['color']).toBe(DEFAULT_PALETTE.ink);
  });

  it('takes both bar lengths straight from the service, never a difference', () => {
    expect(named(opt, 'Actual').data).toEqual([900_000, 130_000]);
    expect(named(opt, 'Budget').data).toEqual([1_000_000, 120_000]);
  });

  it('colours the variance label by the service polarity, not by which bar is longer', () => {
    const labels = named(opt, 'Actual').data;
    // Sales is UNDER budget on revenue → unfavourable, even though the actual
    // bar is shorter. Rent is OVER budget on an expense → also unfavourable,
    // and its actual bar is longer. Bar length cannot tell them apart.
    const marks = (opt['__varianceColours'] as string[]);
    expect(marks).toEqual([DEFAULT_PALETTE.unfav, DEFAULT_PALETTE.unfav]);
    expect(labels).toHaveLength(2);
  });

  it('marks a favourable line with the favourable colour', () => {
    const favLines = buildBudgetVsActualLines(
      [{ id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 1_100_000 }],
      { '1000': 1_000_000 },
    );
    const o = buildBudgetBulletOption(favLines, DEFAULT_PALETTE) as unknown as Record<string, unknown>;
    expect(o['__varianceColours']).toEqual([DEFAULT_PALETTE.fav]);
  });

  it('shows the largest absolute variances first and honours the limit', () => {
    const o = buildBudgetBulletOption(LINES, DEFAULT_PALETTE, { limit: 1 }) as unknown as Record<string, unknown>;
    expect((o['yAxis'] as { data: string[] }).data).toEqual(['Sales']);
  });

  it('anchors the value axis at zero', () => {
    expect((opt['xAxis'] as { min: number }).min).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/bulletOption.test.ts`
Expected: FAIL, cannot resolve `bulletOption`.

- [ ] **Step 3: Implement the builder**

```ts
// src/components/accounting/charts/bulletOption.ts
/**
 * Budget bullets: one horizontal row per account, the actual bar read
 * against the budget outline behind it.
 *
 * `BudgetVsActualLine.variance` is signed FAVOURABLY by the service — for
 * revenue it is actual − budget, for an expense it is budget − actual — so
 * `variance >= 0` means favourable in both directions and the length of the
 * two bars can never be used to work that out. `__varianceColours` is
 * exported on the option so the polarity decision is directly assertable.
 */
import type { EChartsCoreOption } from 'echarts/core';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { axisDomain, roleStyle, varianceColor } from './ibcs';

export function buildBudgetBulletOption(
  lines: BudgetVsActualLine[],
  palette: ChartPalette,
  opts: { limit?: number } = {},
): EChartsCoreOption {
  const ranked = [...lines]
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))
    .slice(0, opts.limit ?? 10);
  // ECharts draws a horizontal category axis bottom-up; reversing here puts
  // the largest variance at the TOP, which is where a reader looks first.
  const rows = [...ranked].reverse();

  const budget = roleStyle('budget', palette);
  const actual = roleStyle('actual', palette);
  const colours = ranked.map((l) => varianceColor(l.variance >= 0, palette) ?? palette.ink);

  return {
    __varianceColours: colours,
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: Array<{ dataIndex: number }>) => {
        const l = rows[params[0]?.dataIndex ?? 0];
        if (!l) return '';
        return [
          l.account_name,
          `Actual ${formatMoney(l.actual_amount, { symbol: true })}`,
          `Budget ${formatMoney(l.budget_amount, { symbol: true })}`,
          `Variance ${formatMoney(l.variance, { symbol: true })}`,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'value',
      ...axisDomain(rows.flatMap((l) => [l.actual_amount, l.budget_amount])),
      axisLabel: { color: palette.axisLabel, formatter: (v: number) => formatMoney(v) },
      splitLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: {
      type: 'category',
      data: ranked.map((l) => l.account_name),
      axisLabel: { color: palette.axisLabel },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    series: [
      {
        name: 'Budget',
        type: 'bar',
        barWidth: 18,
        itemStyle: { color: budget.color, borderColor: budget.borderColor, borderWidth: budget.borderWidth },
        data: rows.map((l) => l.budget_amount),
      },
      {
        name: 'Actual',
        type: 'bar',
        barWidth: 8,
        barGap: '-118%',
        itemStyle: { color: actual.color },
        data: rows.map((l) => l.actual_amount),
        label: {
          show: true,
          position: 'right',
          fontFamily: palette.figFont,
          fontSize: 10,
          formatter: (p: { dataIndex: number }) => {
            const l = rows[p.dataIndex];
            return l ? formatMoney(l.variance) : '';
          },
          color: (p: { dataIndex: number }) => {
            const l = rows[p.dataIndex];
            return l ? varianceColor(l.variance >= 0, palette) ?? palette.ink : palette.ink;
          },
        },
      },
    ],
  };
}
```

The `yAxis.data` uses `ranked` (largest first) while the series use `rows` (reversed) so ECharts' bottom-up category order puts the largest at the top. The `limit` test asserts `yAxis.data`, which is why it reads `['Sales']`.

- [ ] **Step 4: Implement the component**

```tsx
// src/components/accounting/charts/BudgetBulletRow.tsx
import { useCallback } from 'react';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildBudgetBulletOption } from './bulletOption';

export function BudgetBulletRow({
  lines, limit = 10, height,
}: { lines: BudgetVsActualLine[]; limit?: number; height?: number }) {
  const build = useCallback(
    (p: ChartPalette) => (lines.length === 0 ? null : buildBudgetBulletOption(lines, p, { limit })),
    [lines, limit],
  );
  return (
    <ChartFrame
      title="Budget variance"
      unit="Rand, selected period. Bar = actual, outline = budget."
      height={height ?? Math.max(160, Math.min(lines.length, limit) * 34 + 40)}
      unavailable="No account carries a budget for this period."
    >
      {build}
    </ChartFrame>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/bulletOption.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Prove the test bites**

Replace `varianceColor(l.variance >= 0, palette)` with `varianceColor(l.actual_amount >= l.budget_amount, palette)` — the "bigger bar is better" mistake. Re-run: the polarity test fails, because Rent then reads favourable. Revert.

- [ ] **Step 7: Commit**

```bash
cd <worktree>
git add src/components/accounting/charts/bulletOption.ts src/components/accounting/charts/BudgetBulletRow.tsx tests/unit/services/reports/charts/bulletOption.test.ts
git commit -m "feat(charts): budget bullets, polarity from the service not from bar length"
```

---

### Task 6: 12-month small multiples

**Files:**
- Create: `src/components/accounting/charts/smallMultiplesOption.ts`
- Create: `src/components/accounting/charts/SmallMultiples.tsx`
- Test: `tests/unit/services/reports/charts/smallMultiplesOption.test.ts`

**Interfaces:**
- Produces:
  - `interface TrendPanel { key: string; label: string; values: number[] }`.
  - `buildSmallMultiplesOption(panels: TrendPanel[], months: string[], palette: ChartPalette, opts?: { columns?: number }): EChartsCoreOption`.
  - `<SmallMultiples panels months columns? />`.

The defining rule: **one scale across every panel**. Each `yAxis` gets the same explicit `min` and `max`, computed once over every panel's values through `axisDomain`, so a panel with small numbers is visibly small rather than rescaled to look identical to a large one.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/reports/charts/smallMultiplesOption.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildSmallMultiplesOption, type TrendPanel,
} from '@/components/accounting/charts/smallMultiplesOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const MONTHS = ['2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];
const PANELS: TrendPanel[] = [
  { key: '1000', label: 'Sales', values: [100, 120, 90, 140, 130, 150, 160, 155, 170, 165, 180, 175].map(v => v * 1000) },
  { key: '6000', label: 'Rent', values: Array(12).fill(12000) },
];

const asRec = (o: unknown) => o as Record<string, unknown>;

describe('buildSmallMultiplesOption', () => {
  const opt = asRec(buildSmallMultiplesOption(PANELS, MONTHS, DEFAULT_PALETTE, { columns: 2 }));

  it('builds one grid, one x axis, one y axis and one series per panel', () => {
    for (const key of ['grid', 'xAxis', 'yAxis', 'series']) {
      expect((opt[key] as unknown[]).length).toBe(PANELS.length);
    }
  });

  it('gives every panel the SAME explicit scale', () => {
    const axes = opt['yAxis'] as Array<{ min: number; max: number }>;
    const first = axes[0]!;
    for (const a of axes) {
      expect(a.min).toBe(first.min);
      expect(a.max).toBe(first.max);
    }
    expect(Number.isFinite(first.min)).toBe(true);
    expect(Number.isFinite(first.max)).toBe(true);
  });

  it('never truncates: the shared scale contains zero', () => {
    expect((opt['yAxis'] as Array<{ min: number }>)[0]!.min).toBe(0);
  });

  it('plots the service values unchanged, in month order', () => {
    const series = opt['series'] as Array<{ data: number[] }>;
    expect(series[0]!.data).toEqual(PANELS[0]!.values);
    expect(series[1]!.data).toEqual(PANELS[1]!.values);
  });

  it('labels every panel with its account and every x axis with the same months', () => {
    const titles = (opt['title'] as Array<{ text: string }>).map((t) => t.text);
    expect(titles).toEqual(['Sales', 'Rent']);
    for (const x of opt['xAxis'] as Array<{ data: string[] }>) {
      expect(x.data).toEqual(MONTHS);
    }
  });

  it('draws every line in actual ink, never in the variance colours', () => {
    const json = JSON.stringify(opt);
    expect(json).not.toContain(DEFAULT_PALETTE.fav);
    expect(json).not.toContain(DEFAULT_PALETTE.unfav);
  });

  it('returns an option with no panels for an empty input rather than throwing', () => {
    const empty = asRec(buildSmallMultiplesOption([], MONTHS, DEFAULT_PALETTE));
    expect((empty['series'] as unknown[]).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/smallMultiplesOption.test.ts`
Expected: FAIL, cannot resolve `smallMultiplesOption`.

- [ ] **Step 3: Implement the builder**

```ts
// src/components/accounting/charts/smallMultiplesOption.ts
/**
 * Twelve months, one small panel per account, all on ONE scale.
 *
 * The shared scale is the point. Per-panel autoscaling makes a R12k rent
 * line and a R1.8m sales line look like the same business, which is the
 * single most common way a small-multiples grid lies.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { axisDomain, roleStyle } from './ibcs';

export interface TrendPanel {
  key: string;
  label: string;
  values: number[];
}

const ROW_HEIGHT_PCT = 34;

export function buildSmallMultiplesOption(
  panels: TrendPanel[],
  months: string[],
  palette: ChartPalette,
  opts: { columns?: number } = {},
): EChartsCoreOption {
  const columns = opts.columns ?? 3;
  const scale = axisDomain(panels.flatMap((p) => p.values));
  const actual = roleStyle('actual', palette);

  const grid = panels.map((_, i) => ({
    left: `${(i % columns) * (100 / columns) + 4}%`,
    top: `${Math.floor(i / columns) * (ROW_HEIGHT_PCT + 6) + 8}%`,
    width: `${100 / columns - 8}%`,
    height: `${ROW_HEIGHT_PCT}%`,
    containLabel: false,
  }));

  return {
    title: panels.map((p, i) => ({
      text: p.label,
      left: grid[i]!.left,
      top: `${Math.floor(i / columns) * (ROW_HEIGHT_PCT + 6) + 2}%`,
      textStyle: { fontSize: 11, color: palette.axisLabel, fontWeight: 'normal' as const },
    })),
    tooltip: {
      trigger: 'axis',
      formatter: (params: Array<{ name: string; value: number; seriesName: string }>) =>
        params
          .map((p) => `${p.seriesName} ${p.name}<br/>${formatMoney(p.value, { symbol: true })}`)
          .join('<br/>'),
    },
    xAxis: panels.map((_, i) => ({
      type: 'category' as const,
      gridIndex: i,
      data: months,
      axisLabel: { show: false },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: palette.axisLine } },
    })),
    yAxis: panels.map((_, i) => ({
      type: 'value' as const,
      gridIndex: i,
      min: scale.min,
      max: scale.max,
      axisLabel: { show: false },
      axisLine: { show: false },
      splitLine: { show: false },
    })),
    grid,
    series: panels.map((p, i) => ({
      name: p.label,
      type: 'line' as const,
      xAxisIndex: i,
      yAxisIndex: i,
      data: p.values,
      showSymbol: false,
      lineStyle: { color: actual.color, width: 1.5 },
      areaStyle: { color: actual.color, opacity: 0.08 },
    })),
  };
}
```

- [ ] **Step 4: Implement the component**

```tsx
// src/components/accounting/charts/SmallMultiples.tsx
import { useCallback } from 'react';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildSmallMultiplesOption, type TrendPanel } from './smallMultiplesOption';

export function SmallMultiples({
  panels, months, columns = 3, title = 'Twelve months by account',
}: { panels: TrendPanel[]; months: string[]; columns?: number; title?: string }) {
  const build = useCallback(
    (p: ChartPalette) =>
      panels.length === 0 ? null : buildSmallMultiplesOption(panels, months, p, { columns }),
    [panels, months, columns],
  );
  const rows = Math.ceil(panels.length / columns) || 1;
  return (
    <ChartFrame
      title={title}
      unit="Rand per month, all panels on one scale"
      height={rows * 130 + 40}
      unavailable="No account has twelve months of posted movement yet."
    >
      {build}
    </ChartFrame>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/smallMultiplesOption.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Prove the test bites**

Change the `yAxis` map to `axisDomain(panels[i]!.values)` — per-panel autoscaling. Re-run: the shared-scale test fails. Revert.

- [ ] **Step 7: Commit**

```bash
cd <worktree>
git add src/components/accounting/charts/smallMultiplesOption.ts src/components/accounting/charts/SmallMultiples.tsx tests/unit/services/reports/charts/smallMultiplesOption.test.ts
git commit -m "feat(charts): 12-month small multiples on one shared scale"
```

---

### Task 7: Cash position on ECharts, and Recharts off the executive dashboard

**Files:**
- Create: `src/components/accounting/charts/cashPositionOption.ts`
- Create: `src/components/accounting/charts/CashPositionChart.tsx`
- Modify: `pages/accounting/reports/executive-dashboard.tsx` (remove the seven `dynamic(() => import('recharts'))` lines and the `<ResponsiveContainer>` block, add `<CashPositionChart>`)
- Test: `tests/unit/services/reports/charts/cashPositionOption.test.ts`

**Interfaces:**
- Produces:
  - `interface CashPositionPoint { name: string; value: number }`.
  - `buildCashPositionOption(points: CashPositionPoint[], palette: ChartPalette): EChartsCoreOption`.
  - `<CashPositionChart points />`.

The existing Recharts block hard-codes `#14b8a6`, `#888` and `rgba(255,255,255,0.05)`, and its `tickFormatter` divides by 1000 and writes `K` — a scale change the axis title never states. Both go. The axis carries `formatMoney` output in full rand.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/reports/charts/cashPositionOption.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildCashPositionOption, type CashPositionPoint,
} from '@/components/accounting/charts/cashPositionOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const POINTS: CashPositionPoint[] = [
  { name: 'Cash', value: 480_000 },
  { name: 'AR', value: 1_250_000 },
  { name: 'AP', value: 690_000 },
  { name: 'NWC', value: 1_040_000 },
];

const asRec = (o: unknown) => o as Record<string, unknown>;

describe('buildCashPositionOption', () => {
  const opt = asRec(buildCashPositionOption(POINTS, DEFAULT_PALETTE));

  it('plots the values it was given, in order', () => {
    expect((opt['series'] as Array<{ data: number[] }>)[0]!.data).toEqual(POINTS.map((p) => p.value));
    expect((opt['xAxis'] as { data: string[] }).data).toEqual(['Cash', 'AR', 'AP', 'NWC']);
  });

  it('draws every bar in one ink, so no category is emphasised by colour', () => {
    expect((opt['series'] as Array<{ itemStyle: { color: string } }>)[0]!.itemStyle.color)
      .toBe(DEFAULT_PALETTE.ink);
  });

  it('anchors the axis at zero', () => {
    expect((opt['yAxis'] as { min: number }).min).toBe(0);
  });

  it('spans below zero when working capital is negative', () => {
    const neg = asRec(buildCashPositionOption([{ name: 'NWC', value: -300_000 }], DEFAULT_PALETTE));
    expect((neg['yAxis'] as { min: number }).min).toBeLessThan(-300_000);
  });

  it('labels the axis in full rand, never in an unstated K scale', () => {
    const fmt = (opt['yAxis'] as { axisLabel: { formatter: (v: number) => string } }).axisLabel.formatter;
    expect(fmt(1_250_000)).not.toMatch(/K/);
    expect(fmt(1_250_000)).toContain('250');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/charts/cashPositionOption.test.ts`
Expected: FAIL, cannot resolve `cashPositionOption`.

- [ ] **Step 3: Implement the builder and component**

```ts
// src/components/accounting/charts/cashPositionOption.ts
/**
 * Cash, receivables, payables and net working capital, side by side.
 * One ink for every bar: these are four measures of the same position, and
 * colouring one of them differently would claim a distinction the figures
 * do not make.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { formatMoney } from '@/lib/format/money';
import type { ChartPalette } from './chartTypes';
import { axisDomain, roleStyle } from './ibcs';

export interface CashPositionPoint {
  name: string;
  value: number;
}

export function buildCashPositionOption(
  points: CashPositionPoint[],
  palette: ChartPalette,
): EChartsCoreOption {
  const actual = roleStyle('actual', palette);
  return {
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: Array<{ name: string; value: number }>) =>
        params.map((p) => `${p.name}<br/>${formatMoney(p.value, { symbol: true })}`).join('<br/>'),
    },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.name),
      axisLabel: { color: palette.axisLabel },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: {
      type: 'value',
      ...axisDomain(points.map((p) => p.value)),
      axisLabel: { color: palette.axisLabel, formatter: (v: number) => formatMoney(v) },
      splitLine: { lineStyle: { color: palette.axisLine } },
    },
    series: [
      {
        type: 'bar',
        data: points.map((p) => p.value),
        itemStyle: { color: actual.color },
        barMaxWidth: 48,
      },
    ],
  };
}
```

```tsx
// src/components/accounting/charts/CashPositionChart.tsx
import { useCallback } from 'react';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildCashPositionOption, type CashPositionPoint } from './cashPositionOption';

export function CashPositionChart({ points }: { points: CashPositionPoint[] }) {
  const build = useCallback(
    (p: ChartPalette) => (points.length === 0 ? null : buildCashPositionOption(points, p)),
    [points],
  );
  return (
    <ChartFrame title="Cash position" unit="Rand, as at period end" height={220}
      unavailable="No balances for this period.">
      {build}
    </ChartFrame>
  );
}
```

- [ ] **Step 4: Replace the Recharts block on the dashboard**

In `pages/accounting/reports/executive-dashboard.tsx`:
1. Delete the seven `const X = dynamic(() => import('recharts')...)` declarations and the now-unused `import dynamic from 'next/dynamic'`.
2. Add `import { CashPositionChart } from '@/components/accounting/charts/CashPositionChart';`.
3. Replace the whole `<div className="bg-[var(--ff-bg-secondary)] rounded-lg …"> … Cash Position … </ResponsiveContainer></div>` block with:

```tsx
<CashPositionChart points={cashChartData} />
```

`cashChartData` already has the `{ name, value }` shape the builder wants; leave its definition alone.

- [ ] **Step 5: Run the tests and the type check**

```bash
cd <worktree>
npx vitest run tests/unit/services/reports/charts/cashPositionOption.test.ts
bun run type-check
grep -rn "recharts" pages/accounting/reports/executive-dashboard.tsx
```
Expected: 5 tests PASS; type-check clean; the `grep` prints nothing.

- [ ] **Step 6: Prove the test bites**

Change the axis formatter to `(v) => \`R${(v / 1000).toFixed(0)}K\``. Re-run: the full-rand test fails. Revert.

- [ ] **Step 7: Browser proof**

```bash
cd <worktree>
bun run dev &   # port 3200
```
Log in at `http://localhost:3200/login` with `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` from `.env.local` (read them into the browser tool without echoing them), open `http://localhost:3200/accounting/reports/executive-dashboard`, set the period to the last full month, screenshot the Cash Position panel, and check the browser console is free of errors. Save to `docs/screenshots/ws1-exec-dashboard-cash.png` and attach it to the PR.

- [ ] **Step 8: Commit**

```bash
cd <worktree>
git add src/components/accounting/charts/cashPositionOption.ts src/components/accounting/charts/CashPositionChart.tsx pages/accounting/reports/executive-dashboard.tsx tests/unit/services/reports/charts/cashPositionOption.test.ts
git commit -m "feat(charts): executive dashboard cash position on ECharts, Recharts removed"
```

---

### Task 8: Monthly trend service

Twelve monthly figures per account. P&L accounts get monthly **movement**; balance-sheet accounts get the month-end **balance**, because a monthly movement sparkline on an asset account describes a series nobody reads a balance sheet for.

**Files:**
- Create: `src/modules/accounting/services/reports/trendRowsService.ts`
- Test: `tests/integration/accountTrends.int.test.ts`

**Interfaces:**
- Produces:
  - `interface AccountTrends { months: string[]; byAccountCode: Record<string, number[]> }` — `months` is 12 `YYYY-MM` keys in order, and every array in `byAccountCode` has exactly 12 entries.
  - `getMonthlyMovements(companyId: string, asOf: string): Promise<AccountTrends>` — revenue and expense accounts.
  - `getMonthlyBalances(companyId: string, asOf: string): Promise<AccountTrends>` — asset, liability and equity accounts, cumulative from inception.

Both are scoped by `company_id` on every table in the query, including `gl_journal_lines` and `gl_journal_entries` separately, matching `budgetVarianceService`.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/accountTrends.int.test.ts
/**
 * Runs against a real DATABASE_URL. This is NOT a skip-when-no-DB test: with
 * no DATABASE_URL it FAILS, because a green suite that proved nothing is how
 * the reporting surfaces got into the state Phase 1 had to repair.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';
import {
  getMonthlyMovements, getMonthlyBalances,
} from '@/modules/accounting/services/reports/trendRowsService';

const AS_OF = '2026-08-31';
let companyId = '';

beforeAll(async () => {
  const url = process.env['DATABASE_URL'] ?? '';
  if (!url || url.includes('dummy')) {
    throw new Error('accountTrends.int.test needs a real DATABASE_URL');
  }
  const rows = (await sql`
    SELECT id FROM companies WHERE name ILIKE '%Britech%' LIMIT 1
  `) as Array<{ id: string }>;
  companyId = rows[0]?.id ?? '';
  expect(companyId).not.toBe('');
});

describe('getMonthlyMovements', () => {
  it('returns exactly twelve months, in ascending order', async () => {
    const t = await getMonthlyMovements(companyId, AS_OF);
    expect(t.months).toHaveLength(12);
    expect([...t.months].sort()).toEqual(t.months);
    expect(t.months[11]).toBe('2026-08');
  });

  it('gives every account exactly twelve figures', async () => {
    const t = await getMonthlyMovements(companyId, AS_OF);
    for (const values of Object.values(t.byAccountCode)) {
      expect(values).toHaveLength(12);
      expect(values.every(Number.isFinite)).toBe(true);
    }
  });

  it('foots: one month of the sparkline equals that month posted to the account', async () => {
    const t = await getMonthlyMovements(companyId, AS_OF);
    const [code, values] = Object.entries(t.byAccountCode).find(([, v]) => v.some((n) => n !== 0)) ?? [];
    expect(code).toBeDefined();

    const [direct] = (await sql`
      SELECT COALESCE(SUM(
        CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit
             ELSE jl.debit - jl.credit END), 0)::float8 AS amount
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND ga.account_code = ${code!}
        AND je.status = 'posted'
        AND je.entry_date >= '2026-08-01' AND je.entry_date <= '2026-08-31'
    `) as Array<{ amount: number }>;

    expect(values![11]).toBeCloseTo(direct!.amount, 2);
  });

  it('leaks nothing across tenants', async () => {
    const others = (await sql`
      SELECT id FROM companies WHERE id <> ${companyId}::UUID LIMIT 1
    `) as Array<{ id: string }>;
    if (others.length === 0) return;
    const mine = await getMonthlyMovements(companyId, AS_OF);
    const theirs = await getMonthlyMovements(others[0]!.id, AS_OF);
    const overlap = Object.keys(mine.byAccountCode).filter((c) => c in theirs.byAccountCode);
    for (const code of overlap) {
      // Same chart-of-accounts code in two tenants must not carry the same
      // twelve numbers unless both are genuinely all zero.
      const a = mine.byAccountCode[code]!, b = theirs.byAccountCode[code]!;
      if (a.some((n) => n !== 0) && b.some((n) => n !== 0)) {
        expect(a).not.toEqual(b);
      }
    }
  });
});

describe('getMonthlyBalances', () => {
  it('is cumulative: the last month equals the account balance at as-of', async () => {
    const t = await getMonthlyBalances(companyId, AS_OF);
    const [code, values] = Object.entries(t.byAccountCode).find(([, v]) => v.some((n) => n !== 0)) ?? [];
    expect(code).toBeDefined();

    const [direct] = (await sql`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::float8 AS balance
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND ga.account_code = ${code!}
        AND je.status = 'posted'
        AND je.entry_date <= ${AS_OF}
    `) as Array<{ balance: number }>;

    expect(values![11]).toBeCloseTo(direct!.balance, 2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd <worktree> && DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2-)" npx vitest run --config vitest.integration.config.ts tests/integration/accountTrends.int.test.ts`
Expected: FAIL, cannot resolve `trendRowsService`.

- [ ] **Step 3: Implement**

```ts
// src/modules/accounting/services/reports/trendRowsService.ts
/**
 * Twelve months of figures per account, for the statement trend column and
 * the small-multiples panel.
 *
 * Two functions, not one, because the two halves of the chart of accounts
 * want different series: a P&L account's twelve numbers are its monthly
 * MOVEMENT, a balance-sheet account's are its month-end BALANCE. Plotting a
 * movement series against an asset account draws a shape that has nothing to
 * do with the balance the statement prints next to it.
 *
 * Sign convention matches budgetVarianceService: revenue is credit less
 * debit, everything else is debit less credit, so "more is more" on both
 * sides and the sparkline rises when the line item rises.
 */
import { sql } from '@/lib/neon';

export interface AccountTrends {
  /** Twelve `YYYY-MM` keys, oldest first. */
  months: string[];
  /** Account code → twelve figures, aligned to `months`. */
  byAccountCode: Record<string, number[]>;
}

interface TrendRow {
  account_code: string;
  month_key: string;
  amount: number | string;
}

function monthKeys(asOf: string): string[] {
  const end = new Date(`${asOf.slice(0, 7)}-01T00:00:00Z`);
  const keys: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

function shape(rows: TrendRow[], months: string[]): AccountTrends {
  const index = new Map(months.map((m, i) => [m, i]));
  const byAccountCode: Record<string, number[]> = {};
  for (const row of rows) {
    const slot = index.get(row.month_key);
    if (slot === undefined) continue;
    const series = (byAccountCode[row.account_code] ??= Array<number>(months.length).fill(0));
    series[slot] = Number(row.amount);
  }
  return { months, byAccountCode };
}

export async function getMonthlyMovements(companyId: string, asOf: string): Promise<AccountTrends> {
  const months = monthKeys(asOf);
  const windowStart = `${months[0]}-01`;
  const rows = (await sql`
    SELECT ga.account_code,
           to_char(date_trunc('month', je.entry_date), 'YYYY-MM') AS month_key,
           COALESCE(SUM(
             CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit
                  ELSE jl.debit - jl.credit END), 0)::float8 AS amount
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND ga.account_type IN ('revenue', 'expense')
      AND je.entry_date >= ${windowStart}::date
      AND je.entry_date <= ${asOf}::date
    GROUP BY ga.account_code, date_trunc('month', je.entry_date)
  `) as TrendRow[];
  return shape(rows, months);
}

export async function getMonthlyBalances(companyId: string, asOf: string): Promise<AccountTrends> {
  const months = monthKeys(asOf);
  const windowStart = `${months[0]}-01`;
  // The opening balance is folded into the first month by clamping every
  // entry before the window onto `windowStart`, so the running sum below is
  // a true balance from inception rather than a twelve-month movement.
  const rows = (await sql`
    WITH per_month AS (
      SELECT ga.account_code,
             GREATEST(date_trunc('month', je.entry_date), ${windowStart}::date) AS month_start,
             SUM(jl.debit - jl.credit)::float8 AS movement
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${companyId}::UUID
        AND je.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND ga.account_type IN ('asset', 'liability', 'equity')
        AND je.entry_date <= ${asOf}::date
      GROUP BY ga.account_code, GREATEST(date_trunc('month', je.entry_date), ${windowStart}::date)
    )
    SELECT account_code,
           to_char(month_start, 'YYYY-MM') AS month_key,
           SUM(movement) OVER (
             PARTITION BY account_code ORDER BY month_start
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           )::float8 AS amount
    FROM per_month
  `) as TrendRow[];

  const trends = shape(rows, months);
  // A month with no posting has no row, so its slot is still 0 from `shape`.
  // A balance carries forward: fill each empty slot with the month before it.
  for (const series of Object.values(trends.byAccountCode)) {
    for (let i = 1; i < series.length; i++) {
      if (series[i] === 0 && rowMissing(rows, series, i)) series[i] = series[i - 1]!;
    }
  }
  return trends;
}

/** A zero can be a real zero balance or an absent month; only the absent
 *  month carries forward. `rows` is consulted rather than guessing. */
function rowMissing(rows: TrendRow[], _series: number[], _slot: number): boolean {
  return rows.length >= 0 && true;
}
```

The `rowMissing` helper above is a stub shape and must not ship as written. Replace it by threading the month keys that actually returned a row through `shape`: change `shape` to also return `presentByAccount: Record<string, boolean[]>`, and carry forward only where `presentByAccount[code][i] === false`. Implement that in this step — the carry-forward is the whole reason `getMonthlyBalances` differs from `getMonthlyMovements`, and a zero-versus-absent confusion draws a balance dropping to zero every quiet month.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd <worktree> && DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2-)" npx vitest run --config vitest.integration.config.ts tests/integration/accountTrends.int.test.ts`
Expected: PASS, 6 tests. Also run it once against Velocity Fibre by changing the `ILIKE` in `beforeAll` and confirm it passes there too, then restore Britech.

- [ ] **Step 5: Prove the test bites**

Drop `AND ga.company_id = ${companyId}::UUID` from `getMonthlyMovements`. Re-run: the footing test drifts and the cross-tenant test fails. Restore it.

- [ ] **Step 6: Commit**

```bash
cd <worktree>
git add src/modules/accounting/services/reports/trendRowsService.ts tests/integration/accountTrends.int.test.ts
git commit -m "feat(reports): twelve monthly figures per account, movement for P&L and balances for BS"
```

---

### Task 9: `applyTrend` and `applyBudgetComparator`

The two pure adapters that fill the `trend` and `budget` fields the row model reserved. They live beside the existing adapters and follow the same contract: copy, never derive.

**Files:**
- Create: `src/modules/accounting/services/reports/statementRows/comparators.ts`
- Modify: `src/modules/accounting/services/reports/statementRows/.claude.md` (one new bullet under Files)
- Test: `tests/unit/services/reports/statementComparators.test.ts`

**Interfaces:**
- Consumes: `StatementRow`, `Comparison` from `./statementModel`; `AccountTrends` from `../trendRowsService`; `BudgetVsActualLine` from `../budgetVsActualLines`.
- Produces:
  - `applyTrend(rows: StatementRow[], trends: AccountTrends): StatementRow[]`.
  - `applyBudgetComparator(rows: StatementRow[], lines: BudgetVsActualLine[]): StatementRow[]`.

Both return **new** row objects and never mutate their input, because a page holds the adapter output in state and React will not re-render a mutated array.

`Comparison.variance` on the budget comparator is the **movement**, `actual − budget`, to match what `prior.variance` means on every existing row and what `StatementRowView` prints. The **polarity** comes from the service's favourably-signed `line.variance >= 0`. These are two different numbers and conflating them is the defect this task's test exists to catch.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/reports/statementComparators.test.ts
import { describe, it, expect } from 'vitest';
import {
  applyTrend, applyBudgetComparator,
} from '@/modules/accounting/services/reports/statementRows/comparators';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { buildBudgetVsActualLines } from '@/modules/accounting/services/reports/budgetVsActualLines';

const MONTHS = ['2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];

const ROWS: StatementRow[] = [
  { id: 'sec:revenue', kind: 'section', label: 'Turnover', depth: 0, actual: 900_000 },
  { id: 'acc:1000', kind: 'line', label: 'Sales', depth: 1, accountCode: '1000', actual: 900_000 },
  { id: 'acc:6000', kind: 'line', label: 'Rent', depth: 1, accountCode: '6000', actual: 130_000 },
  { id: 'sub:revenue', kind: 'subtotal', label: 'Total Turnover', depth: 0, actual: 900_000 },
];

describe('applyTrend', () => {
  const trends = { months: MONTHS, byAccountCode: { '1000': MONTHS.map((_, i) => i * 1000) } };

  it('attaches the twelve figures to the row with that account code', () => {
    const out = applyTrend(ROWS, trends);
    expect(out[1]!.trend).toEqual(trends.byAccountCode['1000']);
  });

  it('leaves a row with no trend data undefined rather than inventing zeros', () => {
    const out = applyTrend(ROWS, trends);
    expect(out[2]!.trend).toBeUndefined();
  });

  it('never puts a trend on a section, subtotal or total row', () => {
    const out = applyTrend(ROWS, { months: MONTHS, byAccountCode: { '1000': MONTHS.map(() => 1) } });
    expect(out[0]!.trend).toBeUndefined();
    expect(out[3]!.trend).toBeUndefined();
  });

  it('does not mutate the rows it was given', () => {
    applyTrend(ROWS, trends);
    expect(ROWS[1]!.trend).toBeUndefined();
  });
});

describe('applyBudgetComparator', () => {
  const lines = buildBudgetVsActualLines(
    [
      { id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 900_000 },
      { id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 130_000 },
    ],
    { '1000': 1_000_000, '6000': 120_000 },
  );

  it('copies the budget figure onto the row', () => {
    const out = applyBudgetComparator(ROWS, lines);
    expect(out[1]!.budget?.value).toBe(1_000_000);
    expect(out[2]!.budget?.value).toBe(120_000);
  });

  it('reports the MOVEMENT, actual minus budget, like every other comparator', () => {
    const out = applyBudgetComparator(ROWS, lines);
    expect(out[1]!.budget?.variance).toBe(-100_000); // 900k actual vs 1.0m budget
    expect(out[2]!.budget?.variance).toBe(10_000);   // 130k actual vs 120k budget
  });

  it('takes polarity from the service, so an overspent expense is unfavourable even though its movement is positive', () => {
    const out = applyBudgetComparator(ROWS, lines);
    expect(out[1]!.budget?.favourable).toBe(false); // revenue under budget
    expect(out[2]!.budget?.favourable).toBe(false); // expense over budget
  });

  it('marks a favourable line favourable', () => {
    const good = buildBudgetVsActualLines(
      [{ id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 110_000 }],
      { '6000': 120_000 },
    );
    const out = applyBudgetComparator(ROWS, good);
    expect(out[2]!.budget?.favourable).toBe(true);
    expect(out[2]!.budget?.variance).toBe(-10_000);
  });

  it('copies the service percentage rather than recomputing one', () => {
    const out = applyBudgetComparator(ROWS, lines);
    expect(out[1]!.budget?.variancePct).toBe(lines.find((l) => l.account_code === '1000')!.variance_pct);
  });

  it('leaves an unbudgeted row without a budget comparison', () => {
    const out = applyBudgetComparator(ROWS, lines.filter((l) => l.account_code === '1000'));
    expect(out[2]!.budget).toBeUndefined();
  });

  it('does not mutate the rows it was given', () => {
    applyBudgetComparator(ROWS, lines);
    expect(ROWS[1]!.budget).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/statementComparators.test.ts`
Expected: FAIL, cannot resolve `comparators`.

- [ ] **Step 3: Implement**

```ts
// src/modules/accounting/services/reports/statementRows/comparators.ts
/**
 * Fills the `trend` and `budget` fields the row model reserved for this
 * workstream. Same contract as the other adapters in this directory: every
 * figure is COPIED from a service, nothing is derived.
 *
 * One subtraction happens here and it is deliberate: `budget.variance` is
 * `actual − budget`, the MOVEMENT, because that is what `prior.variance`
 * means on every existing row and what `StatementRowView` prints. The
 * service's own `line.variance` cannot be used for that field — it is signed
 * FAVOURABLY (revenue: actual − budget; expense: budget − actual), so on an
 * expense it has the opposite sign to the movement. It is used for the
 * POLARITY and nothing else.
 */
import type { BudgetVsActualLine } from '../budgetVsActualLines';
import type { AccountTrends } from '../trendRowsService';
import type { Comparison, StatementRow } from './statementModel';

/** Only a coded line row carries an account-level comparator. A section,
 *  subtotal, total or grand row is a band, and no service returns a
 *  per-account figure for one. */
function isAccountLine(row: StatementRow): boolean {
  return row.kind === 'line' && row.accountCode !== undefined;
}

export function applyTrend(rows: StatementRow[], trends: AccountTrends): StatementRow[] {
  return rows.map((row) => {
    if (!isAccountLine(row)) return row;
    const series = trends.byAccountCode[row.accountCode!];
    if (series === undefined) return row;
    return { ...row, trend: series };
  });
}

export function applyBudgetComparator(
  rows: StatementRow[],
  lines: BudgetVsActualLine[],
): StatementRow[] {
  const byCode = new Map(lines.map((l) => [l.account_code, l]));
  return rows.map((row) => {
    if (!isAccountLine(row)) return row;
    const line = byCode.get(row.accountCode!);
    if (line === undefined) return row;
    const budget: Comparison = {
      value: line.budget_amount,
      variance: round2(line.actual_amount - line.budget_amount),
      variancePct: line.variance_pct,
      favourable: line.variance >= 0,
    };
    return { ...row, budget };
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/statementComparators.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Prove the test bites**

Change `favourable: line.variance >= 0` to `favourable: line.actual_amount >= line.budget_amount`. Re-run: the polarity test fails on Rent. Revert. Then change `variance` to `line.variance` and re-run: the movement test fails on Rent. Revert.

- [ ] **Step 6: Update the directory doc**

Add to the `## Files` list in `src/modules/accounting/services/reports/statementRows/.claude.md`:

```markdown
- `comparators.ts` — `applyTrend` and `applyBudgetComparator`, which fill the
  `trend` and `budget` fields. `budget.variance` is the movement
  (`actual − budget`); the service's own favourably-signed `variance` is used
  only for `favourable`. Adding a third comparator goes here, not into the
  report adapters.
```

Then regenerate the mirror: `cd <worktree> && bun run agent-docs:generate`.

- [ ] **Step 7: Commit**

```bash
cd <worktree>
git add src/modules/accounting/services/reports/statementRows/comparators.ts src/modules/accounting/services/reports/statementRows/.claude.md src/modules/accounting/services/reports/statementRows/AGENTS.md tests/unit/services/reports/statementComparators.test.ts
git commit -m "feat(reports): trend and budget comparators for the statement row model"
```

---

### Task 10: The two API routes

Neither the trend series nor the budget comparator has an HTTP surface today. `reports-budget-vs-actual` accepts only `period=current|ytd|full_year`, which cannot answer the arbitrary `period_start` / `period_end` the statement pages use, so it cannot be reused.

**Requires ownership request #2 to be granted before this task starts.**

**Files:**
- Create: `pages/api/accounting/reports-account-trends.ts`
- Create: `pages/api/accounting/reports-budget-comparator.ts`

**Interfaces:**
- Consumes: `getMonthlyMovements`, `getMonthlyBalances` (Task 8); `getBudgetVariance(companyId, periodStart, periodEnd)` from `@/modules/accounting/services/reports/budgetVarianceService`.
- Produces:
  - `GET /api/accounting/reports-account-trends?as_of=YYYY-MM-DD&basis=movement|balance` → `{ months: string[], byAccountCode: Record<string, number[]> }`.
  - `GET /api/accounting/reports-budget-comparator?period_start=&period_end=` → `{ fiscalYear: number, monthKeys: string[], lines: BudgetVsActualLine[], postedThrough: string | null }`.

- [ ] **Step 1: Implement the trends route**

```ts
// pages/api/accounting/reports-account-trends.ts
/**
 * GET /api/accounting/reports-account-trends?as_of=YYYY-MM-DD&basis=movement|balance
 *
 * Twelve monthly figures per account code, for the statement trend column
 * and the small-multiples panel. `movement` for P&L accounts, `balance` for
 * balance-sheet accounts — see trendRowsService for why they differ.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  getMonthlyBalances, getMonthlyMovements,
} from '@/modules/accounting/services/reports/trendRowsService';

const Query = z.object({
  as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  basis: z.enum(['movement', 'balance']).default('movement'),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);

  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { as_of: asOf, basis } = parsed.data;
  const trends = basis === 'balance'
    ? await getMonthlyBalances(companyId, asOf)
    : await getMonthlyMovements(companyId, asOf);

  return apiResponse.success(res, trends);
}

export default withAuth(withErrorHandler(handler as never));
```

- [ ] **Step 2: Implement the budget comparator route**

```ts
// pages/api/accounting/reports-budget-comparator.ts
/**
 * GET /api/accounting/reports-budget-comparator?period_start=&period_end=
 *
 * The budget column for the statement grid. Wraps getBudgetVariance, which
 * aggregates posted journal lines per account rather than reading the income
 * statement — see that service's header for why.
 *
 * `lines` is budgeted accounts followed by unbudgeted ones, because the
 * statement needs to look an account up by code regardless of which half it
 * fell into, and dropping the unbudgeted half would silently hide accounts.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';

const Query = z.object({
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);

  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { period_start: start, period_end: end } = parsed.data;
  const result = await getBudgetVariance(companyId, start, end);

  return apiResponse.success(res, {
    fiscalYear: result.fiscalYear,
    monthKeys: result.monthKeys,
    lines: [...result.rows, ...result.unbudgeted],
    postedThrough: result.postedThrough,
  });
}

export default withAuth(withErrorHandler(handler as never));
```

- [ ] **Step 3: Verify both routes answer**

```bash
cd <worktree>
bun run dev &
bun run check:routes
bun run type-check
```
Then, in the logged-in browser session from Task 7, open the network tab and hit:
`http://localhost:3200/api/accounting/reports-account-trends?as_of=2026-08-31&basis=movement`
`http://localhost:3200/api/accounting/reports-budget-comparator?period_start=2026-08-01&period_end=2026-08-31`
Expected: both 200, both envelopes carry `data`. Confirm the trends response has `months.length === 12`.

- [ ] **Step 4: Commit**

```bash
cd <worktree>
git add pages/api/accounting/reports-account-trends.ts pages/api/accounting/reports-budget-comparator.ts
git commit -m "feat(reports): HTTP surface for account trends and the budget comparator"
```

---

### Task 11: Comparator controls and the density toggle

**Requires ownership request #1 to be granted before this task starts.**

**Files:**
- Create: `src/components/accounting/reportControls/ComparatorControls.tsx`
- Create: `src/components/accounting/reportControls/useDensity.ts`
- Create: `src/components/accounting/reportControls/DensityToggle.tsx`
- Modify: `pages/accounting/reports/executive-dashboard.tsx` (density toggle in the header, tile row trimmed in owner mode)
- Test: `tests/unit/components/charts/ComparatorControls.test.tsx`
- Test: `tests/unit/components/charts/DensityToggle.test.tsx`

**Interfaces:**
- Produces:
  - `<ComparatorControls value onChange />` where `value: StatementColumns` and `onChange: (next: StatementColumns) => void`. Four checkboxes: Prior, Budget, Variance, 12-month trend. Turning every comparator off also turns Variance off, because a variance column with nothing to vary against is four empty cells.
  - `type Density = 'owner' | 'accountant'`; `useDensity(): { density, setDensity, loading }`.
  - `<DensityToggle density onChange />` — two segmented buttons.

`useDensity` follows the established preference pattern in `src/hooks/useDisplayMode.ts` exactly: localStorage first for an instant first paint, then a `GET /api/auth/preferences` sync, and a fire-and-forget `PUT` on change. Preference key `reports_density`, localStorage key `isaflow_reports_density`.

`owner` means the eight-tile row trims to the four tiles an owner reads (Revenue, Net profit, Cash balance, Net working capital) and comparator columns default off. `accountant` shows all eight tiles and defaults prior + variance on. Density changes what is *shown*, never what a figure *is*.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/unit/components/charts/ComparatorControls.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComparatorControls } from '@/components/accounting/reportControls/ComparatorControls';
import type { StatementColumns } from '@/modules/accounting/services/reports/statementRows/statementModel';

afterEach(cleanup);
const OFF: StatementColumns = { prior: false, budget: false, variance: false, trend: false };

describe('ComparatorControls', () => {
  it('turns a comparator on without touching the others', () => {
    const onChange = vi.fn();
    render(<ComparatorControls value={OFF} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Budget'));
    expect(onChange).toHaveBeenCalledWith({ ...OFF, budget: true });
  });

  it('turns variance off when the last comparator is turned off', () => {
    const onChange = vi.fn();
    render(<ComparatorControls value={{ prior: true, budget: false, variance: true, trend: false }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Prior period'));
    expect(onChange).toHaveBeenCalledWith({ prior: false, budget: false, variance: false, trend: false });
  });

  it('disables variance while no comparator is on', () => {
    render(<ComparatorControls value={OFF} onChange={vi.fn()} />);
    expect((screen.getByLabelText('Variance') as HTMLInputElement).disabled).toBe(true);
  });

  it('offers the trend column independently of any comparator', () => {
    const onChange = vi.fn();
    render(<ComparatorControls value={OFF} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('12-month trend'));
    expect(onChange).toHaveBeenCalledWith({ ...OFF, trend: true });
  });
});
```

```tsx
// tests/unit/components/charts/DensityToggle.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DensityToggle } from '@/components/accounting/reportControls/DensityToggle';

afterEach(cleanup);

describe('DensityToggle', () => {
  it('marks the active density pressed, so a screen reader can tell which is on', () => {
    render(<DensityToggle density="owner" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Owner' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Accountant' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the density the user picked', () => {
    const onChange = vi.fn();
    render(<DensityToggle density="owner" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Accountant' }));
    expect(onChange).toHaveBeenCalledWith('accountant');
  });

  it('does not fire when the active density is clicked again', () => {
    const onChange = vi.fn();
    render(<DensityToggle density="owner" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Owner' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd <worktree> && npx vitest run --config vitest.components.config.ts tests/unit/components/charts/ComparatorControls.test.tsx tests/unit/components/charts/DensityToggle.test.tsx`
Expected: FAIL, cannot resolve either module.

- [ ] **Step 3: Implement `ComparatorControls`**

```tsx
// src/components/accounting/reportControls/ComparatorControls.tsx
/**
 * Which comparator columns the statement shows. One control for every field
 * on `StatementColumns`, so adding a comparator to the row model surfaces
 * here rather than in five pages.
 */
import type { StatementColumns } from '@/modules/accounting/services/reports/statementRows/statementModel';

const BOX = 'h-3.5 w-3.5 accent-[var(--ff-brand-500)]';

export function ComparatorControls({
  value, onChange,
}: { value: StatementColumns; onChange: (next: StatementColumns) => void }) {
  const anyComparator = value.prior || value.budget;

  const set = (patch: Partial<StatementColumns>) => {
    const next = { ...value, ...patch };
    // A variance column with no comparator behind it renders four empty
    // cells per row, which reads as missing data rather than as "off".
    if (!next.prior && !next.budget) next.variance = false;
    onChange(next);
  };

  return (
    <fieldset className="flex flex-wrap items-center gap-4 text-xs text-[var(--ff-text-secondary)]">
      <legend className="sr-only">Comparison columns</legend>
      <label className="inline-flex items-center gap-1.5">
        <input id="cmp-prior" type="checkbox" className={BOX} checked={value.prior}
          onChange={(e) => set({ prior: e.target.checked })} />
        <span>Prior period</span>
      </label>
      <label className="inline-flex items-center gap-1.5">
        <input id="cmp-budget" type="checkbox" className={BOX} checked={value.budget}
          onChange={(e) => set({ budget: e.target.checked })} />
        <span>Budget</span>
      </label>
      <label className="inline-flex items-center gap-1.5">
        <input id="cmp-variance" type="checkbox" className={BOX} checked={value.variance}
          disabled={!anyComparator}
          onChange={(e) => set({ variance: e.target.checked })} />
        <span className={anyComparator ? '' : 'opacity-50'}>Variance</span>
      </label>
      <label className="inline-flex items-center gap-1.5">
        <input id="cmp-trend" type="checkbox" className={BOX} checked={value.trend}
          onChange={(e) => set({ trend: e.target.checked })} />
        <span>12-month trend</span>
      </label>
    </fieldset>
  );
}
```

The tests address the boxes by `getByLabelText`, which resolves through the wrapping `<label>`; the ids are there so a page can point a description at them.

- [ ] **Step 4: Implement `useDensity` and `DensityToggle`**

```ts
// src/components/accounting/reportControls/useDensity.ts
/**
 * Owner / accountant reading density for the report surfaces.
 *
 * Same shape as `useDisplayMode`: localStorage answers the first paint, the
 * server preference is the source of truth across devices, and a change
 * writes both. Density changes what is SHOWN and never what a figure IS.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export type Density = 'owner' | 'accountant';

const LS_KEY = 'isaflow_reports_density';
const PREF_KEY = 'reports_density';

const isDensity = (v: unknown): v is Density => v === 'owner' || v === 'accountant';

export function useDensity(): { density: Density; setDensity: (d: Density) => void; loading: boolean } {
  const [density, setState] = useState<Density>('owner');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
    if (isDensity(stored)) {
      setState(stored);
      setLoading(false);
    }
    const sync = async () => {
      try {
        const res = await apiFetch('/api/auth/preferences');
        const json = (await res.json()) as { data?: Record<string, string> };
        const server = json.data?.[PREF_KEY];
        if (isDensity(server)) {
          setState(server);
          localStorage.setItem(LS_KEY, server);
        }
      } catch (err) {
        log.warn('Failed to sync reports density preference', { error: err }, 'useDensity');
      } finally {
        setLoading(false);
      }
    };
    void sync();
  }, []);

  const setDensity = useCallback((next: Density) => {
    setState(next);
    if (typeof window !== 'undefined') localStorage.setItem(LS_KEY, next);
    apiFetch('/api/auth/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { [PREF_KEY]: next } }),
    }).catch((err) => {
      log.warn('Failed to save reports density preference', { error: err }, 'useDensity');
    });
  }, []);

  return { density, setDensity, loading };
}
```

```tsx
// src/components/accounting/reportControls/DensityToggle.tsx
import type { Density } from './useDensity';

const OPTIONS: Array<{ value: Density; label: string }> = [
  { value: 'owner', label: 'Owner' },
  { value: 'accountant', label: 'Accountant' },
];

export function DensityToggle({
  density, onChange,
}: { density: Density; onChange: (d: Density) => void }) {
  return (
    <div className="inline-flex rounded-md border border-[var(--ff-border-light)] p-0.5" role="group" aria-label="Reading density">
      {OPTIONS.map((o) => {
        const active = o.value === density;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => { if (!active) onChange(o.value); }}
            className={`px-3 py-1 text-xs rounded ${active
              ? 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)]'
              : 'text-[var(--ff-text-secondary)]'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Wire density into the executive dashboard**

In `pages/accounting/reports/executive-dashboard.tsx`:
1. `import { useDensity } from '@/components/accounting/reportControls/useDensity';` and `import { DensityToggle } from '@/components/accounting/reportControls/DensityToggle';`
2. In the component: `const { density, setDensity } = useDensity();`
3. In the header's date-input row, before the `<input type="date">`, render `<DensityToggle density={density} onChange={setDensity} />`.
4. Wrap the four secondary tiles — Gross margin, Net margin, Current ratio, Debt/equity — in `{density === 'accountant' && (<> … </>)}`. Revenue, Net profit, Cash balance and NWC always render.
5. Wrap the KPI Scorecard block in `{density === 'accountant' && ( … )}`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd <worktree>
npx vitest run --config vitest.components.config.ts tests/unit/components/charts/ComparatorControls.test.tsx tests/unit/components/charts/DensityToggle.test.tsx
bun run type-check
```
Expected: 7 tests PASS; type-check clean.

- [ ] **Step 7: Prove the tests bite**

Delete the `if (!next.prior && !next.budget) next.variance = false;` line. Re-run: the "turns variance off" test fails. Restore it. Then remove the `if (!active)` guard in `DensityToggle`: the "does not fire" test fails. Restore it.

- [ ] **Step 8: Browser proof**

Reload `http://localhost:3200/accounting/reports/executive-dashboard`. Switch to Accountant, confirm eight tiles and the scorecard appear; switch to Owner, confirm four tiles and no scorecard; **hard-reload** and confirm the choice survived; check the network tab shows a `PUT /api/auth/preferences` returning 200. Screenshot both densities to `docs/screenshots/ws1-density-owner.png` and `ws1-density-accountant.png`.

- [ ] **Step 9: Commit**

```bash
cd <worktree>
git add src/components/accounting/reportControls pages/accounting/reports/executive-dashboard.tsx tests/unit/components/charts/ComparatorControls.test.tsx tests/unit/components/charts/DensityToggle.test.tsx
git commit -m "feat(reports): comparator controls and an owner/accountant density toggle"
```

---

### Task 12: Presentation mode — slide model

Pure first: what a pack becomes when it is paged rather than scrolled.

**Files:**
- Create: `src/components/accounting/present/presentSlides.ts`
- Test: `tests/unit/services/reports/presentSlides.test.ts`

**Interfaces:**
- Consumes: the pack shape already fetched by `report-packs.tsx`:
  `ReportPack { type: 'board' | 'management' | 'monthly'; companyName: string; period: string; generatedAt: string; sections: Array<{ type: string; title: string; data: Record<string, unknown> }> }`. Declare and export this interface from `presentSlides.ts`.
- Produces:
  - `type SlideKind = 'cover' | 'income_statement' | 'balance_sheet' | 'cash_flow' | 'ratios' | 'kpis' | 'commentary' | 'waterfall' | 'trends'`.
  - `interface Slide { id: string; kind: SlideKind; title: string; data: Record<string, unknown> }`.
  - `buildSlides(pack: ReportPack): Slide[]`.
  - `clampSlide(index: number, count: number): number`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/reports/presentSlides.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildSlides, clampSlide, type ReportPack,
} from '@/components/accounting/present/presentSlides';

const PACK: ReportPack = {
  type: 'board',
  companyName: 'Britech (Pty) Ltd',
  period: '1 Aug 2026 – 31 Aug 2026',
  generatedAt: '2026-09-06T08:00:00.000Z',
  sections: [
    { type: 'income_statement', title: 'Income Statement', data: { revenue: 1 } },
    { type: 'balance_sheet', title: 'Balance Sheet', data: { totalAssets: 2 } },
    { type: 'nonsense', title: 'Something new', data: {} },
  ],
};

describe('buildSlides', () => {
  const slides = buildSlides(PACK);

  it('opens with a cover carrying the company, period and pack name', () => {
    expect(slides[0]!.kind).toBe('cover');
    expect(slides[0]!.title).toContain('Britech');
    expect(slides[0]!.data['period']).toBe('1 Aug 2026 – 31 Aug 2026');
  });

  it('makes one slide per known section, in pack order', () => {
    expect(slides.slice(1).map((s) => s.kind)).toEqual(['income_statement', 'balance_sheet']);
  });

  it('drops a section kind it cannot render rather than paging to a blank slide', () => {
    expect(slides.map((s) => s.title)).not.toContain('Something new');
  });

  it('gives every slide a stable unique id', () => {
    const ids = slides.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(buildSlides(PACK).map((s) => s.id)).toEqual(ids);
  });

  it('carries the section data through untouched', () => {
    expect(slides[1]!.data).toBe(PACK.sections[0]!.data);
  });

  it('still produces a cover for a pack with no renderable sections', () => {
    expect(buildSlides({ ...PACK, sections: [] })).toHaveLength(1);
  });
});

describe('clampSlide', () => {
  it('holds at the first and last slide instead of wrapping', () => {
    expect(clampSlide(-1, 4)).toBe(0);
    expect(clampSlide(9, 4)).toBe(3);
    expect(clampSlide(2, 4)).toBe(2);
  });
  it('returns 0 for an empty deck', () => {
    expect(clampSlide(3, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/presentSlides.test.ts`
Expected: FAIL, cannot resolve `presentSlides`.

- [ ] **Step 3: Implement**

```ts
// src/components/accounting/present/presentSlides.ts
/**
 * A report pack, paged.
 *
 * Unknown section types are DROPPED rather than rendered empty: a pack shown
 * on a boardroom screen must not page to a blank slide because a service
 * grew a section this deck has no renderer for.
 */

export interface ReportPack {
  type: 'board' | 'management' | 'monthly';
  companyName: string;
  period: string;
  generatedAt: string;
  sections: Array<{ type: string; title: string; data: Record<string, unknown> }>;
}

export type SlideKind =
  | 'cover' | 'income_statement' | 'balance_sheet' | 'cash_flow'
  | 'ratios' | 'kpis' | 'commentary' | 'waterfall' | 'trends';

export interface Slide {
  id: string;
  kind: SlideKind;
  title: string;
  data: Record<string, unknown>;
}

const RENDERABLE = new Set<SlideKind>([
  'income_statement', 'balance_sheet', 'cash_flow',
  'ratios', 'kpis', 'commentary', 'waterfall', 'trends',
]);

const PACK_LABEL: Record<ReportPack['type'], string> = {
  board: 'Board Pack',
  management: 'Management Pack',
  monthly: 'Monthly Pack',
};

export function buildSlides(pack: ReportPack): Slide[] {
  const slides: Slide[] = [
    {
      id: 'cover',
      kind: 'cover',
      title: `${pack.companyName} — ${PACK_LABEL[pack.type]}`,
      data: { period: pack.period, generatedAt: pack.generatedAt },
    },
  ];

  pack.sections.forEach((section, i) => {
    const kind = section.type as SlideKind;
    if (!RENDERABLE.has(kind)) return;
    slides.push({ id: `${kind}:${i}`, kind, title: section.title, data: section.data });
  });

  return slides;
}

export function clampSlide(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd <worktree> && npx vitest run tests/unit/services/reports/presentSlides.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the test bites**

Change `clampSlide` to wrap (`(index + count) % count`). Re-run: the hold-at-the-end test fails. Revert.

- [ ] **Step 6: Commit**

```bash
cd <worktree>
git add src/components/accounting/present/presentSlides.ts tests/unit/services/reports/presentSlides.test.ts
git commit -m "feat(present): pack sections to a slide deck"
```

---

### Task 13: `PresentDeck` — full screen, keyboard paged

**Files:**
- Create: `src/components/accounting/present/PresentDeck.tsx`
- Test: `tests/unit/components/charts/PresentDeck.test.tsx`

**Interfaces:**
- Consumes: `Slide`, `clampSlide` (Task 12).
- Produces: `<PresentDeck slides renderSlide onExit? />` where `renderSlide: (slide: Slide, index: number) => ReactNode`.

Keys: `ArrowRight`, `ArrowDown`, `PageDown`, `Space` and `Enter` advance; `ArrowLeft`, `ArrowUp`, `PageUp` and `Backspace` go back; `Home` and `End` jump; `Escape` calls `onExit`. Only the current slide is in the DOM, so a fifty-account statement on slide seven costs nothing on slide one. The deck also requests browser full screen on mount when the API is available, and does not fail when it is not (`requestFullscreen` rejects without a user gesture in several browsers, and in happy-dom it is absent altogether).

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/charts/PresentDeck.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PresentDeck } from '@/components/accounting/present/PresentDeck';
import type { Slide } from '@/components/accounting/present/presentSlides';

afterEach(cleanup);

const SLIDES: Slide[] = [
  { id: 'cover', kind: 'cover', title: 'Cover', data: {} },
  { id: 'is:0', kind: 'income_statement', title: 'Income Statement', data: {} },
  { id: 'bs:1', kind: 'balance_sheet', title: 'Balance Sheet', data: {} },
];

const renderSlide = (s: Slide) => <p>{s.title}</p>;

describe('PresentDeck', () => {
  it('shows only the current slide', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    expect(screen.getByText('Cover')).toBeTruthy();
    expect(screen.queryByText('Income Statement')).toBeNull();
  });

  it('advances on the right arrow and on space', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('Income Statement')).toBeTruthy();
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getByText('Balance Sheet')).toBeTruthy();
  });

  it('goes back on the left arrow and holds at the first slide', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(screen.getByText('Cover')).toBeTruthy();
  });

  it('holds at the last slide rather than wrapping to the cover', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    fireEvent.keyDown(window, { key: 'End' });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('Balance Sheet')).toBeTruthy();
  });

  it('jumps to the first slide on Home', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    fireEvent.keyDown(window, { key: 'End' });
    fireEvent.keyDown(window, { key: 'Home' });
    expect(screen.getByText('Cover')).toBeTruthy();
  });

  it('exits on Escape', () => {
    const onExit = vi.fn();
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} onExit={onExit} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('states the position, so a presenter knows how far in they are', () => {
    render(<PresentDeck slides={SLIDES} renderSlide={renderSlide} />);
    expect(screen.getByText('1 / 3')).toBeTruthy();
  });

  it('renders an empty deck without throwing', () => {
    render(<PresentDeck slides={[]} renderSlide={renderSlide} />);
    expect(screen.queryByText('1 / 0')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && npx vitest run --config vitest.components.config.ts tests/unit/components/charts/PresentDeck.test.tsx`
Expected: FAIL, cannot resolve `PresentDeck`.

- [ ] **Step 3: Implement**

```tsx
// src/components/accounting/present/PresentDeck.tsx
/**
 * A pack, on a boardroom screen. No app chrome, one slide in the DOM at a
 * time, and every paging action reachable from the keyboard — a presenter
 * has one hand on a clicker, which sends arrow keys and Page Up/Down.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { log } from '@/lib/logger';
import { clampSlide, type Slide } from './presentSlides';

const FORWARD = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar', 'Enter']);
const BACK = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']);

export interface PresentDeckProps {
  slides: Slide[];
  renderSlide: (slide: Slide, index: number) => ReactNode;
  onExit?: () => void;
}

export function PresentDeck({ slides, renderSlide, onExit }: PresentDeckProps) {
  const [index, setIndex] = useState(0);
  const count = slides.length;

  const go = useCallback((next: number) => setIndex((i) => clampSlide(next, count) || (count ? clampSlide(next, count) : i)), [count]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onExit?.(); return; }
      if (FORWARD.has(e.key)) { e.preventDefault(); setIndex((i) => clampSlide(i + 1, count)); return; }
      if (BACK.has(e.key)) { e.preventDefault(); setIndex((i) => clampSlide(i - 1, count)); return; }
      if (e.key === 'Home') { setIndex(clampSlide(0, count)); return; }
      if (e.key === 'End') { setIndex(clampSlide(count - 1, count)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [count, onExit]);

  useEffect(() => {
    // Full screen needs a user gesture in several browsers and does not
    // exist in the test DOM. A refusal is normal, not an error.
    const el = document.documentElement;
    if (typeof el.requestFullscreen !== 'function') return;
    el.requestFullscreen().catch((err: unknown) => {
      log.info('Presentation mode stayed windowed', { error: err }, 'PresentDeck');
    });
  }, []);

  const current = slides[index];
  if (!current) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--ff-bg-primary)]">
        <p className="text-sm text-[var(--ff-text-secondary)]">This pack has no slides.</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col bg-[var(--ff-bg-primary)] px-10 py-8">
      <section className="flex-1 overflow-auto" aria-live="polite">
        {renderSlide(current, index)}
      </section>
      <footer className="mt-6 flex items-center justify-between text-xs text-[var(--ff-text-tertiary)]">
        <span>{current.title}</span>
        <span className="tabular-nums">{index + 1} / {count}</span>
      </footer>
    </main>
  );
}
```

Delete the unused `go` callback before committing — the keyboard handler updates state functionally and nothing else pages the deck. Leaving it would trip `noUnusedLocals`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd <worktree> && npx vitest run --config vitest.components.config.ts tests/unit/components/charts/PresentDeck.test.tsx`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the test bites**

Remove `'PageDown'` and `' '` from `FORWARD`. Re-run: the space-advances test fails. Restore them.

- [ ] **Step 6: Commit**

```bash
cd <worktree>
git add src/components/accounting/present/PresentDeck.tsx tests/unit/components/charts/PresentDeck.test.tsx
git commit -m "feat(present): keyboard-paged full-screen deck"
```

---

### Task 14: The presentation route

The route that puts it together: a pack fetched, turned into slides, rendered with the real grid and the real charts, no `AppLayout`.

**Files:**
- Create: `pages/accounting/reports/present/[pack].tsx`
- Create: `src/components/accounting/present/PresentSlide.tsx`

No entry is added to `src/components/accounting/accountingNavConfig.ts`. The presentation route is entered from the packs page, not from navigation. This is stated so the next reader does not add one out of habit.

**Interfaces:**
- Consumes: `buildSlides`, `PresentDeck`; `StatementGrid` from `@/components/accounting/statement/StatementGrid`; `toIncomeStatementRows`, `toBalanceSheetRows`, `applyTrend`, `applyBudgetComparator`; `ProfitWaterfall`, `CashFlowSankey`, `BudgetBulletRow`, `SmallMultiples`; the two routes from Task 10.
- Route: `/accounting/reports/present/board|management|monthly?from=YYYY-MM-DD&to=YYYY-MM-DD`.

This route is where the trend and budget columns are proven end to end while the statement pages themselves are waiting on their owners (requests 3 and 4). It renders the income statement slide through `StatementGrid` with `columns={{ prior: false, budget: true, variance: true, trend: true }}`, fed by `applyBudgetComparator(applyTrend(rows, trends), lines)`.

**The income statement slide does not use the pack section.** `packMappers.toManagementPandLRows` returns eight BAND rows — `depth: 0`, `kind` of `subtotal` / `total` / `grand`, and no `accountCode` — so both comparators would correctly skip every one of them and the slide would show empty Budget and 12-mo columns. The slide therefore fetches `GET /api/accounting/reports-income-statement?period_start=&period_end=` (which returns the report object directly as `data`) and maps it with `toIncomeStatementRows`, the same adapter the income-statement page uses. The pack's own `income_statement` section is still what the cover, period and title come from.

- [ ] **Step 1: Write the page**

```tsx
// pages/accounting/reports/present/[pack].tsx
/**
 * Presentation mode. Full screen, keyboard paged, no app chrome — the same
 * React components the report surfaces use, on a boardroom screen.
 *
 * No AppLayout on purpose: the sidebar, the header and the tenant switcher
 * are the "app chrome" this route exists to remove.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { PresentDeck } from '@/components/accounting/present/PresentDeck';
import { buildSlides, type ReportPack, type Slide } from '@/components/accounting/present/presentSlides';
import { PresentSlide } from '@/components/accounting/present/PresentSlide';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { AccountTrends } from '@/modules/accounting/services/reports/trendRowsService';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';

const PACK_TYPES = new Set(['board', 'management', 'monthly']);

export default function PresentPackPage() {
  const router = useRouter();
  const packType = typeof router.query['pack'] === 'string' ? router.query['pack'] : '';
  const from = typeof router.query['from'] === 'string' ? router.query['from'] : '';
  const to = typeof router.query['to'] === 'string' ? router.query['to'] : '';

  const [slides, setSlides] = useState<Slide[] | null>(null);
  const [trends, setTrends] = useState<AccountTrends | null>(null);
  const [budget, setBudget] = useState<BudgetVsActualLine[]>([]);
  const [income, setIncome] = useState<IncomeStatementReport | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!PACK_TYPES.has(packType) || !from || !to) return;
    let live = true;

    const load = async () => {
      try {
        const [packRes, trendRes, budgetRes, isRes] = await Promise.all([
          apiFetch(`/api/accounting/reports-pack?type=${packType}&from=${from}&to=${to}`),
          apiFetch(`/api/accounting/reports-account-trends?as_of=${to}&basis=movement`),
          apiFetch(`/api/accounting/reports-budget-comparator?period_start=${from}&period_end=${to}`),
          apiFetch(`/api/accounting/reports-income-statement?period_start=${from}&period_end=${to}`),
        ]);
        if (!packRes.ok) throw new Error(`pack ${packRes.status}`);
        const packJson = (await packRes.json()) as { data?: { pack?: ReportPack } };
        const pack = packJson.data?.pack;
        if (!pack) throw new Error('pack payload had no pack');
        if (!live) return;
        setSlides(buildSlides(pack));

        if (trendRes.ok) {
          setTrends(((await trendRes.json()) as { data?: AccountTrends }).data ?? null);
        }
        if (budgetRes.ok) {
          setBudget(((await budgetRes.json()) as { data?: { lines?: BudgetVsActualLine[] } }).data?.lines ?? []);
        }
        // The pack's income_statement section is BAND TOTALS only, so the
        // per-account comparators would attach to nothing. The real report
        // is fetched for that slide.
        if (isRes.ok) {
          setIncome(((await isRes.json()) as { data?: IncomeStatementReport }).data ?? null);
        }
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
        log.error('Presentation pack failed to load', { error: err }, 'present');
      }
    };

    void load();
    return () => { live = false; };
  }, [packType, from, to]);

  const renderSlide = useCallback(
    (slide: Slide) => <PresentSlide slide={slide} income={income} trends={trends} budget={budget} />,
    [income, trends, budget],
  );

  const exit = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    void router.push('/accounting/reports/report-packs');
  }, [router]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--ff-bg-primary)]">
        <p className="text-sm text-[var(--ff-unfav)]">This pack could not be loaded: {error}</p>
      </main>
    );
  }
  if (!slides) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--ff-bg-primary)]">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--ff-text-tertiary)]" />
      </main>
    );
  }
  return <PresentDeck slides={slides} renderSlide={renderSlide} onExit={exit} />;
}
```

- [ ] **Step 2: Write the slide renderer**

```tsx
// src/components/accounting/present/PresentSlide.tsx
/**
 * One slide. Every figure comes from the pack section or from a comparator
 * service — this component maps, it does not compute.
 */
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { ProfitWaterfall } from '@/components/accounting/charts/ProfitWaterfall';
import { BudgetBulletRow } from '@/components/accounting/charts/BudgetBulletRow';
import { SmallMultiples } from '@/components/accounting/charts/SmallMultiples';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { AccountTrends } from '@/modules/accounting/services/reports/trendRowsService';
import { applyBudgetComparator, applyTrend } from '@/modules/accounting/services/reports/statementRows/comparators';
import { toIncomeStatementRows } from '@/modules/accounting/services/reports/statementRows/incomeStatementRows';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import type { Slide } from './presentSlides';

const COLUMNS = { prior: false, budget: true, variance: true, trend: true } as const;

export function PresentSlide({
  slide, income, trends, budget,
}: {
  slide: Slide;
  income: IncomeStatementReport | null;
  trends: AccountTrends | null;
  budget: BudgetVsActualLine[];
}) {
  if (slide.kind === 'cover') {
    return (
      <div className="flex h-full flex-col justify-center">
        <h1 className="text-5xl font-bold text-[var(--ff-text-primary)]">{slide.title}</h1>
        <p className="mt-4 text-xl text-[var(--ff-text-secondary)]">{String(slide.data['period'] ?? '')}</p>
      </div>
    );
  }

  if (slide.kind === 'income_statement') {
    if (!income) {
      return (
        <p className="text-sm text-[var(--ff-text-secondary)]">
          The income statement for this period could not be loaded.
        </p>
      );
    }
    const base = toIncomeStatementRows(income, { comparative: false });
    const withTrend = trends ? applyTrend(base, trends) : base;
    const rows = applyBudgetComparator(withTrend, budget);
    return (
      <>
        <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
        <StatementGrid rows={rows} columns={{ ...COLUMNS }} title="Statement of Comprehensive Income" />
      </>
    );
  }

  if (slide.kind === 'waterfall') {
    const steps = (slide.data['steps'] as WaterfallStep[] | undefined) ?? [];
    return (
      <>
        <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
        <ProfitWaterfall steps={steps} height={420} />
      </>
    );
  }

  if (slide.kind === 'trends' && trends) {
    const panels = Object.entries(trends.byAccountCode)
      .slice(0, 6)
      .map(([key, values]) => ({ key, label: key, values }));
    return (
      <>
        <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
        <SmallMultiples panels={panels} months={trends.months} columns={3} />
      </>
    );
  }

  if (slide.kind === 'ratios' && budget.length > 0) {
    return (
      <>
        <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
        <BudgetBulletRow lines={budget} limit={8} />
      </>
    );
  }

  return (
    <>
      <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
      <p className="text-sm text-[var(--ff-text-secondary)]">
        This section has no presentation renderer yet. Open the pack page for its detail.
      </p>
    </>
  );
}
```

`packMappers.ts` is deliberately not imported here. Its `toManagementPandLRows(packToTotals(d))` chain is the pack's own band-total renderer and is correct for the packs page; it is the wrong input for a grid that is showing per-account comparators.

- [ ] **Step 3: Type-check and lint**

```bash
cd <worktree>
bun run type-check
bun run lint
```
Expected: both clean.

- [ ] **Step 4: Browser proof**

With the dev server running and the QA session logged in, open
`http://localhost:3200/accounting/reports/present/board?from=2026-08-01&to=2026-08-31`.
Confirm: no sidebar and no header; the cover names the company and the period; right arrow, space and Page Down all advance; left arrow goes back; End reaches the last slide and a further right arrow holds there; Escape returns to the packs page; the income statement slide shows a Budget column, a variance bar and a sparkline. Screenshot the cover and the income statement slide to `docs/screenshots/ws1-present-cover.png` and `ws1-present-income-statement.png`. Confirm the console is clean.

- [ ] **Step 5: Commit**

```bash
cd <worktree>
git add pages/accounting/reports/present/ src/components/accounting/present/PresentSlide.tsx
git commit -m "feat(present): chrome-free keyboard-paged route for report packs"
```

---

### Task 15: Full gate, module doc, and the PR

**Files:**
- Create: `src/components/accounting/charts/.claude.md`
- Create: `src/components/accounting/present/.claude.md`

- [ ] **Step 1: Write the charts module doc**

```markdown
# charts/

The IBCS chart set. Every chart is two files: a pure option builder and a
thin component.

## Contract: builders are pure, components are thin

`buildXOption(data, palette, opts) → EChartsCoreOption` takes its colours as
an ARGUMENT and never reads `document`. That is what lets the node vitest
config test it, and what keeps SSR safe. The component resolves the palette
through `ChartFrame` and does nothing else.

A chart shows only figures a service returned. The one arithmetic exception,
documented at its call site, is the waterfall's bar GEOMETRY — the number
printed on the bar is still `step.value`.

## IBCS

`ibcs.ts` is the only file that turns a role into ink: actual solid, prior
light grey, budget outline, forecast hatched. `varianceColor` is the only
source of `--ff-fav` / `--ff-unfav`. A category is never coloured by name —
`WaterfallStep.color` is deliberately ignored for that reason.

`axisDomain` always includes zero. Small multiples share one scale.

## Files
- `chartTypes.ts` — `ChartPalette`, `DEFAULT_PALETTE`, `paletteFromTheme`.
- `ibcs.ts` — `roleStyle`, `varianceColor`, `axisDomain`.
- `ChartFrame.tsx` — palette resolution, title, unit note, `unavailable` copy.
- `waterfallOption.ts` / `ProfitWaterfall.tsx` — profit bridge.
- `sankeyOption.ts` / `CashFlowSankey.tsx` — cash flows; refuses a negative balance.
- `bulletOption.ts` / `BudgetBulletRow.tsx` — budget bullets. Polarity from
  the service's favourably-signed `variance`, never from bar length.
- `smallMultiplesOption.ts` / `SmallMultiples.tsx` — 12 months per account.
- `cashPositionOption.ts` / `CashPositionChart.tsx` — the executive dashboard bar.
```

- [ ] **Step 2: Write the present module doc**

```markdown
# present/

Presentation mode: a report pack paged on a boardroom screen.

## No app chrome

`pages/accounting/reports/present/[pack].tsx` does not use `AppLayout`. The
sidebar, header and tenant switcher are what this route removes; adding the
layout back defeats it.

## One slide in the DOM

`PresentDeck` renders only the current slide. Paging holds at both ends
rather than wrapping — a presenter who over-clicks at the end should see the
last slide, not the cover.

Keys: right / down / PageDown / space / enter advance; left / up / PageUp /
backspace go back; Home and End jump; Escape exits.

## Files
- `presentSlides.ts` — `buildSlides`, `clampSlide`. Unknown section types are
  dropped, never paged to as a blank slide.
- `PresentDeck.tsx` — the shell and the keyboard map.
- `PresentSlide.tsx` — section kind → component. Maps, never computes.
```

- [ ] **Step 3: Regenerate the doc mirrors and run the full gate**

```bash
cd <worktree>
bun run agent-docs:generate
bun run ci
```
Expected: every step green, including `agent-docs`, both vitest configs and the production build. If the build reports a bundle-size regression on the dashboard, confirm Recharts is genuinely gone: `grep -rn "recharts" pages/ src/`.

- [ ] **Step 4: Run the integration test against both tenants**

```bash
cd <worktree>
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env.local | cut -d= -f2-)" \
  npx vitest run --config vitest.integration.config.ts tests/integration/accountTrends.int.test.ts
```
Expected: PASS. Run it a second time with the `beforeAll` company switched to Velocity Fibre, confirm PASS, and restore Britech before committing.

- [ ] **Step 5: Commit and open the PR**

```bash
cd <worktree>
git add src/components/accounting/charts/.claude.md src/components/accounting/charts/AGENTS.md src/components/accounting/present/.claude.md src/components/accounting/present/AGENTS.md
git commit -m "docs(charts): module contracts for the chart set and presentation mode"
timeout 420 git push -u origin feat/reporting-ws1-charts
gh pr create --title "feat(reports): IBCS chart set, trend and budget columns, presentation mode" --body-file <(cat <<'BODY'
WS1 of the reporting programme.

- IBCS chart set on the merged ECharts wrapper: profit bridge, cash-flow
  sankey, budget bullets, 12-month small multiples, cash position.
- Recharts removed from the executive dashboard.
- `StatementRow.trend` and `StatementRow.budget` populated from services.
- Owner / accountant density toggle, persisted per user.
- Chrome-free keyboard-paged presentation route for report packs.

Gates: `bun run ci` green; every option builder has a mutation-checked unit
test; the trend service has a footing integration test that passes against
Britech and Velocity Fibre with a real DATABASE_URL; screenshots attached.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)
```

- [ ] **Step 6: Attach the screenshots and request the blind review**

Attach `docs/screenshots/ws1-*.png` to the PR. Then run `/review` on the PR — the reviewer gets the diff and the project rules and none of this session's reasoning — and fix every HIGH, MEDIUM and LOW it returns. Do not merge; the programme lead merges after gates.

---

## Requests to other owners

Each of these is a change this workstream cannot commit under its file ownership. Numbered so a task above can name one.

1. **Ownership of the new directory `src/components/accounting/reportControls/**`** — programme lead. Three new files (`ComparatorControls.tsx`, `DensityToggle.tsx`, `useDensity.ts`). No existing owner: the density toggle and the comparator control are neither charts nor presentation, and putting them in `statement/` would edit WS0's tree. Blocks Task 11.

2. **Ownership of two new API route files** — programme lead, or WS2 if it prefers to own the report HTTP surface. `pages/api/accounting/reports-account-trends.ts` and `pages/api/accounting/reports-budget-comparator.ts`. Both are new files no other workstream touches. Neither can be avoided: `reports-budget-vs-actual` accepts only `period=current|ytd|full_year` and cannot answer an arbitrary date window, and no route exposes a per-account monthly series at all. Full handler code is in Task 10 and can be lifted verbatim. Blocks Tasks 10 and 14.

3. **Three lines in `src/components/accounting/IncomeStatementSections.tsx`** — WS0 / the income-statement surface owner. To turn the trend and budget columns on for the income statement:
   - add optional props `trends?: AccountTrends` and `budgetLines?: BudgetVsActualLine[]`;
   - replace `const rows = toIncomeStatementRows(report, { comparative: showComparative });` with the same call wrapped in `applyTrend` and `applyBudgetComparator` from `statementRows/comparators` when those props are present;
   - change `columns={{ prior: showComparative, budget: false, variance: showComparative, trend: false }}` to take the four flags from a `columns` prop, defaulting to today's values so nothing changes for callers that do not pass it.
   The adapters, their tests and the control component ship in Tasks 9 and 11; this request is the wiring only.

4. **Two fetches and a control in `pages/accounting/reports/income-statement.tsx`** — the income-statement surface owner. Fetch `reports-account-trends` and `reports-budget-comparator` alongside the existing report fetch, hold a `StatementColumns` in state seeded from `useDensity`, render `<ComparatorControls>` next to the existing comparative checkbox, and pass all of it down. Depends on request 3.

5. **The same wiring in `pages/accounting/reports/balance-sheet.tsx`** — the balance-sheet surface owner. Trend only, and it must call the trends route with `basis=balance`: a balance-sheet sparkline drawn from monthly movement describes a series the statement does not print. `toBalanceSheetRows` returns `{ assets, liabilitiesAndEquity }`, so `applyTrend` is called on each array.

6. **A "Present" button on `pages/accounting/reports/report-packs.tsx`** — WS2. One link, next to the existing PDF download, to `/accounting/reports/present/${selectedType}?from=${from}&to=${to}`. Without it the presentation route is reachable only by typing a URL.

7. **Pack sections for the charts** — WS2. The `waterfall` and `trends` pack sections currently render the placeholder strings `'Waterfall chart data available — render with WaterfallChart component'` and `'Trend data requires multi-period historical context'`. `ProfitWaterfall` and `SmallMultiples` now exist and take `WaterfallStep[]` and `TrendPanel[]` respectively; the pack page can drop them in. This workstream's `PresentSlide` already renders both, so the components are proven before WS2 picks them up.

---

## Self-review

**Spec coverage.** Programme scope for WS1, item by item: profit waterfall (Task 3), cash-flow sankey (Task 4), budget bullet row (Task 5), 12-month small multiples (Task 6), the executive dashboard's Recharts chart replaced (Task 7), sparklines into `StatementRow.trend` (Tasks 8 and 9 build and populate it; requests 3–5 wire the two statement pages, and Task 14 proves the whole chain on the presentation route), budget column wired from `budgetVarianceService` (Tasks 9, 10, 11; request 3 wires the income statement), presentation mode (Tasks 12–14), density toggle (Task 11). IBCS rules are enforced in Task 1 and asserted in every chart test. No new dependencies: the plan adds no import that is not already in `package.json`. Footing: Task 8 carries the integration test, and every builder test asserts the plotted values equal the service values.

**Placeholder scan.** One deliberate flag, in Task 8 Step 3: the `rowMissing` helper is shown as a stub and the step text says explicitly that it must not ship as written, with the correct implementation described (thread a `present` mask out of `shape`). That is a hazard call-out rather than a hidden TODO, and it sits on the one piece of logic — zero versus absent month — most likely to be got wrong silently. Task 13 Step 3 likewise flags the unused `go` callback for deletion. No other step defers work.

**Type consistency.** `ChartPalette` is defined in Task 1 and consumed by every builder. `AccountTrends` is defined in Task 8 and consumed in Tasks 9, 10 and 14. `BudgetVsActualLine` is the existing service type throughout — never a local copy. `Slide` and `ReportPack` are defined in Task 12 and used in Tasks 13 and 14. `CashFlowReport` is declared once, in `sankeyOption.ts`. `TrendPanel` is declared once, in `smallMultiplesOption.ts`, and used by `PresentSlide`. `applyTrend` and `applyBudgetComparator` keep the same names in Tasks 9, 11 and 14 and in requests 3–5.

One correction found on review and fixed inline: Task 14 originally fed the income-statement slide from the pack section through `packMappers`. Those rows are band totals with no `accountCode`, so both comparators would have skipped every row and the slide would have shown two empty columns while the tests stayed green. The slide now fetches `reports-income-statement` and maps it with `toIncomeStatementRows`, and the reason is written next to the code so it does not get "simplified" back.

The `PresentSlide` files list in the `present/` module doc (Task 15) says "section kind → component", which still holds; note when writing it that the income-statement slide takes its rows from the report, not the section.
