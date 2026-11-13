/**
 * Compare tab rules (budgets P6 spec §13.22): Δ = version − first, coloured ONLY through `ibcs.varianceColor`
 * from the server's `favourable` (cash higher = good, AR/AP/net debt lower = good), Δ = 0 neutral, Δ% "—" when
 * the first is 0.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import { deltaColour, deltaPctText, kpiRows } from '@/components/accounting/budgets/threeWay/compareModel';
import type { CompareView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';

const k = (value: number, delta: number, deltaPct: number | null, favourable: boolean | null) => ({ value, delta, deltaPct, favourable });

describe('deltaColour', () => {
  it('favourable → the fav ink, unfavourable → the unfav ink', () => {
    expect(deltaColour(k(10, 5, 50, true), DEFAULT_PALETTE)).toBe(DEFAULT_PALETTE.fav);
    expect(deltaColour(k(10, -5, -50, false), DEFAULT_PALETTE)).toBe(DEFAULT_PALETTE.unfav);
  });
  it('Δ = 0 (favourable null) is neutral: no colour', () => {
    expect(deltaColour(k(10, 0, 0, null), DEFAULT_PALETTE)).toBeUndefined();
  });
  it('the colour follows `favourable`, not the sign: a lower receivables figure is good news', () => {
    expect(deltaColour(k(100, -20, -20, true), DEFAULT_PALETTE)).toBe(DEFAULT_PALETTE.fav);
    expect(deltaColour(k(100, 20, 20, false), DEFAULT_PALETTE)).toBe(DEFAULT_PALETTE.unfav);
  });
});

describe('deltaPctText', () => {
  it('"—" when the first version is 0 (deltaPct null)', () => {
    expect(deltaPctText(k(5, 5, null, true))).toBe('—');
  });
  it('signed percentage otherwise', () => {
    expect(deltaPctText(k(150, 50, 50, true))).toBe('+50.0%');
    expect(deltaPctText(k(50, -50, -50, false))).toBe('−50.0%');
  });
});

describe('kpiRows', () => {
  const view: CompareView = {
    fiscalYear: 2027,
    months: ['2026-03'],
    versions: [
      { versionId: 'a', name: 'Base', cashSeries: [100], cashDelta: [0], minCashMonth: '2026-03', warnings: [], kpis: {
        closingCash: k(100, 0, 0, null), minCash: k(100, 0, 0, null), netProfit: k(0, 0, null, null),
        closingReceivables: k(10, 0, 0, null), closingPayables: k(5, 0, 0, null), netDebt: k(-100, 0, 0, null) } },
      { versionId: 'b', name: 'Worst', cashSeries: [80], cashDelta: [-20], minCashMonth: '2026-03', warnings: [], kpis: {
        closingCash: k(80, -20, -20, false), minCash: k(80, -20, -20, false), netProfit: k(0, 0, null, null),
        closingReceivables: k(30, 20, 200, false), closingPayables: k(5, 0, 0, null), netDebt: k(-80, 20, 20, false) } },
    ],
  };
  it('one row per KPI, a cell per version, the first version carries no Δ', () => {
    const rows = kpiRows(view);
    expect(rows.map((r) => r.kpi)).toEqual(['closingCash', 'minCash', 'netProfit', 'closingReceivables', 'closingPayables', 'netDebt']);
    expect(rows[0]!.cells.map((c) => c.showDelta)).toEqual([false, true]);
    expect(rows[0]!.cells[1]!.kpi.delta).toBe(-20);
  });
});
