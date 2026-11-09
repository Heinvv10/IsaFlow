/** Wave 5 UXP: the final-run check is rate-limited per user under its own key, and answers 429 before any read. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const st = vi.hoisted(() => ({ allowed: true, keys: [] as string[], reads: 0 }));

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withNoStore', () => ({ withNoStore: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({
  INTERACTIVE_REPORT_LIMIT: { max: 120, windowSecs: 900 },
  checkReportRateLimit: vi.fn(async (_c: string, key: string) => { st.keys.push(key); return st.allowed; }),
}));
vi.mock('@/modules/accounting/services/payroll/employeeFinalRun', () => ({
  employeeHasFinalRun: vi.fn(async () => { st.reads += 1; return true; }),
}));

import handler from '../../../pages/api/payroll/employees/[id]/has-final-run';

const E = '11111111-1111-4111-8111-111111111111';
function call() {
  const out = { status: 0, body: null as unknown };
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
    setHeader: vi.fn(),
  } as unknown as NextApiResponse;
  const req = { method: 'GET', query: { id: E }, companyId: 'c1', user: { id: 'u1' } } as unknown as NextApiRequest;
  return (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, res).then(() => out);
}

beforeEach(() => { st.allowed = true; st.keys = []; st.reads = 0; });

describe('GET has-final-run', () => {
  it('answers the boolean under its own per-user rate-limit key', async () => {
    const out = await call();
    expect(out.status).toBe(200);
    expect(st.keys).toEqual(['has-final-run:u:u1']);
    expect(st.reads).toBe(1);
  });
  it('answers 429 and reads nothing when the limit is hit', async () => {
    st.allowed = false;
    const out = await call();
    expect(out.status).toBe(429);
    expect(st.reads).toBe(0);
  });
});
