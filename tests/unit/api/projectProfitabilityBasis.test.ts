/**
 * The Project Profitability route and the MCP `project_profitability` tool
 * take `basis` (jobs | cc2) and default to jobs — the `projects` job, as they
 * always read (Hein, 2026-10-10).
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { getProjectProfitability, getProjectTaggingCoverage } = vi.hoisted(() => ({
  getProjectProfitability: vi.fn(), getProjectTaggingCoverage: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reports/financialReportingService', () => ({ getProjectProfitability }));
vi.mock('@/modules/accounting/services/reports/projectProfitabilityService', () => ({
  getProjectProfitability, getProjectTaggingCoverage,
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/reports-project-profitability';
import { projectProfitabilityTool } from '@/lib/mcp/tools/domainReports';
import type { McpToolContext } from '@/lib/mcp/types';

const companyId = '10000000-0000-4000-8000-000000000001';
const run = async (query: Record<string, string>) => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await handler({ method: 'GET', companyId, query: { period_start: '2026-04-01', period_end: '2026-04-30', ...query } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  getProjectProfitability.mockResolvedValue([]);
  getProjectTaggingCoverage.mockResolvedValue({ taggedLines: 0, untaggedLines: 0, untaggedAmount: 0, postedThrough: null });
});

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

it('MCP project_profitability: jobs by default, cc2 through to both reads, anything else refused', async () => {
  const ctx = { userId: 'u', companyId, scopes: ['read:reports'], tokenJti: null, oauthAppId: null } as McpToolContext;
  const call = (args: Record<string, unknown>) =>
    projectProfitabilityTool.handler({ period_start: '2026-01-01', period_end: '2026-12-31', ...args }, ctx);
  await call({});
  expect(getProjectProfitability.mock.calls[0]![3]).toBe('jobs');
  expect(getProjectTaggingCoverage.mock.calls[0]![3]).toBe('jobs');
  const cc2 = await call({ basis: 'cc2' });
  expect(JSON.parse(cc2.content[0]!.text).basis).toBe('cc2');
  expect(getProjectProfitability.mock.calls[1]![3]).toBe('cc2');
  expect(getProjectTaggingCoverage.mock.calls[1]![3]).toBe('cc2');
  expect((await call({ basis: 'projects' })).isError).toBe(true);
  expect(getProjectProfitability).toHaveBeenCalledTimes(2);
});
