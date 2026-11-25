/**
 * The creditor bank-details route (wave 7 GC1: GET / PUT on garnishee-orders/[orderId]):
 *  - the request log hides every bank value, through the real sanitizer;
 *  - a Login-as session and a token channel are 403 on GET and PUT, before any read or service call;
 *  - a PUT with a key outside the five is 400, and invalid values are 422 (the real parseBankDetailsInput), with no
 *    service call;
 *  - a person signed in as themselves reaches the service, with `view=masked` passed through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
const masks = vi.hoisted(() => [] as Array<readonly string[] | undefined>);
const actor = vi.hoisted(() => ({ value: 'self' as 'self' | 'impersonation' | 'unknown' }));
vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: H, o?: { maskBodyKeys?: readonly string[] }) => { masks.push(o?.maskBodyKeys); return h; },
}));
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: vi.fn(async () => actor.value) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', async (importOriginal) => ({ ...await importOriginal<object>(), sql: vi.fn().mockResolvedValue([]) }));
vi.mock('@/modules/accounting/services/payroll/payrollGarnisheeOrders', () => ({ endGarnisheeOrder: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollGarnisheeCreditorBank', async (orig) => ({
  ...await orig<object>(), getCreditorBank: vi.fn(async () => null), setCreditorBank: vi.fn(async () => ({ masked: true })),
}));

import { sql } from '@/lib/neon';
import { maskedKeySet, sanitizeRequestBody } from '@/lib/sanitizeRequestBody';
import { getCreditorBank, setCreditorBank } from '@/modules/accounting/services/payroll/payrollGarnisheeCreditorBank';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import route from '../../../pages/api/payroll/employees/[id]/garnishee-orders/[orderId]';

const QUERY = { id: '11111111-1111-4111-8111-111111111111', orderId: '22222222-2222-4222-8222-222222222222' };
const BANK = { bankName: 'First National Bank', branchCode: '250655', accountNumber: '62001234567', accountType: 'cheque', accountHolder: 'Acme Credit Ltd' };

async function call(method: string, body: unknown, query: Record<string, string> = QUERY) {
  const res = {
    statusCode: 0, body: undefined as unknown, headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; },
  };
  const req = {
    method, query, body, headers: {}, socket: { remoteAddress: '127.0.0.1' }, companyId: 'c1', companyRole: 'manager',
    user: { id: 'u1', email: 'u@example.invalid', claims: { session_id: 's1' } },
  } as unknown as NextApiRequest;
  await (route as H)(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => { vi.clearAllMocks(); actor.value = 'self'; });

describe('creditor bank details route', () => {
  it('the request log hides every bank value (real sanitizer)', () => {
    expect(masks).toHaveLength(1);
    const logged = sanitizeRequestBody(BANK, 1, maskedKeySet(masks[0])) as Record<string, unknown>;
    for (const k of Object.keys(BANK)) expect(String(logged[k]), k).not.toContain(String(BANK[k as keyof typeof BANK]));
  });

  it.each([
    ['GET', 'impersonation', 'IMPERSONATION_FORBIDDEN'], ['GET', 'unknown', 'AGENT_FORBIDDEN'],
    ['PUT', 'impersonation', 'IMPERSONATION_FORBIDDEN'], ['PUT', 'unknown', 'AGENT_FORBIDDEN'],
  ] as const)('%s from a %s session is 403 %s before any read', async (method, who, reason) => {
    actor.value = who;
    const res = await call(method, BANK);
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).toContain(reason);
    expect(sql).not.toHaveBeenCalled();
    expect(getCreditorBank).not.toHaveBeenCalled();
    expect(setCreditorBank).not.toHaveBeenCalled();
  });

  it('an extra key is 400, a bad value 422; neither reaches the service', async () => {
    expect((await call('PUT', { ...BANK, payTo: 'x' })).statusCode).toBe(400);
    expect((await call('PUT', [BANK])).statusCode).toBe(400);
    const bad = await call('PUT', { ...BANK, branchCode: '12' });
    expect(bad.statusCode).toBe(422);
    expect(JSON.stringify(bad.body)).toContain('Branch code must be 6 digits');
    expect(setCreditorBank).not.toHaveBeenCalled();
  });

  it('a person signed in as themselves reaches the service; view=masked is passed through', async () => {
    expect((await call('PUT', BANK)).statusCode).toBe(200);
    expect(vi.mocked(setCreditorBank).mock.calls[0]!.slice(0, 5)).toEqual(['c1', QUERY.id, QUERY.orderId, { ...BANK }, 'manager']);
    expect((await call('GET', undefined, { ...QUERY, view: 'masked' })).statusCode).toBe(200);
    expect(vi.mocked(getCreditorBank).mock.calls[0]!.slice(0, 5)).toEqual(['c1', QUERY.id, QUERY.orderId, 'manager', true]);
    expect((await call('DELETE', undefined)).statusCode).toBe(405);
  });
});
