/**
 * consolidated-reports refuses a malformed or inverted date with a 400 before any query, on
 * every action that takes dates: GET trial-balance, income-statement, balance-sheet and
 * eliminations; POST create-elimination and auto-eliminate. Unvalidated, a non-date reached
 * a SQL date cast (or the fiscal-year arithmetic) and surfaced as a 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({
  getConsolidatedTrialBalance: vi.fn(), getConsolidatedIncomeStatement: vi.fn(), getConsolidatedBalanceSheet: vi.fn(),
  getGroupDashboardStats: vi.fn(), getEliminationAdjustments: vi.fn(), createEliminationAdjustment: vi.fn(),
  postEliminationAdjustment: vi.fn(), reverseEliminationAdjustment: vi.fn(), autoGenerateEliminations: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => ({ userBelongsToGroup: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/reports/consolidatedReportingService', () => svc);

import handler from '../../../pages/api/accounting/consolidated-reports';

async function call(method: 'GET' | 'POST', action: string, params: Record<string, unknown>) {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  const req = method === 'GET'
    ? { method, user: { id: 'u1' }, query: { group_id: 'g', action, ...params }, body: {} }
    : { method, user: { id: 'u1' }, query: { group_id: 'g', action }, body: { adjustmentType: 'ic', lines: [{}], ...params } };
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset().mockResolvedValue([]);
});

const RANGE_BAD: Array<[Record<string, unknown>, string]> = [
  [{ period_start: '2026-13-01', period_end: '2026-12-31' }, 'period_start must be a real date'],
  [{ period_start: ' 2026-01-01', period_end: '2026-12-31' }, 'period_start must be a real date'],
  [{ period_start: '2026-01-01', period_end: '0001-01-01' }, 'period_end must be a real date'],
  [{ period_start: ['2026-01-01', '2026-02-01'], period_end: '2026-12-31' }, 'period_start must be a real date'],
  [{ period_start: '2026-12-01', period_end: '2026-01-31' }, 'period_start must not be after period_end'],
];
const camel = (q: Record<string, unknown>) => ({ periodStart: q.period_start, periodEnd: q.period_end });
const camelMsg = (m: string) => m.replace('period_start', 'periodStart').replace('period_end', 'periodEnd');

const cases: Array<{ method: 'GET' | 'POST'; action: string; fn: keyof typeof svc; bad: Array<[Record<string, unknown>, string]>; good: Record<string, unknown> }> = [
  { method: 'GET', action: 'trial-balance', fn: 'getConsolidatedTrialBalance',
    bad: [...RANGE_BAD, [{ period_end: '2026-12-31' }, 'period_start and period_end required']],
    good: { period_start: '2026-01-01', period_end: '2026-12-31' } },
  { method: 'GET', action: 'income-statement', fn: 'getConsolidatedIncomeStatement',
    bad: [...RANGE_BAD, [{ period_start: '2026-01-01' }, 'period_start and period_end required']],
    good: { period_start: '2026-01-01', period_end: '2026-12-31' } },
  { method: 'GET', action: 'balance-sheet', fn: 'getConsolidatedBalanceSheet',
    bad: [[{ as_at_date: '2026-02-30' }, 'as_at_date must be a real date'], [{ as_at_date: ['2026-01-01', '2026-02-01'] }, 'as_at_date must be a real date'],
      [{}, 'as_at_date required']],
    good: { as_at_date: '2026-09-30' } },
  { method: 'GET', action: 'eliminations', fn: 'getEliminationAdjustments', bad: RANGE_BAD, good: {} },
  { method: 'POST', action: 'create-elimination', fn: 'createEliminationAdjustment',
    bad: RANGE_BAD.map(([q, m]) => [camel(q), camelMsg(m)]), good: { periodStart: '2026-01-01', periodEnd: '2026-01-31' } },
  { method: 'POST', action: 'auto-eliminate', fn: 'autoGenerateEliminations',
    bad: [...RANGE_BAD.map(([q, m]) => [camel(q), camelMsg(m)] as [Record<string, unknown>, string]),
      [{ periodStart: '2026-01-01' }, 'periodStart and periodEnd required']],
    good: { periodStart: '2026-01-01', periodEnd: '2026-01-31' } },
];

describe.each(cases)('consolidated-reports $method $action date validation', ({ method, action, fn, bad, good }) => {
  it.each(bad)('refuses %j with 400 before any query', async (params, message) => {
    const res = await call(method, action, params);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(JSON.stringify(res.json.mock.calls[0]![0])).toContain(message);
    expect(svc[fn]).not.toHaveBeenCalled();
  });

  it('passes valid dates through', async () => {
    const res = await call(method, action, good);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(svc[fn]).toHaveBeenCalledTimes(1);
  });
});
