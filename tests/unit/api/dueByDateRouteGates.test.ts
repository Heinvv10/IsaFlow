/**
 * The inner wrappers of the due-by-date routes, REAL: withWriteAccess (a non-writer gets 403 on a mutating
 * method, so the route is not reachable by one) and withErrorHandler (a thrown error answers 500 and is logged
 * once, by the wrapper). Only withAuth is replaced, by a pass-through that sets the company and role; the
 * 401 without a session is pinned in dueByDateRouteWrappers.test.ts, which uses the real one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const role = vi.hoisted(() => ({ value: 'owner' }));
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ...actual,
    withAuth: (h: (a: NextApiRequest, b: NextApiResponse) => unknown) => (req: NextApiRequest, res: NextApiResponse) => {
      Object.assign(req, { companyId: 'co-1', companyRole: role.value });
      return h(req, res);
    },
  };
});
const logged = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/logger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/logger')>('@/lib/logger');
  return { ...actual, log: logged.log, apiLogger: logged.api };
});
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/apAgingInvoices', () => ({ fetchAPAgingInvoices: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/arAgingInvoices', () => ({ fetchARAgingInvoices: vi.fn() }));

import { fetchAPAgingInvoices } from '@/modules/accounting/services/ap/apAgingInvoices';
import { fetchARAgingInvoices } from '@/modules/accounting/services/ar/arAgingInvoices';
import summary from '../../../pages/api/accounting/reports/due-by-date';
import xlsx from '../../../pages/api/accounting/reports/due-by-date-xlsx';

function run(route: unknown, method = 'GET') {
  const out = { status: 200, body: undefined as unknown, sent: false };
  const res = {
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.body = b; out.sent = true; return this; },
    setHeader() { return this; },
    end() { return this; },
    write() { return true; },
    on() { return this; }, once() { return this; }, emit() { return true; },
    getHeader() { return undefined; },
    headersSent: false,
  };
  const req = { method, query: { by_date: '2999-01-31' }, headers: {}, url: '/api/accounting/reports/due-by-date' };
  return (route as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(
    req as unknown as NextApiRequest, res as unknown as NextApiResponse,
  ).then(() => out);
}

const errorLines = () => logged.log.error.mock.calls.length + logged.api.error.mock.calls.length;

beforeEach(() => {
  role.value = 'owner';
  for (const f of [...Object.values(logged.log), ...Object.values(logged.api)]) f.mockReset();
  vi.mocked(fetchAPAgingInvoices).mockReset().mockResolvedValue([]);
  vi.mocked(fetchARAgingInvoices).mockReset().mockResolvedValue([]);
});

describe.each([['due-by-date', summary], ['due-by-date-xlsx', xlsx]] as const)('%s', (_name, route) => {
  it('lets an owner read it', async () => {
    expect((await run(route)).status).toBe(200);
  });

  it('withWriteAccess is applied: a viewer is refused a mutating method with 403 (an owner gets 405)', async () => {
    role.value = 'viewer';
    expect((await run(route, 'POST')).status).toBe(403);
    role.value = 'owner';
    expect((await run(route, 'POST')).status).toBe(405);
  });

  it('withErrorHandler is applied, and a database failure is logged exactly once', async () => {
    vi.mocked(fetchARAgingInvoices).mockRejectedValue(new Error('connection reset'));
    const r = await run(route);
    expect(r.status).toBe(500);
    expect(errorLines()).toBe(1);
  });
});
