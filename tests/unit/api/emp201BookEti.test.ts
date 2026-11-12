/**
 * POST /api/accounting/sars/emp201-book-eti (wave 5 ET, review round 4 M1(c)): "Book ETI for this month".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// Each wrapper records itself when it runs, so the test can assert the chain (tdd M1: withCsrf must stay on this route).
const { chain, tag } = vi.hoisted(() => {
  const chain: string[] = [];
  const tag = (name: string) => (h: (...a: unknown[]) => unknown) => (...a: unknown[]) => { chain.push(name); return h(...a); };
  return { chain, tag };
});
vi.mock('@/lib/auth', () => ({ withAuth: tag('withAuth'), withWriteAccess: tag('withWriteAccess') }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: tag('withCsrf') }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: tag('withErrorHandler') }));
vi.mock('@/modules/accounting/services/payroll/etiRebook', () => ({ bookEtiForMonthLocked: vi.fn() }));

import { bookEtiForMonthLocked } from '@/modules/accounting/services/payroll/etiRebook';
import { PayrollLoanLockTimeoutError } from '@/modules/accounting/services/payroll/payrollLoanLock';
import route from '../../../pages/api/accounting/sars/emp201-book-eti';

const CO = '11111111-1111-4111-8111-111111111111';
function call(method: string, body: unknown) {
  const req = { method, body, companyId: CO, user: { id: 'u1' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
  };
  return Promise.resolve((route as unknown as (q: NextApiRequest, s: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}

beforeEach(() => { vi.resetAllMocks(); chain.length = 0; });

describe('emp201-book-eti', () => {
  it('tdd M1: the route runs withAuth, withErrorHandler, withCsrf and withWriteAccess, in that order, before its handler', async () => {
    vi.mocked(bookEtiForMonthLocked).mockResolvedValue({ month: '2026-08', status: 'nothing_to_book', journalEntryId: null, entryDate: '2026-08-31', used: 0, refund: 0 });
    await call('POST', { month: '2026-08' });
    expect(chain).toEqual(['withAuth', 'withErrorHandler', 'withCsrf', 'withWriteAccess']);
  });
  it('books the month under the service\'s lock and answers its outcome', async () => {
    vi.mocked(bookEtiForMonthLocked).mockResolvedValue({ month: '2026-08', status: 'booked', journalEntryId: 'je', entryDate: '2026-08-31', used: 0, refund: 900 });
    const res = await call('POST', { month: '2026-08' });
    expect(res.statusCode).toBe(200);
    expect(bookEtiForMonthLocked).toHaveBeenCalledWith(CO, { year: 2026, month: 8 }, 'u1');
    expect(JSON.stringify(res.sent)).toContain('"status":"booked"');
  });
  it('refuses a month that is not YYYY-MM, and any method but POST, before booking', async () => {
    expect((await call('POST', { month: '2026-13' })).statusCode).toBe(422); // validationError
    expect((await call('GET', {})).statusCode).toBe(405);
    expect(bookEtiForMonthLocked).not.toHaveBeenCalled();
  });
  it('a pay run approval holding lock 1: the standard retryable 503', async () => {
    vi.mocked(bookEtiForMonthLocked).mockRejectedValue(new PayrollLoanLockTimeoutError(null));
    const res = await call('POST', { month: '2026-08' });
    expect(res.statusCode).toBe(503);
  });
});
