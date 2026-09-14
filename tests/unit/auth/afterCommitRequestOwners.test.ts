/**
 * R-075 — every request transaction owner starts runAfterCommit work only after
 * its COMMIT succeeds, and never after a ROLLBACK or a failed COMMIT.
 *
 * withAuth and the bearer pipeline share one try block for COMMIT and ROLLBACK
 * (the resolved status picks which), so a drain placed after it runs on BOTH
 * unless it is guarded — the integration suite caught exactly that. Each owner
 * is driven with a scripted pg client that records the order of COMMIT /
 * ROLLBACK against the moment the queued callback runs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';
import { SignJWT } from 'jose';
import { pgTypesMock } from '../helpers/pgTypesMock';

const h = vi.hoisted(() => ({ events: [] as string[], commitThrows: false }));
const client = {
  query: vi.fn(async (text: string) => {
    const verb = String(text).trim().split(/\s+/)[0]!.toUpperCase();
    if (/FROM company_users|FROM users/i.test(String(text))) {
      return { rows: [{ role: 'super_admin', account_user_id: 'user-1', is_active: true, status: 'active', suspended_at: null }] };
    }
    if (verb === 'COMMIT' && h.commitThrows) { h.events.push('COMMIT_THROW'); throw new Error('commit failed'); }
    if (verb === 'COMMIT' || verb === 'ROLLBACK') h.events.push(verb);
    return { rows: [] };
  }),
  release: vi.fn(),
};
vi.mock('pg', () => {
  class Pool { connect = async () => client; on = vi.fn(); }
  return { default: { Pool, ...pgTypesMock() }, Pool, ...pgTypesMock() };
});
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true), getClientIp: vi.fn(() => '10.0.0.1') }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth/personalAccessTokens', () => ({
  validatePat: vi.fn(async () => ({ patId: 'pat-1', userId: 'user-1', companyId: 'company-1', scopes: ['read:reports'] })),
}));
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({
  getAppPool: () => ({ connect: async () => client }),
  getPlatformAdminPool: () => ({ connect: async () => client }),
}));

// Imported per test, AFTER vi.resetModules: a copy from the old module graph
// would read a different AsyncLocalStorage from the owner's and never see its store.
const queue = async (label: string) => {
  const { runAfterCommit } = await import('@/lib/afterCommit');
  runAfterCommit(label, async () => { h.events.push('CALLBACK'); });
};

const SECRET = 'a'.repeat(40);
const token = () => new SignJWT({ sub: 'user-1', aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
  .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(SECRET));

function makeRes() {
  const res = {
    statusCode: 200, headersSent: false,
    status(c: number) { res.statusCode = c; return res; },
    setHeader() { return res; }, getHeader() { return undefined; },
    json() { return res.end(); },
    end() { h.events.push('FLUSH'); return res; },
  };
  return res as unknown as NextApiResponse & { statusCode: number };
}

/** A handler that queues after-commit work, then answers `status`. */
function handlerAnswering(status: number) {
  return async (_req: unknown, res: NextApiResponse) => {
    await queue('probe');
    res.status(status).json({});
  };
}

type Owner = (status: number) => Promise<void>;
const owners: Array<[string, Owner]> = [
  ['withAuth', async (status) => {
    const { withAuth } = await import('@/lib/auth/withAuth');
    const req = { headers: { cookie: `sb-access-token=${await token()}; active_company_id=company-1` }, url: '/api/t' };
    await withAuth(handlerAnswering(status))(req as never, makeRes());
  }],
  ['bearer pipeline', async (status) => {
    const { runBearerRequest } = await import('@/lib/auth/bearerPipeline');
    const req = { headers: { authorization: 'Bearer pat_x' }, url: '/api/t', method: 'GET' };
    await runBearerRequest(req as never, makeRes(), `pat_${'A'.repeat(32)}`, handlerAnswering(status));
  }],
];

const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  vi.resetModules();
  h.events.length = 0; h.commitThrows = false;
  process.env.JWT_SECRET = SECRET;
  process.env.GOTRUE_URL = 'http://example.test/auth/v1';
  process.env.DATABASE_URL = 'postgresql://dummy:dummy@dummy/test';
  process.env.PLATFORM_ADMIN_DATABASE_URL = 'postgresql://dummy:dummy@dummy/test';
  process.env.SENTRY_ENABLED = 'false';
});

describe.each(owners)('%s', (_name, run) => {
  it('2xx: the callback runs once, after COMMIT', async () => {
    await run(200);
    await settle();
    expect(h.events.filter((e) => e === 'CALLBACK')).toHaveLength(1);
    expect(h.events.indexOf('COMMIT')).toBeLessThan(h.events.indexOf('CALLBACK'));
  });

  it('5xx: ROLLBACK, and the callback never runs', async () => {
    await run(500);
    await settle();
    expect(h.events).toContain('ROLLBACK');
    expect(h.events).not.toContain('CALLBACK');
  });

  it('a failed COMMIT: the callback never runs', async () => {
    h.commitThrows = true;
    await run(200);
    await settle();
    expect(h.events).toContain('COMMIT_THROW');
    expect(h.events).not.toContain('CALLBACK');
  });
});

describe('withPlatformAdmin', () => {
  async function run(handler: (req: unknown, res: NextApiResponse) => Promise<void>) {
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    await withPlatformAdmin(handler as never)({ headers: { cookie: `sb-access-token=${await token()}` }, url: '/api/admin/t' } as never, makeRes());
    await settle();
  }

  it('the callback runs after COMMIT', async () => {
    await run(async (_req, res) => { await queue('probe'); res.status(200).json({}); });
    expect(h.events.indexOf('COMMIT')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('COMMIT')).toBeLessThan(h.events.indexOf('CALLBACK'));
  });

  it('a critical-audit ROLLBACK drops the callback', async () => {
    const { als } = await import('@/lib/als');
    await run(async (_req, res) => {
      await queue('probe');
      als.getStore()!.criticalAuditFailed = true;
      res.status(200).json({});
    });
    expect(h.events).toContain('ROLLBACK');
    expect(h.events).not.toContain('CALLBACK');
  });
});
