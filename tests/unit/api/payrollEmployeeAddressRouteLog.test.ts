/**
 * Wave 7 EA1 (review #1932 M1): the address route's request and error logs hold none of the address. The REAL route
 * module and the REAL withErrorHandler and logger run; only the auth wrappers (identity), the session check and the
 * writer (made to throw) are stubbed. Every line the logger is handed, request and error, is read for each value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollModule', () => ({ withPayrollModule: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/bank/bankControlRefusal', () => ({ assertHumanSession: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/payroll/payrollEmployeeAddress', () => ({ setEmployeeAddress: m.set, getEmployeeAddress: m.get }));

import { log } from '@/lib/logger';
import route from '../../../pages/api/payroll/employees/[id]/address';

const ID = '11111111-1111-4111-8111-111111111111';
const BODY = {
  residential: { unitNumber: 'U77', complex: 'Marula Gardens', streetNumber: '4471', street: 'Kingfisher Avenue', suburb: 'Lynnwood Ridge', city: 'Pretoria', postalCode: '0040', countryCode: 'ZA' },
  postal: { sameAsResidential: false, line1: 'PO Box 99123', line2: 'Brooklyn Square', line3: 'Menlo', line4: null, postalCode: '0075', countryCode: 'ZA' },
};
const VALUES = ['U77', 'Marula', '4471', 'Kingfisher', 'Lynnwood', '0040', '99123', 'Brooklyn', 'Menlo', '0075'];

function res() {
  const r = { statusCode: 200, headersSent: false, writableEnded: false, headers: new Map<string, unknown>(), body: undefined as unknown };
  return Object.assign(r, {
    setHeader: (k: string, v: unknown) => { r.headers.set(k.toLowerCase(), v); return r; },
    getHeader: (k: string) => r.headers.get(k.toLowerCase()),
    status: (c: number) => { r.statusCode = c; return r; },
    json: (b: unknown) => { r.body = b; r.headersSent = true; r.writableEnded = true; return r; },
    send: (b: unknown) => { r.body = b; r.headersSent = true; r.writableEnded = true; return r; },
    end: () => { r.headersSent = true; r.writableEnded = true; return r; },
  });
}
const req = (body: unknown) => ({
  method: 'PUT', url: `/api/payroll/employees/${ID}/address`, query: { id: ID }, body,
  headers: { 'content-type': 'application/json' }, companyId: 'co-A', companyRole: 'owner', user: { id: 'u1', email: 'u@example.invalid' },
}) as unknown as NextApiRequest;

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(log, level).mockImplementation(((message: string, data?: unknown) => { lines.push(JSON.stringify({ level, message, data })); }) as never);
  }
});
afterEach(() => { vi.restoreAllMocks(); m.set.mockReset(); });

describe('the address route logs no address', () => {
  it('a handler that throws: the request line and the error line carry none of the values', async () => {
    m.set.mockRejectedValue(new Error('simulated write failure'));
    const r = res();
    await (route as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(req(BODY), r as unknown as NextApiResponse);
    expect(r.statusCode).toBe(500);
    expect(m.set).toHaveBeenCalledTimes(1);
    const request = lines.find((l) => l.includes('API Request: PUT'));
    const error = lines.find((l) => l.includes('"level":"error"'));
    expect(request, lines.join('\n')).toBeDefined();
    expect(error, lines.join('\n')).toContain('simulated write failure');
    for (const v of VALUES) expect(lines.join('\n'), v).not.toContain(v);
  });

  it('a refused (422) body: the request line carries none of the values either', async () => {
    const r = res();
    await (route as unknown as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(
      req({ ...BODY, residential: { ...BODY.residential, postalCode: '0000' } }), r as unknown as NextApiResponse);
    expect(r.statusCode).toBe(422);
    expect(m.set).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('API Request: PUT'))).toBe(true);
    for (const v of VALUES.filter((x) => x !== '0040')) expect(lines.join('\n'), v).not.toContain(v);
  });
});
