/**
 * The two margins belong to the SERVICE, not to a component.
 *
 * `IncomeStatementSections` used to derive `grossProfit / totalRevenue` for
 * itself. That is the exact figure a reader took off the screen at 96.6% while
 * R82.7m of direct cost sat in operating expenses — and a component deriving
 * its own copy means no other surface, export or test can see what the screen
 * showed. Mocked rather than DB-gated so the zero-revenue case is reachable on
 * every machine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...args: unknown[]) => sqlMock(...args) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';

const glRow = (
  code: string, name: string, type: 'revenue' | 'expense',
  subtype: string | null, debit: number, credit: number,
) => ({
  account_code: code, account_name: name, account_type: type,
  account_subtype: subtype, total_debit: debit, total_credit: credit,
});

beforeEach(() => sqlMock.mockReset());

describe('getIncomeStatement — margins', () => {
  it('reports gross and net margin as a percentage of turnover', async () => {
    sqlMock.mockResolvedValue([
      glRow('4000', 'Sales', 'revenue', 'revenue', 0, 1000000),
      glRow('5000', 'Direct Material', 'expense', 'cost_of_sales', 400000, 0),
      glRow('6000', 'Rent', 'expense', 'operating_expenses', 100000, 0),
    ]);

    const r = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');

    expect(r.grossProfit).toBeCloseTo(600000, 2);
    expect(r.netProfit).toBeCloseTo(500000, 2);
    expect(r.grossMarginPct).toBeCloseTo(60, 4);
    expect(r.netMarginPct).toBeCloseTo(50, 4);
  });

  it('is null, not zero, when there is no turnover', async () => {
    sqlMock.mockResolvedValue([
      glRow('6000', 'Rent', 'expense', 'operating_expenses', 100000, 0),
    ]);

    const r = await getIncomeStatement('c-1', '2026-01-01', '2026-12-31');

    expect(r.totalRevenue).toBe(0);
    // A margin on no revenue is undefined. Zero would print "0.0%" next to a
    // real loss and read as break-even.
    expect(r.grossMarginPct).toBeNull();
    expect(r.netMarginPct).toBeNull();
  });
});
