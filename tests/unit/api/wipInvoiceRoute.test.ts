/**
 * Generate Invoice form (audit 11 Nov 2026, P2.5 item 2): the WIP routes' input
 * contract. POST /practice/wip/invoice takes an optional dueDate and notes; a
 * malformed one is a 400 naming the field, never a 500 from Postgres. GET
 * /practice/wip answers a malformed practiceClientId 400 instead of letting
 * the ::UUID cast fail. The service behind both has its own tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';
import type { AuthenticatedNextApiRequest } from '@/lib/auth';

const { generateMock, getWipMock } = vi.hoisted(() => ({ generateMock: vi.fn(), getWipMock: vi.fn() }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// Identity wrappers: auth, CSRF and the error handler have their own tests.
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/practice/practiceWipService', async () => {
  const guards = await vi.importActual<typeof import('@/modules/accounting/services/practice/wipInvoiceGuards')>(
    '@/modules/accounting/services/practice/wipInvoiceGuards');
  return { generateWipInvoice: generateMock, getWipByClient: getWipMock, WipInvoiceRefusal: guards.WipInvoiceRefusal };
});

import invoiceHandler from '../../../pages/api/accounting/practice/wip/invoice';
import wipHandler from '../../../pages/api/accounting/practice/wip';

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLIENT = 'cccccccc-0000-4000-8000-000000000003';
const ENTRY = 'eeeeeeee-0000-4000-8000-000000000005';

function makeRes() {
  const res: Partial<NextApiResponse> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as NextApiResponse; }) as unknown as NextApiResponse['status'];
  res.json = vi.fn((body: unknown) => { res.body = body; return res as NextApiResponse; }) as unknown as NextApiResponse['json'];
  res.setHeader = vi.fn() as unknown as NextApiResponse['setHeader'];
  return res as NextApiResponse & { statusCode?: number; body?: unknown };
}
const req = (method: string, body: unknown, query: Record<string, unknown> = {}) =>
  ({ method, body, query, companyId: COMPANY, user: { id: 'user-1' } }) as unknown as AuthenticatedNextApiRequest;
const message = (res: { body?: unknown }) => (res.body as { error?: { message?: string } }).error?.message ?? '';

beforeEach(() => vi.clearAllMocks());

describe('POST /api/accounting/practice/wip/invoice', () => {
  const base = { practiceClientId: CLIENT, timeEntryIds: [ENTRY], invoiceDate: '2026-11-05' };

  it('passes a due date and notes through to the service', async () => {
    generateMock.mockResolvedValueOnce({ invoiceId: 'inv-1' });
    const res = makeRes();
    await invoiceHandler(req('POST', { ...base, dueDate: '2026-11-30', notes: '  October work  ' }), res);
    expect(res.statusCode).toBe(201);
    expect(generateMock).toHaveBeenCalledWith(COMPANY, 'user-1', expect.objectContaining({ dueDate: '2026-11-30', notes: 'October work' }));
  });

  it('refuses a dueDate that is not a calendar date with a 400 naming the field', async () => {
    const res = makeRes();
    await invoiceHandler(req('POST', { ...base, dueDate: '2026-02-30' }), res);
    expect(res.statusCode).toBe(400);
    expect(message(res)).toMatch(/^dueDate:/);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('refuses notes over 2000 characters with a 400 naming the field', async () => {
    const res = makeRes();
    await invoiceHandler(req('POST', { ...base, notes: 'x'.repeat(2001) }), res);
    expect(res.statusCode).toBe(400);
    expect(message(res)).toMatch(/^notes:/);
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/accounting/practice/wip', () => {
  it('refuses a malformed practiceClientId with a 400 before the service runs', async () => {
    const res = makeRes();
    await wipHandler(req('GET', undefined, { practiceClientId: 'not-a-uuid' }), res);
    expect(res.statusCode).toBe(400);
    expect(getWipMock).not.toHaveBeenCalled();
  });

  it('refuses a repeated practiceClientId (an array) with a 400', async () => {
    const res = makeRes();
    await wipHandler(req('GET', undefined, { practiceClientId: [CLIENT, CLIENT] }), res);
    expect(res.statusCode).toBe(400);
    expect(getWipMock).not.toHaveBeenCalled();
  });

  it('scopes a valid practiceClientId to the caller company', async () => {
    getWipMock.mockResolvedValueOnce([]);
    const res = makeRes();
    await wipHandler(req('GET', undefined, { practiceClientId: CLIENT }), res);
    expect(res.statusCode).toBe(200);
    expect(getWipMock).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ practiceClientId: CLIENT }));
  });
});
