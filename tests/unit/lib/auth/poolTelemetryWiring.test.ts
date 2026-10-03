/**
 * R-188: the saturation signal is only worth anything if every AUTH_POOL_MAX pool's
 * acquire goes through connectObserved.
 *  - withExtensionToken and the bearer pipeline are driven for real, with a pool whose
 *    waitingCount is 3: the warning must name that pool.
 *  - withAuth and withPlatformAdmin need a verified session to reach their acquire, so
 *    they are pinned by a census over `git ls-files`: no `.connect()` on one of the four
 *    pools outside connectObserved (it fails on a new or reverted site; an untracked file
 *    is not seen until added).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));
vi.mock('pg', () => {
  class Pool {
    waitingCount = 3; totalCount = 10; idleCount = 0; options = { max: 10 };
    on(): this { return this; }
    connect(): Promise<never> { return Promise.reject(new Error('mock pool: no connection')); }
  }
  const types = { setTypeParser: () => undefined, builtins: { DATE: 1082 } };
  return { default: { Pool, types }, Pool, types };
});
vi.mock('@/lib/auth/captureApiKeyAuth', () => ({ extractBearerToken: () => 'tok' }));
vi.mock('@/lib/auth/extensionJwt', () => ({ verifyExtensionToken: async () => ({ connectionId: 'c1' }) }));
vi.mock('@/lib/auth/personalAccessTokens', () => ({
  validatePat: async () => ({ userId: 'u', companyId: 'c', scopes: [] }),
}));
vi.mock('@/lib/auth/oauth', () => ({ validateOauthAccessToken: async () => null }));

const res = () => { const r = { setHeader: () => undefined, status: () => r, json: () => r }; return r; };
const saturated = (pool: string) => warn.mock.calls.filter(c => c[0] === 'auth pool saturated: an acquire had to queue' && (c[1] as { pool: string }).pool === pool);

beforeEach(() => {
  vi.resetModules();
  warn.mockReset();
  vi.stubEnv('DATABASE_URL', 'postgresql://127.0.0.1:1/none');
});

describe('connectObserved is wired at the pool acquires (R-188)', () => {
  it('withExtensionToken warns naming extensionToken', async () => {
    const m = await import('@/lib/auth/withExtensionToken');
    await m.withExtensionToken(async () => undefined)({ headers: {}, query: {} } as never, res() as never).catch(() => undefined);
    expect(saturated('extensionToken')).toHaveLength(1);
    expect(saturated('extensionToken')[0]![1]).toMatchObject({ waitingCount: 3, totalCount: 10, max: 10 });
  });

  it('the bearer pipeline warns naming bearerPipeline', async () => {
    const m = await import('@/lib/auth/bearerPipeline');
    await m.runBearerRequest({ headers: {}, socket: {} } as never, res() as never, 'pat_x', async () => undefined).catch(() => undefined);
    expect(saturated('bearerPipeline')).toHaveLength(1);
  });

  it('no acquire on an auth pool bypasses connectObserved (withAuth, withPlatformAdmin, and any new site)', () => {
    const files = execFileSync('git', ['ls-files', 'src', 'pages'], { encoding: 'utf8' })
      .split('\n').filter(f => /\.(ts|tsx)$/.test(f) && !f.endsWith('poolTelemetry.ts')
        && f !== 'src/lib/auth/withInviteToken.ts' /* its own 5-connection pool, not sized by AUTH_POOL_MAX */);
    const bare = /\b(getAuthPool|getAppPool|pool)\(\)\s*\.connect\(/;
    const offenders = files.filter(f => bare.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    const wired = (f: string, name: string) => readFileSync(f, 'utf8').includes(`, '${name}')`) && readFileSync(f, 'utf8').includes('connectObserved(');
    expect(wired('src/lib/auth/withAuth.ts', 'authPool')).toBe(true);
    expect(wired('src/lib/auth/withPlatformAdmin.ts', 'platformAdminApp')).toBe(true);
  });
});
