/**
 * The two due-by-date routes sit behind the REAL withAuth: no session, no data. Nothing in this file mocks
 * the wrappers, so a route exported bare (or with a wrapper dropped) fails here.
 */
import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/modules/accounting/services/reports/dueByDateService', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/reports/dueByDateService')>(
    '@/modules/accounting/services/reports/dueByDateService',
  );
  return { ...actual, getDueByDateReport: vi.fn(), getDueByDateContact: vi.fn() };
});

import { getDueByDateContact, getDueByDateReport } from '@/modules/accounting/services/reports/dueByDateService';
import summary from '../../../pages/api/accounting/reports/due-by-date';
import xlsx from '../../../pages/api/accounting/reports/due-by-date-xlsx';

function anonymous(route: unknown, query: Record<string, unknown> = {}) {
  const out = { status: 0, body: undefined as unknown };
  const res = {
    status(c: number) { out.status = c; return this; },
    json(b: unknown) { out.body = b; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  const req = { method: 'GET', query, headers: {}, cookies: {}, socket: { remoteAddress: '127.0.0.1' } };
  return (route as (a: NextApiRequest, b: NextApiResponse) => Promise<unknown>)(
    req as unknown as NextApiRequest, res as unknown as NextApiResponse,
  ).then(() => out);
}

describe.each([['due-by-date', summary], ['due-by-date-xlsx', xlsx]] as const)('%s', (_name, route) => {
  it('answers 401 to a request with no session, and reads nothing', async () => {
    const r = await anonymous(route, { by_date: '2026-11-30' });
    expect(r.status).toBe(401);
    expect(getDueByDateReport).not.toHaveBeenCalled();
    expect(getDueByDateContact).not.toHaveBeenCalled();
  });
});
