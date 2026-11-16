import { describe, it, expect, vi, beforeEach } from 'vitest';

const flag = vi.fn();
const fy = vi.fn();
const threeWay = vi.fn();
const balance = vi.fn();
const budgetRead = vi.fn();
vi.mock('@/lib/neon', () => ({ withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(), sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: (...a: unknown[]) => flag(...a) }));
vi.mock('@/modules/accounting/services/budgets/threeWay/threeWayViews', () => ({ getThreeWay: (...a: unknown[]) => threeWay(...a) }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({
  fiscalYearForDate: (...a: unknown[]) => fy(...a),
  FiscalYearLabelUnknownError: class FiscalYearLabelUnknownError extends Error {},
}));

import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import { OpeningUnbalancedError } from '@/modules/accounting/services/budgets/threeWay/errors';
import { BUDGET_REFUSALS, readBudget } from '@/modules/accounting/services/cashForecast13/readBudget';
import { LOAN_REFUSALS } from '@/modules/accounting/services/cashForecast13/readLoans';
import { guardedSource } from '@/modules/accounting/services/cashForecast13/guardedSource';
import type { ForecastWarning } from '@/modules/accounting/services/cashForecast13/types';

const view = (fiscalYear: number) => ({
  version: { fiscalYear }, assumptions: { resolved: { vat: { refundLagMonths: { value: 2 } } } }, vatSettlements: [], taxEvents: [],
  cashFlow: { direct: [{ month: '2026-12', direct: { cash_received_from_customers: 500, cash_paid_to_suppliers: -200 } }, { month: '2027-06', direct: { cash_received_from_customers: 9, cash_paid_to_suppliers: -9 } }] },
});

beforeEach(() => { flag.mockReset(); fy.mockReset(); threeWay.mockReset(); balance.mockReset(); budgetRead.mockReset(); });

describe('cash13 readBudget', () => {
  it('flag off: null and budget_flag_off', async () => {
    flag.mockResolvedValue(false);
    const w: ForecastWarning[] = [];
    expect(await readBudget('co', '2026-11-18', '2027-02-14', w)).toBeNull();
    expect(w.map((x) => x.code)).toEqual(['budget_flag_off']);
  });

  it('a primary version: its months inside the horizon, its refund lag', async () => {
    flag.mockResolvedValue(true);
    fy.mockResolvedValue({ fiscalYear: 2027 });
    threeWay.mockResolvedValue(view(2027));
    const r = await readBudget('co', '2026-11-18', '2027-02-14', []);
    expect(r).toMatchObject({ months: [{ month: '2026-12', customerReceipts: 500, supplierPayments: -200 }], refundLagMonths: 2 });
    expect(threeWay).toHaveBeenCalledTimes(1);
  });

  it('no primary version → budget_no_primary; another typed refusal → budget_unavailable; both null', async () => {
    flag.mockResolvedValue(true);
    fy.mockResolvedValueOnce({ fiscalYear: 2027 }).mockResolvedValueOnce({ fiscalYear: 2028 });
    threeWay.mockRejectedValueOnce(new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'none')).mockRejectedValueOnce(new OpeningUnbalancedError(5));
    const w: ForecastWarning[] = [];
    expect(await readBudget('co', '2026-11-18', '2027-03-14', w)).toBeNull();
    expect(w.map((x) => x.code)).toEqual(['budget_no_primary', 'budget_unavailable']);
  });

  it('a code bug in the three-way propagates', async () => {
    flag.mockResolvedValue(true);
    fy.mockResolvedValue({ fiscalYear: 2027 });
    threeWay.mockRejectedValue(new TypeError('bug'));
    await expect(readBudget('co', '2026-11-18', '2027-02-14', [])).rejects.toThrow('bug');
  });
});

describe('cash13 domain refusals become one source’s warning (review L1)', () => {
  it('no fiscal year for the horizon end: the budget source warns, the forecast goes on', async () => {
    flag.mockResolvedValue(true);
    fy.mockRejectedValue(new Error('fiscalYearForDate: no fiscal year for company co on 2027-02-14'));
    const w: ForecastWarning[] = [];
    expect(await guardedSource('sp', 'budget', w, () => readBudget('co', '2026-11-18', '2027-02-14', w), BUDGET_REFUSALS)).toBeNull();
    expect(w).toEqual([expect.objectContaining({ code: 'source_unavailable', source: 'budget', message: expect.stringContaining('no fiscal year') })]);
  });

  it('the loan refusals are recognised by message; anything else is not', () => {
    expect(LOAN_REFUSALS(new Error('Loan 5b1e not found'))).toBe(true);
    expect(LOAN_REFUSALS(new Error('Rate curve is empty'))).toBe(true);
    expect(LOAN_REFUSALS(new Error('Loan skips more periods than it repays: term extension exceeded 12 periods.'))).toBe(true);
    expect(LOAN_REFUSALS(new TypeError("Cannot read properties of undefined (reading 'date')"))).toBe(false);
    expect(LOAN_REFUSALS(new Error('prefix Loan x not found'))).toBe(false);
  });

  it('a code bug is still thrown through a source that has refusals', async () => {
    await expect(guardedSource('sp', 'loan', [], () => Promise.reject(new TypeError('bug')), LOAN_REFUSALS)).rejects.toThrow('bug');
  });
});
