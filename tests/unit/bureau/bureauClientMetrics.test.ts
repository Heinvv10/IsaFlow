import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getHeadlineFigures } = vi.hoisted(() => ({ getHeadlineFigures: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/headlineFigures', () => ({ getHeadlineFigures }));

import { clientMetricsSnapshot } from '@/modules/bureau/services/bureauClientMetricsService';

const HEADLINE = {
  asAt: '2026-11-12', monthStart: '2026-11-01',
  cash: 142000.5, receivables: { total: 88000, overdue: 1000 }, payables: { total: 31000, overdue: 0 },
  revenueMtd: 210000, profitMtd: 64000,
  draftInvoices: 1, draftBills: 2, draftJournals: 3, billsDueNext7Days: 4, billsOverdue: 5,
};

describe('clientMetricsSnapshot is the headline figures', () => {
  beforeEach(() => { getHeadlineFigures.mockReset(); });

  it('maps every metric from getHeadlineFigures for the company, with its as-at date', async () => {
    getHeadlineFigures.mockResolvedValue(HEADLINE);
    expect(await clientMetricsSnapshot('co-1')).toEqual({
      cash: 142000.5, ar: 88000, ap: 31000, revenueMtd: 210000, profitMtd: 64000, asAt: '2026-11-12',
    });
    expect(getHeadlineFigures).toHaveBeenCalledWith('co-1');
  });

  it('a failed read rejects: no zero figures stand in for it', async () => {
    getHeadlineFigures.mockRejectedValue(new Error('db down'));
    await expect(clientMetricsSnapshot('co-1')).rejects.toThrow('db down');
  });
});
