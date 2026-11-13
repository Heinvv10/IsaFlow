/**
 * The three-way grids' rows (budgets P6 spec §8): every subtotal is the engine's figure; the line rows of each
 * section add up to it (the engine's sectioning); the cash flow's closing cash is the balance sheet's cash (I2)
 * and the direct operating equals the indirect (I3); FY = the flows' sum, opening the first, closing the last.
 */
import { describe, expect, it } from 'vitest';
import { balanceSheetModel, cashFlowModel, indirectModel, type GridModel } from '@/components/accounting/budgets/threeWay/threeWayRows';
import { threeWayView, MONTHS } from '../components/budgets/threeWay/fixtures';

const row = (m: GridModel, key: string) => m.rows.find((r) => r.key === key)!.values;
const sum = (m: GridModel, keys: string[], col: number) => keys.reduce((s, k) => s + (row(m, k)[col] as number), 0);

describe('balanceSheetModel', () => {
  const v = threeWayView();
  const m = balanceSheetModel(v);
  it('columns: opening, each month, FY close', () => {
    expect(m.columns).toEqual(['Opening 2026-02-28', ...MONTHS, 'FY close']);
  });
  it('sections add up to the engine subtotals, every column; check 0', () => {
    for (let c = 0; c < m.columns.length; c++) {
      expect(sum(m, ['cash', 'receivables', 'inventory', 'vatAsset', 'otherCurrentAssets'], c)).toBe(row(m, 'currentAssets')[c]);
      expect(sum(m, ['payables', 'payrollLiabilities', 'incomeTaxPayable', 'dividendsPayable', 'vatLiability', 'otherCurrentLiabilities'], c)).toBe(row(m, 'currentLiabilities')[c]);
      expect(sum(m, ['shareCapital', 'otherEquity', 'retainedEarnings'], c)).toBe(row(m, 'equity')[c]);
      expect(row(m, 'check')[c]).toBe(0);
    }
  });
  it('F1-like figures: cash R100 000 opening, AR 30 days of R31 000 in March', () => {
    expect(row(m, 'cash')[0]).toBe(100_000_00);
    expect(row(m, 'shareCapital')[0]).toBe(100_000_00);
    expect(row(m, 'receivables')[1]).toBe(v.balanceSheet[0]!.closing.receivables);
    expect(row(m, 'cash').at(-1)).toBe(row(m, 'cash').at(-2));
  });
  it('a section heading has no figures', () => {
    expect(row(m, 'h-ca').every((x) => x === null)).toBe(true);
  });
});

describe('cashFlowModel / indirectModel', () => {
  const v = threeWayView();
  const cf = cashFlowModel(v);
  const ind = indirectModel(v);
  const bs = balanceSheetModel(v);
  it('closing cash each month = the balance sheet cash (I2); FY closing = the last month, opening = the first', () => {
    MONTHS.forEach((_, i) => expect(row(cf, 'closingCash')[i]).toBe(row(bs, 'cash')[i + 1]));
    expect(row(cf, 'closingCash').at(-1)).toBe(row(bs, 'cash').at(-1));
    expect(row(cf, 'openingCash').at(-1)).toBe(100_000_00);
  });
  it('operating = the indirect operating (I3), every column; FY = the sum of the months', () => {
    expect(row(cf, 'operating')).toEqual(row(ind, 'ind-operating'));
    const months = row(cf, 'net').slice(0, -1) as number[];
    expect(row(cf, 'net').at(-1)).toBe(months.reduce((s, x) => s + x, 0));
  });
});
