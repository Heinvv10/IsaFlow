/**
 * The Project Profitability route takes `basis` (jobs | cc2) and defaults to
 * jobs — the `projects` job, as it always read (Hein, 2026-10-10).
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getProjectProfitability } = vi.hoisted(() => ({ getProjectProfitability: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/financialReportingService', () => ({ getProjectProfitability }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/reports-project-profitability';

const companyId = '10000000-0000-4000-8000-000000000001';
const run = async (query: Record<string, string>) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await handler({ method: 'GET', companyId, query: { period_start: '2026-04-01', period_end: '2026-04-30', ...query } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse);
  return res;
};

beforeEach(() => { vi.clearAllMocks(); getProjectProfitability.mockResolvedValue([]); });

it('defaults to jobs and passes cc2 through', async () => {
  await run({});
  expect(getProjectProfitability).toHaveBeenLastCalledWith(companyId, '2026-04-01', '2026-04-30', 'jobs');
  await run({ basis: 'cc2' });
  expect(getProjectProfitability).toHaveBeenLastCalledWith(companyId, '2026-04-01', '2026-04-30', 'cc2');
});

it('refuses an unknown basis before querying', async () => {
  const res = await run({ basis: 'projects' });
  expect(res.status).toHaveBeenCalledWith(400);
  expect(getProjectProfitability).not.toHaveBeenCalled();
});
