/**
 * R-182: each pool is built with the VALIDATED size. pg.Pool is mocked and the
 * options it was constructed with are read back. A bad value must give the
 * pool's default, never NaN (which pg treats as no limit).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warn, built } = vi.hoisted(() => ({ warn: vi.fn(), built: [] as Array<{ max?: number }> }));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } }));
vi.mock('pg', () => {
  class Pool {
    constructor(opts: { max?: number }) { built.push(opts); }
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

const BAD = ['abc', '0', '-3', '2.5', '500', '0x10', '1e1'];

async function lastMax(build: () => Promise<unknown>): Promise<number | undefined> {
  built.length = 0;
  await build().catch(() => undefined);
  expect(built).toHaveLength(1);
  return built[0]!.max;
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgresql://127.0.0.1:1/none');
  vi.stubEnv('PLATFORM_ADMIN_DATABASE_URL', 'postgresql://127.0.0.1:1/none');
});
afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockReset();
});

type Site = { env: string; fallback: number; max: () => Promise<number | undefined> };
const sites: Record<string, Site> = {
  'neon getPool': {
    env: 'PG_POOL_MAX', fallback: 10,
    max: async () => { const m = await import('@/lib/neon'); return lastMax(async () => m.getPool()); },
  },
  'authPool getAuthPool': {
    env: 'AUTH_POOL_MAX', fallback: 20,
    max: async () => { const m = await import('@/lib/auth/authPool'); return lastMax(async () => m.getAuthPool()); },
  },
  'withPlatformAdmin getAppPool': {
    env: 'AUTH_POOL_MAX', fallback: 20,
    max: async () => { const m = await import('@/lib/auth/withPlatformAdmin.pools'); return lastMax(async () => m.getAppPool()); },
  },
  'withPlatformAdmin getPlatformAdminPool': {
    env: 'PLATFORM_ADMIN_POOL_MAX', fallback: 10,
    max: async () => { const m = await import('@/lib/auth/withPlatformAdmin.pools'); return lastMax(async () => m.getPlatformAdminPool()); },
  },
  'rateLimitPool getRateLimitPool': {
    env: 'RATE_LIMIT_POOL_MAX', fallback: 10,
    max: async () => { const m = await import('@/lib/rateLimitPool'); return lastMax(async () => m.getRateLimitPool()); },
  },
  'withExtensionToken': {
    env: 'AUTH_POOL_MAX', fallback: 20,
    max: async () => {
      const m = await import('@/lib/auth/withExtensionToken');
      const handler = m.withExtensionToken(async () => undefined);
      const res = { setHeader: () => undefined, status: () => res, json: () => res };
      return lastMax(async () => handler({ headers: {}, query: {} } as never, res as never));
    },
  },
  'bearerPipeline': {
    env: 'AUTH_POOL_MAX', fallback: 20,
    max: async () => {
      const m = await import('@/lib/auth/bearerPipeline');
      const res = { setHeader: () => undefined, status: () => res, json: () => res };
      const req = { headers: {}, socket: {} };
      return lastMax(async () => m.runBearerRequest(req as never, res as never, 'pat_x', async () => undefined));
    },
  },
};

describe.each(Object.entries(sites))('%s pool size (R-182)', (_name, site) => {
  it('uses a valid value', async () => {
    vi.stubEnv(site.env, '6');
    expect(await site.max()).toBe(6);
  });

  it('uses the default when unset', async () => {
    vi.stubEnv(site.env, undefined as unknown as string);
    expect(await site.max()).toBe(site.fallback);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(BAD)('is bounded by the default for %j, never NaN', async (raw) => {
    vi.stubEnv(site.env, raw);
    expect(await site.max()).toBe(site.fallback);
  });
});
