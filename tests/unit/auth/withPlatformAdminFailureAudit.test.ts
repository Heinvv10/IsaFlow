/**
 * withPlatformAdmin records EVERY rolled-back admin request, with the reason it rolled back (NUMRACE register (c),
 * rev-nrfb-blind M-1): a handler's 5xx, a rollback-only request, a failed critical audit write, a throw (including a
 * failed COMMIT) and a failed ROLLBACK — and records nothing for a committed answer; on the request's own connection
 * after a successful ROLLBACK, on the pool after a destroyed one. The integration file
 * admin-rollback-5xx.int.test.ts proves the row itself on a database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);
const audit = vi.hoisted(() => vi.fn());

const token = () => new SignJWT({ sub: 'user-1', aud: 'authenticated', role: 'authenticated', aal: 'aal2' })
  .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(TEST_SECRET));

function fakeClient(role: string | null, fail: RegExp | null = null) {
  const queries: string[] = [];
  const state = { released: undefined as boolean | undefined };
  return {
    queries, state,
    async query(text: string) {
      queries.push(text.trim());
      if (fail && fail.test(text)) throw new Error(`simulated ${text.trim()} failure`);
      if (/FROM users/i.test(text)) {
        return { rows: role ? [{ role, is_active: true, status: 'active', suspended_at: null }] : [] };
      }
      return { rows: [] };
    },
    release(destroy?: boolean) { state.released = Boolean(destroy); },
  };
}

function response() {
  const wire: { status: number; body: unknown }[] = [];
  const res = {
    statusCode: 200, headersSent: false,
    status(c: number) { this.statusCode = c; return this; },
    setHeader() { return this; }, getHeader() { return undefined; }, removeHeader() { /* dropped on rollback */ },
    json(v: unknown) { return this.end(JSON.stringify(v)); },
    end(body?: unknown) { wire.push({ status: this.statusCode, body: body === undefined ? null : JSON.parse(String(body)) }); return this; },
  };
  return { res: res as unknown as NextApiResponse, wire };
}

let lastAdmin: ReturnType<typeof fakeClient> | null = null;

async function run(handler: (req: unknown, res: NextApiResponse) => unknown, adminFail: RegExp | null = null) {
  const app = fakeClient('super_admin');
  const admin = fakeClient(null, adminFail);
  lastAdmin = admin;
  vi.doMock('@/lib/auth/withPlatformAdmin.pools', () => ({
    getAppPool: () => ({ connect: async () => app }),
    getPlatformAdminPool: () => ({ connect: async () => admin }),
  }));
  vi.doMock('@/lib/auth/adminFailureAudit', () => ({ auditFailedAdminRequest: audit }));
  const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
  const o = response();
  const req = { headers: { cookie: `sb-access-token=${await token()}` }, url: '/api/admin/x', method: 'POST' };
  await withPlatformAdmin(handler as never)(req as unknown as NextApiRequest, o.res);
  return { wire: o.wire, admin, req };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('JWT_SECRET', TEST_SECRET);
  vi.stubEnv('GOTRUE_URL', 'http://example.test/auth/v1');
  vi.stubEnv('DATABASE_URL', 'postgresql://postgres@localhost/ignored');
  vi.stubEnv('PLATFORM_ADMIN_DATABASE_URL', 'postgresql://platform_admin@localhost/ignored');
  audit.mockReset();
  audit.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.doUnmock('@/lib/auth/withPlatformAdmin.pools'); vi.doUnmock('@/lib/auth/adminFailureAudit'); vi.unstubAllEnvs();
});

const als = async () => (await import('@/lib/als')).als;

describe('withPlatformAdmin: the failure audit records every rollback, with its reason', () => {
  it("a handler's 5xx: rolled back, recorded 'rolled_back' with the status", async () => {
    const { wire, admin } = await run((_q, res) => { res.status(503).json({ success: false }); });
    expect(wire.map((w) => w.status)).toEqual([503]);
    expect(admin.queries).toContain('ROLLBACK');
    expect(admin.queries).not.toContain('COMMIT');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]!.slice(1, 4)).toEqual(['user-1', 503, 'rolled_back']);
  });

  it("a rollback-only request that answered 200: 500 COMMIT_FAILED, recorded 'rollback_only'", async () => {
    const store = await als();
    const { wire } = await run((_q, res) => {
      store.getStore()!.rollbackOnly = 'test';
      res.status(200).json({ success: true });
    });
    expect(wire[0]!.status).toBe(500);
    expect(audit.mock.calls[0]!.slice(1, 4)).toEqual(['user-1', 500, 'rollback_only']);
  });

  it("a failed critical audit write: 500 AUDIT_WRITE_FAILED, recorded 'audit_write_failed'", async () => {
    const store = await als();
    const { wire } = await run((_q, res) => {
      store.getStore()!.criticalAuditFailed = true;
      res.status(200).json({ success: true });
    });
    expect(wire[0]).toMatchObject({ status: 500, body: { error: { code: 'AUDIT_WRITE_FAILED' } } });
    expect(audit.mock.calls[0]!.slice(1, 4)).toEqual(['user-1', 500, 'audit_write_failed']);
  });

  it("a throw past the handler: answered 500, recorded 'threw'", async () => {
    const { wire } = await run(() => { throw new Error('boom'); });
    expect(wire[0]!.status).toBe(500);
    expect(audit.mock.calls[0]!.slice(1, 4)).toEqual(['user-1', 500, 'threw']);
  });

  it("a failed COMMIT: recorded 'threw'", async () => {
    const { wire } = await run((_q, res) => { res.status(200).json({ success: true }); }, /^COMMIT/);
    expect(wire.at(-1)!.status).toBe(500);
    expect(audit.mock.calls[0]!.slice(1, 4)).toEqual(['user-1', 500, 'threw']);
  });

  it('a failed ROLLBACK after a 5xx: still recorded, the connection destroyed', async () => {
    const { admin } = await run((_q, res) => { res.status(500).json({ success: false }); }, /^ROLLBACK/);
    expect(admin.state.released).toBe(true);
    expect(audit.mock.calls[0]!.slice(1, 4)).toEqual(['user-1', 500, 'rolled_back']);
  });

  it('a committed 200 and a 4xx record nothing', async () => {
    await run((_q, res) => { res.status(200).json({ success: true }); });
    await run((_q, res) => { res.status(422).json({ success: false }); });
    expect(audit).not.toHaveBeenCalled();
  });

  // brk-nrfb M-1: a second connection queued behind a busy pool and timed out, leaving no row.
  it("after a successful ROLLBACK the record goes on the request's own connection, before it is released", async () => {
    let releasedWhenAudited: boolean | undefined = true;
    audit.mockImplementation(async () => { releasedWhenAudited = lastAdmin!.state.released; });
    const { admin } = await run((_q, res) => { res.status(500).json({ success: false }); });
    expect(audit.mock.calls[0]![4]).toBe(admin);
    expect(releasedWhenAudited).toBeUndefined();
  });

  it('after a failed ROLLBACK (connection destroyed) it goes on the pool, after the release', async () => {
    let releasedWhenAudited: boolean | undefined;
    audit.mockImplementation(async () => { releasedWhenAudited = lastAdmin!.state.released; });
    await run((_q, res) => { res.status(500).json({ success: false }); }, /^ROLLBACK/);
    expect(audit.mock.calls[0]![4]).toBeUndefined();
    expect(releasedWhenAudited).toBe(true);
  });
});
