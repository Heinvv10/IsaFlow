/**
 * The SFP's derived accumulated profit: raw debit-minus-credit signs, both columns, a taxonomy without BS045, and
 * dividends paid on IS484-mapped equity accounts taken off it.
 */
import { describe, expect, it, vi } from 'vitest';

const retained = vi.hoisted(() => vi.fn(async (_c: string, asAt: string) => (asAt === '2025-12-31' ? 1450 : 400)));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({ calculateRetainedEarnings: retained }));
// No dividends unless a test says so.
const dividends = vi.hoisted(() => vi.fn(async (_c: string, _from: string | null, _through: string) => 0));
vi.mock('@/modules/accounting/services/afs/noteGenerators/primaryStatements/dividendsPaid', () => ({
  DIVIDENDS_PAID_CODE: 'IS484', fetchDividendsPaid: dividends,
}));

// The income statement's opening line reads the ledger; nothing posted unless a test says so.
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ balance: 0 }]) }));
vi.mock('@/modules/accounting/services/gl/trialBalanceBasis', () => ({ getRetainedEarningsBroughtForward: vi.fn(async () => 0) }));
const takeOnByLine = vi.hoisted(() => vi.fn(async (_c: string, _from: string, _through: string) => new Map<string, number>()));
vi.mock('@/modules/accounting/services/afs/noteGenerators/primaryStatements/takeOnEquity', () => ({ fetchTakeOnByLine: takeOnByLine }));

import {
  addDerivedAccumulatedProfit, addDerivedOpeningAccumulatedIncome, ACCUMULATED_TAKE_ON_CODE, DERIVED_ACCUMULATED_PROFIT_CODE,
} from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/derivedAccumulatedProfit';
import type { SectionLine } from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/_helpers';

const line = (code: string, sortOrder: number, cur = 0, prior = 0): SectionLine => ({
  code, label: code, parentCode: 'BS041', noteNumber: null, sortOrder, isHeader: false, isTotal: false,
  currentAmount: cur, priorAmount: prior, totalBasis: 'children', totalComponents: null,
});

describe('addDerivedAccumulatedProfit', () => {
  it('subtracts the credit-positive profit from BS045, current and prior', async () => {
    const out = await addDerivedAccumulatedProfit([line('BS043', 1, -10000, -10000), line('BS045', 2, 0, 0)], 'c', '2025-12-31', '2024-12-31');
    expect(out.find((l) => l.code === 'BS045')).toMatchObject({ currentAmount: -1450, priorAmount: -400 });
    expect(out.find((l) => l.code === 'BS043')).toMatchObject({ currentAmount: -10000 });
  });

  it('adds to what the retained-earnings account already carries', async () => {
    const out = await addDerivedAccumulatedProfit([line('BS045', 2, -100, -50)], 'c', '2025-12-31', null);
    expect(out[0]).toMatchObject({ currentAmount: -1550, priorAmount: -50 });
  });

  it('adds a derived line before total equity when the taxonomy has no BS045', async () => {
    const total = { ...line('BS048', 9), isTotal: true };
    const out = await addDerivedAccumulatedProfit([line('BS043', 1), total], 'c', '2025-12-31', '2024-12-31');
    const derived = out.find((l) => l.code === DERIVED_ACCUMULATED_PROFIT_CODE)!;
    expect(derived).toMatchObject({ currentAmount: -1450, priorAmount: -400, parentCode: 'BS041' });
    expect(derived.sortOrder).toBeLessThan(total.sortOrder);
  });

  it('takes the dividends paid to each date off the accumulated profit, on BS045 and on the derived line', async () => {
    dividends.mockImplementation(async (_c, from, through) => {
      expect(from).toBeNull();
      return through === '2025-12-31' ? 400 : 100;
    });
    try {
      const out = await addDerivedAccumulatedProfit([line('BS045', 2, -50, 0)], 'c', '2025-12-31', '2024-12-31');
      expect(out[0]).toMatchObject({ currentAmount: -50 - 1450 + 400, priorAmount: -400 + 100 });
      const total = { ...line('BS048', 9), isTotal: true };
      const derived = (await addDerivedAccumulatedProfit([total], 'c', '2025-12-31', '2024-12-31'))
        .find((l) => l.code === DERIVED_ACCUMULATED_PROFIT_CODE)!;
      expect(derived).toMatchObject({ currentAmount: -1050, priorAmount: -300 });
    } finally {
      dividends.mockImplementation(async () => 0);
    }
  });

  it('leaves a taxonomy with no equity section alone', async () => {
    const lines = [line('BS001', 1)];
    expect(await addDerivedAccumulatedProfit(lines, 'c', '2025-12-31', null)).toEqual(lines);
  });
});

describe('addDerivedOpeningAccumulatedIncome: the "Balances taken on" line', () => {
  const is485 = { ...line('IS485', 50), parentCode: null, isTotal: true, totalBasis: 'running' as const };

  it('takes the accumulated-profit row and IS484 from the AFS SOCE take-on figures, by line, for each year', async () => {
    takeOnByLine.mockImplementation(async (_c, from) => (from === '2025-01-01'
      ? new Map([['BS045', 100], ['BSACCPL', 5], ['IS484', -30], ['BS043', 999], ['BS044', 7]])
      : new Map([['BS045', 40]])));
    try {
      const out = await addDerivedOpeningAccumulatedIncome([is485], 'c', '2025-01-01', '2025-12-31', '2024-01-01', '2024-12-31');
      const takeOn = out.find((l) => l.code === ACCUMULATED_TAKE_ON_CODE)!;
      // Raw debit-minus-credit: credit-positive 75 (100 + 5 - 30; share capital and reserves are not on the row).
      expect(takeOn).toMatchObject({ currentAmount: -75, priorAmount: -40, label: 'Balances taken on' });
      expect(takeOn.sortOrder).toBeLessThan(is485.sortOrder);
      expect(takeOnByLine).toHaveBeenCalledWith('c', '2025-01-01', '2025-12-31');
      expect(takeOnByLine).toHaveBeenCalledWith('c', '2024-01-01', '2024-12-31');
    } finally {
      takeOnByLine.mockImplementation(async () => new Map());
    }
  });

  it('is 0 with no take-on, and has no comparative without a prior year', async () => {
    takeOnByLine.mockClear();
    const out = await addDerivedOpeningAccumulatedIncome([is485], 'c', '2025-01-01', '2025-12-31', null, null);
    const takeOn = out.find((l) => l.code === ACCUMULATED_TAKE_ON_CODE)!;
    expect(takeOn.currentAmount).toBeCloseTo(0, 2);
    expect(takeOn.priorAmount).toBeCloseTo(0, 2);
    expect(takeOnByLine).toHaveBeenCalledTimes(1);
  });
});
