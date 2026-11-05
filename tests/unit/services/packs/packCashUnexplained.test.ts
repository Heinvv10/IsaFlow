/**
 * PAGE 8 AND A LEDGER FAULT. The operating figure is the cash movement the cash flow statement's journals explain; what they
 * cannot explain (a cash leg on the year-end journal, a posted journal that does not balance) is its own row, shown only when
 * there is one, and the bridge draws the same gap as its unexplained step. It is never folded into operating cash.
 */
import { describe, expect, it } from 'vitest';
import { buildCashWaterfallChart, CASH_UNCAPTURED_LABEL } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { buildCashTable } from '@/modules/accounting/services/packs/pages/packStatementTables';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { demoSet, figures } from './fixtures/boardPackInputs';

const base = { operatingCashFlow: 1_000, investingCashFlow: -200, financingCashFlow: 50, capitalExpenditure: undefined };
const withUnexplained = (cashFlowUnexplained: number | undefined): PackFigureSet => ({
  ...demoSet,
  prior: figures({ cash: 5_000 }),
  current: figures({ ...base, cash: 5_000 + 850 + (cashFlowUnexplained ?? 0), cashFlowUnexplained }),
});

describe('page 8 with a cash movement the journals do not explain', () => {
  it('prints an unexplained row between financing and closing cash, and leaves operating as the journals explain it', () => {
    const table = buildCashTable(withUnexplained(400), new PackFigureProvenance());
    const labels = table.rows.map((r) => r.label);
    expect(labels).toEqual(['Opening cash', 'Operating cash flow', 'Investing cash flow', 'Financing cash flow', CASH_UNCAPTURED_LABEL, 'Closing cash']);
    expect(JSON.stringify(table.rows.find((r) => r.label === 'Operating cash flow'))).toContain('1000');
    expect(JSON.stringify(table.rows.find((r) => r.label === CASH_UNCAPTURED_LABEL))).toContain('400');
  });

  it('prints no row when the journals explain the cash (zero or absent)', () => {
    for (const none of [0, undefined]) {
      const labels = buildCashTable(withUnexplained(none), new PackFigureProvenance()).rows.map((r) => r.label);
      expect(labels).not.toContain(CASH_UNCAPTURED_LABEL);
    }
  });

  it('the bridge draws the gap as its unexplained step', () => {
    const bridge = buildCashWaterfallChart(withUnexplained(400), PACK_SCALE);
    if (!bridge.drawn) throw new Error(`no bridge was drawn: ${bridge.why}`);
    expect(bridge.residual).toBeCloseTo(400, 2);
    expect(bridge.chart.waterfallBars!.map((b) => b.label)).toContain(CASH_UNCAPTURED_LABEL);
  });
});
