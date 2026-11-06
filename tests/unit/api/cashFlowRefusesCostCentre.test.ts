/**
 * The Cash Flow routes refuse a cost-centre parameter (there is no cost-centre cash flow: cash is held in bank accounts,
 * which no cost centre owns) instead of answering the whole company's statement as if it were filtered.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
const indirect = vi.hoisted(() => vi.fn(async () => ({ periodStart: '', periodEnd: '', openingCash: 0, sections: [], netChange: 0, closingCash: 0 })));
vi.mock('@/modules/accounting/services/reports/cashFlowIndirectService', () => ({ getIndirectCashFlow: indirect }));

import screen from '../../../pages/api/accounting/reports-cash-flow';
import exportCsv from '../../../pages/api/accounting/cash-flow-export';

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
async function call(route: unknown, query: Record<string, string>) {
  const res = { statusCode: 200, body: undefined as unknown, setHeader() { return res; }, status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.body = p; return res; }, send(p: unknown) { res.body = p; return res; }, end() { return res; } };
  await (route as Handler)({ method: 'GET', query, headers: {}, companyId: 'co-1' } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}
const PERIOD = { period_start: '2026-01-01', period_end: '2026-01-31' };

describe.each([['reports-cash-flow', screen], ['cash-flow-export', exportCsv]])('%s', (_name, route) => {
  it.each(['cost_centre', 'cost_centre_id'])('answers 400 to ?%s and reads nothing', async (param) => {
    indirect.mockClear();
    const res = await call(route, { ...PERIOD, [param]: 'cc1' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/cost centre/i);
    expect(indirect).not.toHaveBeenCalled();
  });

  it('still answers without one', async () => {
    const res = await call(route, PERIOD);
    expect(res.statusCode).toBe(200);
  });

  it('an empty cost-centre value (the old "All Cost Centres" selection) is no filter', async () => {
    const res = await call(route, { ...PERIOD, cost_centre: '' });
    expect(res.statusCode).toBe(200);
  });
});
