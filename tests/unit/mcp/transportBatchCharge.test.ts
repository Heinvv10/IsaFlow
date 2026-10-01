/**
 * /api/mcp — a JSON-RPC batch is charged to the per-company limiter all at
 * once or not at all (R-175).
 *
 * It used to be charged one unit at a time, stopping at the first refusal: a
 * 20-call batch arriving with 10 units left spent those 10, ran nothing, and
 * was refused, so a retrying agent drained the end of every window.
 *
 * The limiter is replaced by a counter that behaves like it: a charge either
 * fits and is added, or changes nothing. The atomic charge itself is proven
 * against PostgreSQL in tests/integration/r175-rate-limit-admits-over-max.int.test.ts.
 * Fixtures follow tests/unit/mcp/transport.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  auth: { user: { id: 'user-gotrue-1' }, companyId: '22222222-2222-2222-2222-222222222222', scopes: ['read:reports'], patId: 'pat-jti-1', authMethod: 'pat' as const },
}));
vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return { sql: sqlFn, withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)) };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  apiLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth/withBearerAuth', () => ({
  withBearerAuth: (handler: (req: unknown, res: unknown) => unknown) =>
    async (req: Record<string, unknown>, res: unknown) => { Object.assign(req, h.auth); return handler(req, res); },
}));
vi.mock('@/modules/admin/services/featureFlagService', () => ({ hasFeature: vi.fn(async () => true) }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: vi.fn(() => '10.0.0.1') }));

import { checkRateLimit } from '@/lib/rateLimit';
import { mcpRegistry } from '@/lib/mcp/toolIndex';
import route from '../../../pages/api/mcp/index';

const COMPANY_ID = h.auth.companyId;
let runs = 0;
mcpRegistry.register({
  name: 'count_runs', description: 'test tool', scope: 'read:reports', write: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => { runs += 1; return { content: [{ type: 'text', text: 'ok' }] }; },
});

function makeRes(): NextApiResponse & { body?: unknown } {
  const res = {
    statusCode: 200, body: undefined as unknown,
    setHeader() { return res; }, status(c: number) { res.statusCode = c; return res; },
    json(b: unknown) { res.body = b; return res; }, end() { return res; },
  };
  return res as unknown as NextApiResponse & { body?: unknown };
}
const batch = (n: number) => ({
  method: 'POST', url: '/api/mcp', headers: { 'content-type': 'application/json', authorization: 'Bearer pat_x' },
  body: Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'count_runs', arguments: {} } })),
});

/** A per-company counter with `used` units spent; a charge fits whole or changes nothing. */
let used = 0;
const companyCharges = () => vi.mocked(checkRateLimit).mock.calls.filter(([k]) => (k as string).startsWith('mcp:'));

beforeEach(() => {
  vi.clearAllMocks();
  runs = 0;
  used = 0;
  vi.mocked(checkRateLimit).mockImplementation(async (key: string, o: { max: number; cost?: number }) => {
    if (!key.startsWith('mcp:')) return true;
    if (used + (o.cost ?? 1) > o.max) return false;
    used += o.cost ?? 1;
    return true;
  });
});

describe('/api/mcp — a batch is charged whole or not at all (R-175)', () => {
  it('a batch larger than what is left is refused: nothing charged, nothing run', async () => {
    used = 110;
    const res = makeRes();
    await route(batch(20) as never, res);

    expect((res.body as { error: { code: number } }).error.code).toBe(-32000);
    expect(companyCharges()).toEqual([[`mcp:${COMPANY_ID}`, { max: 120, windowSecs: 60, cost: 20 }]]);
    expect(used).toBe(110);
    expect(runs).toBe(0);
  });

  it('the units left are still there for a batch that fits, which is charged its full count once', async () => {
    used = 110;
    await route(batch(20) as never, makeRes());
    await route(batch(10) as never, makeRes());

    expect(used).toBe(120);
    expect(runs).toBe(10);
    expect(companyCharges().map(([, o]) => (o as { cost: number }).cost)).toEqual([20, 10]);
  });

  it('an empty batch charges nothing', async () => {
    await route(batch(0) as never, makeRes());

    expect(companyCharges()).toEqual([]);
    expect(used).toBe(0);
  });
});
