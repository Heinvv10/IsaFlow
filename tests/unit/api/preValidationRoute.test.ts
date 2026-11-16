/** Wave 6 PV: the route refuses a bad query and a hit rate limit before any read, and answers 404 for a foreign scope. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const st = vi.hoisted(() => ({ actor: 'self' as string, allowed: true, keys: [] as string[], reads: [] as unknown[], result: {} as unknown }));

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withNoStore', () => ({ withNoStore: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/impersonationSessions', () => ({ currentSessionActor: vi.fn(async () => st.actor) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({
  INTERACTIVE_REPORT_LIMIT: { max: 120, windowSecs: 900 },
  checkReportRateLimit: vi.fn(async (_c: string, key: string) => { st.keys.push(key); return st.allowed; }),
}));
vi.mock('@/modules/accounting/services/payroll/preValidationService', () => ({
  preValidateTaxYear: vi.fn(async (_c: string, scope: unknown) => { st.reads.push(scope); return st.result; }),
}));

import handler from '../../../pages/api/payroll/pre-validation';

const U = '11111111-1111-4111-8111-111111111111';
function call(query: Record<string, unknown>, method = 'GET') {
  const out = { status: 0, body: null as unknown };
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
    setHeader: vi.fn(),
  } as unknown as NextApiResponse;
  const req = { method, query, companyId: 'c1', user: { id: 'u1' } } as unknown as NextApiRequest;
  return (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, res).then(() => out);
}

beforeEach(() => { st.actor = 'self'; st.allowed = true; st.keys = []; st.reads = []; st.result = { taxYear: 2027, employees: [] }; });

describe('GET /api/payroll/pre-validation', () => {
  it('passes the parsed scope to the service under its own per-user rate-limit key', async () => {
    const out = await call({ taxYear: '2027', employeeId: U });
    expect(out.status).toBe(200);
    expect(st.keys).toEqual(['pre-validation:u:u1']);
    expect(st.reads).toEqual([{ taxYear: 2027, employeeId: U }]);
  });
  it('a bad query is 400 and reads nothing (not even the rate limit)', async () => {
    expect((await call({ taxYear: '2027', extra: '1' })).status).toBe(400);
    expect(st.keys).toEqual([]);
    expect(st.reads).toEqual([]);
  });
  it('429 reads nothing', async () => {
    st.allowed = false;
    expect((await call({})).status).toBe(429);
    expect(st.reads).toEqual([]);
  });
  it('a scope the service cannot find in the company is 404', async () => {
    st.result = null;
    expect((await call({ runId: U })).status).toBe(404);
  });
  it('Login-as is 403 IMPERSONATION_FORBIDDEN and reads nothing', async () => {
    st.actor = 'impersonation';
    const out = await call({});
    expect(out.status).toBe(403);
    expect(JSON.stringify(out.body)).toContain('IMPERSONATION_FORBIDDEN');
    expect(st.keys).toEqual([]);
    expect(st.reads).toEqual([]);
  });
  it('a session with no GoTrue session id (an agent or a job) is 403 AGENT_FORBIDDEN and reads nothing', async () => {
    st.actor = 'unknown';
    const out = await call({});
    expect(out.status).toBe(403);
    expect(JSON.stringify(out.body)).toContain('AGENT_FORBIDDEN');
    expect(st.reads).toEqual([]);
  });
  it('a write method is 405', async () => {
    expect((await call({}, 'POST')).status).toBe(405);
    expect(st.reads).toEqual([]);
  });
});
