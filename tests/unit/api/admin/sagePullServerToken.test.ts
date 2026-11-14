// #1370 review M1: the Sage pull returns the token that binds a later commit to
// this payload and this company (sagePullBinding). Sage is mocked: no request
// leaves the box.
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/safeFetch', () => ({
  checkPublicUrl: vi.fn(async () => null),
  safeFetch: vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/Company/Current')
    ? { Name: 'Sage Co', TaxNumber: '4000000000' }
    : { Results: [], TotalResults: 0 }), { status: 200 })),
}));

import handler from '../../../../pages/api/admin/migration/sage-pull-server';
import { verifyPullToken } from '@/modules/admin/services/sagePullBinding';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let data: { pulled: Record<string, unknown>; pullToken: string };

beforeAll(async () => {
  vi.stubEnv('JWT_SECRET', 'unit-test-signing-material-not-a-real-one-0123456789');
  let body: unknown;
  const res = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { body = b; return this; },
    setHeader() { return this; } };
  await (handler as unknown as (q: unknown, s: unknown) => Promise<void>)(
    { method: 'POST', body: { companyId: COMPANY, sageCookie: 'sage-cookie-value-0123456789' } }, res);
  expect(res.statusCode).toBe(200);
  data = (body as { data: typeof data }).data;
});

describe('sage-pull-server issues the commit binding', () => {
  it('returns a token that verifies for this company and this payload, round-tripped through JSON', () => {
    const roundTripped = JSON.parse(JSON.stringify(data.pulled)) as Record<string, unknown>;
    expect(() => verifyPullToken(data.pullToken, COMPANY, roundTripped)).not.toThrow();
  });

  it('the same token does not verify for another company', () => {
    expect(() => verifyPullToken(data.pullToken, OTHER, data.pulled)).toThrow(/different company/);
  });
});

describe('verifyPullToken names each refusal', () => {
  it('a token issued in the future says so, not "more than two hours old"', async () => {
    const { issuePullToken } = await import('@/modules/admin/services/sagePullBinding');
    const pulled = { accounts: { records: [] } };
    const future = issuePullToken(COMPANY, pulled, Date.now() + 10 * 60 * 1000);
    expect(() => verifyPullToken(future, COMPANY, pulled)).toThrow(/issued in the future/);
  });
});
