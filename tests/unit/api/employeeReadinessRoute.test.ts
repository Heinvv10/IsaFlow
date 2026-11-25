/** Wave 6 UXR: the readiness read is rate-limited per user under its own key, and answers 429 before any read. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const st = vi.hoisted(() => ({ allowed: true, keys: [] as string[], reads: 0, window: null as null | { used: number }, max: [] as number[] }));

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>())); // #1656: the module gate is proven in approvePermissionPaths / payrollModuleCensus
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withNoStore', () => ({ withNoStore: (h: unknown) => h }));
vi.mock('@/lib/auth/withPayrollDetailAccess', () => ({ withPayrollDetailAccess: (h: unknown) => h }));
vi.mock('@/lib/schemas/common', () => ({ requireUuidParam: (req: { query: { id: string } }) => req.query.id }));
vi.mock('@/modules/accounting/services/bank/bankControlRefusal', () => ({ assertHumanSession: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/bank/bankControlResponse', () => ({ respondIfBankControlRefused: () => false }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/rateLimit', () => ({
  INTERACTIVE_REPORT_LIMIT: { max: 120, windowSecs: 900 },
  checkReportRateLimit: vi.fn(async (_c: string, key: string, opts: { max?: number } = {}) => {
    st.keys.push(key); st.max.push(opts.max ?? 25);
    // A real window: the first `max` calls pass, the rest are refused (what rate_limit_counters does for one key).
    if (st.window) { st.window.used += 1; return st.window.used <= (opts.max ?? 25); }
    return st.allowed;
  }),
}));
vi.mock('@/modules/accounting/services/payroll/employeeReadinessRead', () => ({
  readEmployeeReadiness: vi.fn(async () => { st.reads += 1; return { bank: 'none', runs: [], hasFinalRun: true }; }),
}));

import handler from '../../../pages/api/payroll/employees/[id]/readiness';

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

beforeEach(() => { st.allowed = true; st.keys = []; st.reads = 0; st.window = null; st.max = []; });

describe('GET readiness', () => {
  it('answers the boolean under its own per-user rate-limit key', async () => {
    const out = await call();
    expect(out.status).toBe(200);
    expect(st.keys).toEqual(['employee-readiness:u:u1']);
    expect(st.reads).toBe(1);
  });
  it('answers 429 and reads nothing when the limit is hit', async () => {
    st.allowed = false;
    const out = await call();
    expect(out.status).toBe(429);
    expect(st.reads).toBe(0);
  });
  // RS3: a reviewer opening one profile after another (each page load reads once, twice under React strict mode in dev)
  // used up the 120-a-window cap in a few minutes, and every later card said "Could not check bank details" (a 429).
  it('does not refuse a user who opens profile after profile: 300 reads in one window all answer 200', async () => {
    st.window = { used: 0 };
    const statuses: number[] = [];
    for (let i = 0; i < 300; i += 1) statuses.push((await call()).status);
    expect(statuses.filter(s => s !== 200)).toEqual([]);
  });
  it('still refuses a runaway client: the configured cap (1200) passes, the 1201st read is 429', async () => {
    st.window = { used: 0 };
    const statuses: number[] = [];
    for (let i = 0; i < 1201; i += 1) statuses.push((await call()).status);
    expect(statuses.slice(0, 1200).every(s => s === 200)).toBe(true);
    expect(statuses[1200]).toBe(429);
    expect(st.reads).toBe(1200);
  });
});
