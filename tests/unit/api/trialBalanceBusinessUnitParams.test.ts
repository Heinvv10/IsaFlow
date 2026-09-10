import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getTrialBalance, getTrialBalanceReport } = vi.hoisted(() => ({
  getTrialBalance: vi.fn(),
  getTrialBalanceReport: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/trialBalanceService', () => ({
  getTrialBalance,
  getTrialBalanceReport,
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (handler: unknown) => handler, withWriteAccess: (handler: unknown) => handler }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (handler: unknown) => handler }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (handler: unknown) => handler }));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 0 }));

import reportHandler from '../../../pages/api/accounting/reports-trial-balance';
import exportHandler from '../../../pages/api/accounting/trial-balance-export';

const companyId = '10000000-0000-4000-8000-000000000001';
const periodId = '20000000-0000-4000-8000-000000000001';
const businessUnitId = '30000000-0000-4000-8000-000000000001';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn(), send: vi.fn() } as unknown as NextApiResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  getTrialBalanceReport.mockResolvedValue({ rows: [], accountCount: 0, totalDebit: 0, totalCredit: 0, difference: 0, balanced: true });
  getTrialBalance.mockResolvedValue([]);
});

describe.each([reportHandler, exportHandler])('trial balance business-unit validation', handler => {
  it.each(['broken', '', [businessUnitId], [businessUnitId, businessUnitId]])('rejects %j before querying', async invalid => {
    const res = response();
    await handler({ method: 'GET', companyId, query: {
      fiscal_period_id: periodId,
      business_unit_id: invalid,
    } } as unknown as NextApiRequest, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ message: 'business_unit_id must be a valid UUID' }),
    }));
    expect(getTrialBalanceReport).not.toHaveBeenCalled();
  });
});

it('passes a valid business unit into the trial balance report', async () => {
  const res = response();
  await reportHandler({ method: 'GET', companyId, query: {
    fiscal_period_id: periodId,
    business_unit_id: businessUnitId,
  } } as unknown as NextApiRequest, res);
  expect(getTrialBalanceReport).toHaveBeenCalledWith(companyId, periodId, {
    businessUnitId,
    costCentreId: undefined,
    includeZeroBalances: false,
  });
});

it('uses the same business unit for the comparison period', async () => {
  const res = response();
  await reportHandler({ method: 'GET', companyId, query: {
    fiscal_period_id: periodId,
    compare_period_id: '20000000-0000-4000-8000-000000000002',
    business_unit_id: businessUnitId,
  } } as unknown as NextApiRequest, res);
  expect(getTrialBalance).toHaveBeenCalledWith(
    companyId,
    '20000000-0000-4000-8000-000000000002',
    undefined,
    { businessUnitId, includeZeroBalances: false },
  );
});
