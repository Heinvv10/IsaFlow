/** The SFP's derived accumulated profit: raw debit-minus-credit signs, both columns, and a taxonomy without BS045. */
import { describe, expect, it, vi } from 'vitest';

const retained = vi.hoisted(() => vi.fn(async (_c: string, asAt: string) => (asAt === '2025-12-31' ? 1450 : 400)));
vi.mock('@/modules/accounting/services/reports/balanceSheetService', () => ({ calculateRetainedEarnings: retained }));

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

  it('leaves a taxonomy with no equity section alone', async () => {
    const lines = [line('BS001', 1)];
    expect(await addDerivedAccumulatedProfit(lines, 'c', '2025-12-31', null)).toEqual(lines);
  });
});
