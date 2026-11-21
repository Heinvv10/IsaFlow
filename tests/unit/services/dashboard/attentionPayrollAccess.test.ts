/**
 * The dashboard's "Needs attention" list names pay runs, a payroll cash shortfall (with an amount) and links into
 * /payroll/runs/<id>. Without Payroll read none of that is read, so none of it can be listed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sql: vi.fn(), aggregate: vi.fn(), cashPosition: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: h.sql }));
vi.mock('@/lib/saDateParser', () => ({ todayInSast: () => '2026-11-13' }));
vi.mock('@/modules/bureau/services/bureauWorkAggregatorService', () => ({ aggregateBureauWork: h.aggregate }));
vi.mock('@/modules/bureau/services/ownerCashPositionService', () => ({ getOwnerCashPosition: h.cashPosition }));
vi.mock('@/modules/accounting/services/reports/headlineFigures', () => ({
  getHeadlineCounts: vi.fn(async () => ({ billsOverdue: 0, billsDueNext7Days: 0, draftInvoices: 0, draftJournals: 0 })),
}));
vi.mock('@/modules/accounting/services/reports/dashboardOpenBook', () => ({ getOpenBook: vi.fn(async () => ({ overdueCount: 0, overdue: 0 })) }));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({ getCashBalance: vi.fn(async () => ({ total: 100 })) }));
vi.mock('@/modules/accounting/services/dashboard/workbenchService', () => ({
  getUnreconciledBankTxns: vi.fn(async () => 0), getOpenPriorPeriods: vi.fn(async () => 0),
}));

import { getAttentionList } from '@/modules/accounting/services/dashboard/attentionService';

const RUN = '11111111-1111-4111-8111-111111111111';
const payrollSection = { runId: RUN, periodLabel: 'November 2026', canPay: false, totalRequired: 5000, shortfall: 4900, runsCounted: 1, status: 'approved' };

beforeEach(() => {
  vi.clearAllMocks();
  h.sql.mockResolvedValue([{ id: RUN, period_year: 2026, period_month: 11, status: 'approved' }]);
  h.aggregate.mockResolvedValue({ items: [] });
  h.cashPosition.mockImplementation(async (_c: string, cash: number, _n: Date, sections: { payroll: boolean }) => ({
    cash, payroll: sections.payroll ? payrollSection : null, vat: null,
  }));
});

const keys = async (payrollRead: boolean) => (await getAttentionList('co-1', { payrollRead }, new Date('2026-11-13T08:00:00Z'))).items.map((i) => i.key);

describe('getAttentionList', () => {
  it('with Payroll read: the pay run and the payroll shortfall are listed', async () => {
    const k = await keys(true);
    expect(k).toContain(`pay-run-${RUN}`);
    expect(k).toContain('payroll-shortfall');
  });

  it('without Payroll read: no payroll row, and no payroll query at all', async () => {
    const k = await keys(false);
    expect(k.filter((x) => /pay-run|payroll/.test(x))).toEqual([]);
    expect(h.sql).not.toHaveBeenCalled(); // getOpenPayRuns is the only statement this module runs itself
    expect(h.aggregate.mock.calls[0]![3]).toEqual({ payroll: false });
    expect(h.cashPosition.mock.calls[0]![3]).toEqual({ payroll: false });
  });

  it('asks the payroll readers for Payroll only when read is true', async () => {
    await keys(true);
    expect(h.aggregate.mock.calls[0]![3]).toEqual({ payroll: true });
    expect(h.cashPosition.mock.calls[0]![3]).toEqual({ payroll: true });
  });
});
