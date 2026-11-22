/**
 * #1656 round 9 (breaker MEDIUM): practice_staff_cost_rates.cost_rate is one person's internal cost per hour. Its GETs
 * (staff-cost-rates, staff-cost-rates/[id]) need Payroll read, its writes Payroll write; the client profitability report returns
 * timeCost / margin / marginPct only to a reader with Payroll read (the cost query is not even run otherwise).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/practice/practiceCostRateService', () => ({
  listCostRates: vi.fn(async () => [{ id: 'r1', costRate: 350 }]),
  getCostRate: vi.fn(async () => ({ id: 'r1', costRate: 350 })),
  createCostRate: vi.fn(async () => ({ id: 'r2' })),
  updateCostRate: vi.fn(async () => ({ id: 'r1' })),
  deleteCostRate: vi.fn(async () => undefined),
}));
const sqlCalls = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (s: TemplateStringsArray) => {
    const q = s.join('?'); sqlCalls.push(q);
    return q.includes('practice_staff_cost_rates') ? [{ practice_client_id: 'pc1', time_cost: '120' }] : [{ practice_client_id: 'pc1', legal_name: 'Acme', revenue: '1000', hours: '10' }];
  }),
}));

import { checkPermission } from '@/lib/auth/permissionService';
import * as rates from '@/modules/accounting/services/practice/practiceCostRateService';
import { getClientProfitability } from '@/modules/accounting/services/practice/practiceReportsService';
import list from '../../../pages/api/accounting/practice/staff-cost-rates';
import one from '../../../pages/api/accounting/practice/staff-cost-rates/[id]';
import profitability from '../../../pages/api/accounting/practice/reports/profitability';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
let perms = { read: false, write: false };

function call(handler: unknown, method: string, query: Record<string, unknown> = {}) {
  const req = { method, query, body: { userId: U, costRate: 1, effectiveFrom: '2026-01-01' }, companyId: C, companyRole: 'manager', user: { id: U }, headers: {} } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  return Promise.resolve((handler as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}
beforeEach(() => {
  vi.clearAllMocks(); sqlCalls.length = 0;
  perms = { read: false, write: false };
  vi.mocked(checkPermission).mockImplementation(async (_c, _u, m, a) => m !== 'payroll' || (a === 'read' ? perms.read : a === 'write' ? perms.write : false));
});

describe('staff cost rates', () => {
  it.each([['list', list, {}], ['detail', one, { id: 'r1' }]] as const)('GET %s: 403 without Payroll read, nothing read; with it the rate is returned', async (_n, handler, q) => {
    expect((await call(handler, 'GET', q)).statusCode).toBe(403);
    expect(rates.listCostRates).not.toHaveBeenCalled();
    expect(rates.getCostRate).not.toHaveBeenCalled();
    perms.read = true;
    expect((await call(handler, 'GET', q)).statusCode).toBe(200);
  });
  it('POST / PUT / DELETE need Payroll write (read alone is refused, nothing written)', async () => {
    perms.read = true;
    for (const [h, m, q] of [[list, 'POST', {}], [one, 'PUT', { id: 'r1' }], [one, 'DELETE', { id: 'r1' }]] as const) expect((await call(h, m, q)).statusCode, m).toBe(403);
    expect(rates.createCostRate).not.toHaveBeenCalled();
    expect(rates.updateCostRate).not.toHaveBeenCalled();
    expect(rates.deleteCostRate).not.toHaveBeenCalled();
    perms.write = true;
    expect((await call(list, 'POST')).statusCode).toBe(201);
  });
});

describe('client profitability', () => {
  it('the service without costVisible runs no cost query and returns null timeCost, margin and marginPct; with it, the figures', async () => {
    const hidden = await getClientProfitability(C, { dateFrom: '2026-01-01', dateTo: '2026-01-31' }, false);
    expect(hidden).toEqual([{ practiceClientId: 'pc1', legalName: 'Acme', revenue: 1000, hours: 10, timeCost: null, margin: null, marginPct: null }]);
    expect(sqlCalls.some((q) => q.includes('practice_staff_cost_rates'))).toBe(false);
    sqlCalls.length = 0;
    const shown = await getClientProfitability(C, { dateFrom: '2026-01-01', dateTo: '2026-01-31' }, true);
    expect(shown[0]).toMatchObject({ timeCost: 120, margin: 880, marginPct: 88 });
  });
  it('the route asks Payroll read and passes it as costVisible', async () => {
    let res = await call(profitability, 'GET', { dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    expect((res.sent as { data: Array<{ timeCost: number | null }> }).data[0]!.timeCost).toBeNull();
    perms.read = true;
    res = await call(profitability, 'GET', { dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    expect((res.sent as { data: Array<{ timeCost: number | null }> }).data[0]!.timeCost).toBe(120);
  });
});
