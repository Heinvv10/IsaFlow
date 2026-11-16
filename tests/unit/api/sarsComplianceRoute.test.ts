/**
 * GET /api/accounting/sars/sars-compliance — bad input is a 400; a server-side
 * failure (e.g. the company row cannot be read) reaches withErrorHandler (5xx),
 * never a 400.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));
const m = vi.hoisted(() => ({ getComplianceCalendarWithDB: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/sarsService', () => ({ getComplianceCalendarWithDB: m.getComplianceCalendarWithDB }));

import handler from '../../../pages/api/accounting/sars/sars-compliance';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const call = (query: Record<string, string>) =>
  (handler as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
    { method: 'GET', query, companyId: COMPANY } as unknown as NextApiRequest, {} as NextApiResponse);

describe('sars-compliance route', () => {
  beforeEach(() => { m.getComplianceCalendarWithDB.mockReset(); });

  it('passes the company and a valid year through', async () => {
    m.getComplianceCalendarWithDB.mockResolvedValue([]);
    expect(await call({ year: '2027' })).toEqual({ kind: 'success', data: { events: [] } });
    expect(m.getComplianceCalendarWithDB).toHaveBeenCalledWith(COMPANY, 2027);
  });

  it('defaults the year when none is given', async () => {
    m.getComplianceCalendarWithDB.mockResolvedValue([]);
    await call({});
    expect(m.getComplianceCalendarWithDB).toHaveBeenCalledWith(COMPANY, undefined);
  });

  it.each(['abc', '1999', '2026.5'])('rejects year=%s as a 400', async (year) => {
    expect(await call({ year })).toMatchObject({ kind: 'badRequest' });
    expect(m.getComplianceCalendarWithDB).not.toHaveBeenCalled();
  });

  it('lets a service failure propagate to withErrorHandler (5xx), not a 400', async () => {
    m.getComplianceCalendarWithDB.mockRejectedValue(new Error('company row missing'));
    await expect(call({ year: '2026' })).rejects.toThrow('company row missing');
  });
});
