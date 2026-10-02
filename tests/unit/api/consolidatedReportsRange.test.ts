/**
 * consolidated-reports?action=trial-balance refuses a malformed or inverted range with a 400
 * before any query. Unvalidated, a non-date reached a SQL date cast (or the fiscal-year
 * arithmetic) and surfaced as a 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getConsolidatedTrialBalance } = vi.hoisted(() => ({ getConsolidatedTrialBalance: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => ({ userBelongsToGroup: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/reports/consolidatedReportingService', () => ({
  getConsolidatedTrialBalance, getConsolidatedIncomeStatement: vi.fn(), getConsolidatedBalanceSheet: vi.fn(),
  getGroupDashboardStats: vi.fn(), getEliminationAdjustments: vi.fn(), createEliminationAdjustment: vi.fn(),
  postEliminationAdjustment: vi.fn(), reverseEliminationAdjustment: vi.fn(), autoGenerateEliminations: vi.fn(),
}));

import handler from '../../../pages/api/accounting/consolidated-reports';

function call(query: Record<string, unknown>) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  return handler({ method: 'GET', user: { id: 'u1' }, query: { group_id: 'g', action: 'trial-balance', ...query }, body: {} } as unknown as NextApiRequest,
    res as unknown as NextApiResponse).then(() => res);
}

beforeEach(() => { getConsolidatedTrialBalance.mockReset().mockResolvedValue({}); });

describe('consolidated trial balance range validation', () => {
  it.each([
    [{ period_start: '2026-13-01', period_end: '2026-12-31' }, 'period_start must be a real date'],
    [{ period_start: ' 2026-01-01', period_end: '2026-12-31' }, 'period_start must be a real date'],
    [{ period_start: '2026-01-01', period_end: '0001-01-01' }, 'period_end must be a real date'],
    [{ period_start: ['2026-01-01', '2026-02-01'], period_end: '2026-12-31' }, 'period_start must be a real date'],
    [{ period_start: '2026-12-01', period_end: '2026-01-31' }, 'period_start must not be after period_end'],
    [{ period_end: '2026-12-31' }, 'period_start and period_end required'],
  ])('refuses %j with 400', async (query, message) => {
    const res = await call(query);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(JSON.stringify(res.json.mock.calls[0]![0])).toContain(message);
    expect(getConsolidatedTrialBalance).not.toHaveBeenCalled();
  });

  it('passes a valid range through', async () => {
    const res = await call({ period_start: '2026-01-01', period_end: '2026-12-31' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(getConsolidatedTrialBalance).toHaveBeenCalledWith('g', '2026-01-01', '2026-12-31');
  });
});
