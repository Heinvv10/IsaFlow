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

import {
  addDerivedAccumulatedProfit, DERIVED_ACCUMULATED_PROFIT_CODE,
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
