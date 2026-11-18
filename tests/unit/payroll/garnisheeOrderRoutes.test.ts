/**
 * Garnishee-order write routes (wave 6 GA, review of #1574 M1 and L1):
 *  - the request log masks the order (reference, creditor, instalment, total debt) and the end reason, proven through
 *    the real sanitizer;
 *  - a Login-as session (IMPERSONATION_FORBIDDEN) and a token channel (AGENT_FORBIDDEN) are 403 on both write routes,
 *    and nothing is read or written (no SQL, no service call).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

type H = (req: NextApiRequest, res: NextApiResponse) => unknown;
const masks = vi.hoisted(() => [] as Array<readonly string[] | undefined>);
const actor = vi.hoisted(() => ({ value: 'self' as 'self' | 'impersonation' | 'unknown' }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: H) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: H) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: H) => h }));
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (h: H, o?: { maskBodyKeys?: readonly string[] }) => { masks.push(o?.maskBodyKeys); return h; },
}));
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: vi.fn(async () => actor.value) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', async (importOriginal) => ({ ...await importOriginal<object>(), sql: vi.fn().mockResolvedValue([]) }));
vi.mock('@/modules/accounting/services/payroll/payrollGarnisheeOrders', () => ({
  createGarnisheeOrder: vi.fn(), endGarnisheeOrder: vi.fn(), listGarnisheeOrders: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { maskedKeySet, sanitizeRequestBody } from '@/lib/sanitizeRequestBody';
import { createGarnisheeOrder, endGarnisheeOrder } from '@/modules/accounting/services/payroll/payrollGarnisheeOrders';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/ so the @/ alias won't resolve; relative path needed
import ordersRoute from '../../../pages/api/payroll/employees/[id]/garnishee-orders/index';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import endRoute from '../../../pages/api/payroll/employees/[id]/garnishee-orders/[orderId]';

const EMP = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const CREATE = {
  kind: 'emolument_attachment', reference: 'EAO 12/2026', creditorName: 'Acme Credit', instalment: 6000, totalDebt: 10000,
  startDate: '2026-01-01', endDate: null, priority: 10,
};
const END = { endDate: '2026-05-31', reason: 'Order rescinded by the court' };

async function call(route: unknown, query: Record<string, string>, body: unknown) {
  const res = {
    statusCode: 0, body: undefined as unknown, headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; },
  };
  const req = {
    method: 'POST', query, body, headers: {}, socket: { remoteAddress: '127.0.0.1' }, companyId: 'c1', companyRole: 'owner',
    user: { id: 'u1', email: 'u@example.invalid', claims: { session_id: 's1' } },
  } as unknown as NextApiRequest;
  await (route as H)(req, res as unknown as NextApiResponse);
  return res;
}

beforeEach(() => { vi.clearAllMocks(); actor.value = 'self'; });

describe('the request log', () => {
  it('both write routes mask the order and the reason, and the real sanitizer hides each value', () => {
    expect(masks).toHaveLength(2);
    for (const m of masks) {
      const logged = sanitizeRequestBody({ ...CREATE, ...END }, 1, maskedKeySet(m)) as Record<string, unknown>;
      for (const k of ['reference', 'creditorName', 'instalment', 'totalDebt', 'reason']) {
        expect(String(logged[k]), k).toMatch(/^\[omitted/);
      }
      expect(logged.kind).toBe('emolument_attachment');
    }
  });
});

describe.each([
  ['create', () => ordersRoute, { id: EMP }, CREATE],
  ['end', () => endRoute, { id: EMP, orderId: ORDER }, END],
] as const)('%s: refused before any read or write', (_name, route, query, body) => {
  it.each([
    ['impersonation', 'IMPERSONATION_FORBIDDEN'],
    ['unknown', 'AGENT_FORBIDDEN'],
  ] as const)('a %s session is 403 %s and writes nothing', async (who, reason) => {
    actor.value = who;
    const res = await call(route(), query, body);
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).toContain(reason);
    expect(sql).not.toHaveBeenCalled();
    expect(createGarnisheeOrder).not.toHaveBeenCalled();
    expect(endGarnisheeOrder).not.toHaveBeenCalled();
  });

  it('a person signed in as themselves reaches the service (the refusals above are not a blanket 403)', async () => {
    const res = await call(route(), query, body);
    expect(res.statusCode).not.toBe(403);
    expect(vi.mocked(createGarnisheeOrder).mock.calls.length + vi.mocked(endGarnisheeOrder).mock.calls.length).toBe(1);
  });
});
