/**
 * adminGetUser (S-07c C4): verify-email reads the token's GoTrue user by id
 * and provisions only for the address GoTrue holds. The real client runs with
 * only `fetch` stubbed: a user, no user (404), and an outage, which must be
 * AuthUpstreamUnavailableError so verify-email answers 503 and consumes nothing.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { adminGetUser } from '@/lib/auth/gotrueAdminUser';
import { AuthUpstreamUnavailableError } from '@/lib/auth/authUpstream';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const answer = (res: () => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async () => res());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

beforeEach(() => {
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('adminGetUser', () => {
  it('GETs /admin/users/<id> with the service key and returns the user', async () => {
    const f = answer(() => json(200, { id: 'u-1', email: 'lead@example.co.za' }));
    expect(await adminGetUser('u-1')).toEqual({ id: 'u-1', email: 'lead@example.co.za' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toMatch(/\/admin\/users\/u-1$/);
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-service');
  });

  it('answers null when GoTrue has no such user (404)', async () => {
    answer(() => json(404, { msg: 'User not found' }));
    expect(await adminGetUser('u-gone')).toBeNull();
  });

  it.each([
    ['a 503', () => json(503, { msg: 'down' })],
    ['a network error', () => { throw new TypeError('fetch failed'); }],
  ])('throws AuthUpstreamUnavailableError on %s', async (_, res) => {
    answer(res);
    await expect(adminGetUser('u-1')).rejects.toBeInstanceOf(AuthUpstreamUnavailableError);
  });

  it('throws a plain error on another refusal (400)', async () => {
    answer(() => json(400, { msg: 'bad id' }));
    await expect(adminGetUser('u-1')).rejects.toThrow(/gotrue adminGetUser failed: 400/);
  });
});
