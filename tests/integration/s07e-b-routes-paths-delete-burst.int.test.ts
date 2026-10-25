// tests/integration/s07e-b-routes-paths-delete-burst.int.test.ts
//
// S-07e part B (migration 946), review round 7 (breaker7): one tenant with write access and no SQL injection could stall
// EVERY tenant's authenticated requests. Its scan-now holds a key-share lock on the connection row (the scan-log INSERT in
// the request's transaction) for as long as the mail server keeps it waiting; a burst of DELETEs of that connection then
// each held an auth-pool connection and a transaction while queueing for the route pool (max 3) behind the row's lock
// (N=30: the auth pool at 10/10 with 22 waiting, another tenant's request 14.5 s). Through the real routes:
//  - while a scan of the connection holds its claim, N concurrent DELETEs are refused (409) at once, before any
//    database call: the route pool is never touched, and another tenant's request stays fast during the burst;
//  - where a row IS held by another session (no scan: the fixture's superuser stands in for a migration_admin session),
//    N concurrent DELETEs all give up with 503 within two lock waits (4 s), not in pairs at 2/4/6/8 s, because a write
//    that cannot get a route-pool connection fails in 2 s too.
// The IMAP client is stubbed; its body fetch can be held open.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import scanNowRoute from '../../pages/api/accounting/capture/mirror/[id]/scan-now';
import connectionRoute from '../../pages/api/accounting/capture/mirror/[id]/index';
import listRoute from '../../pages/api/accounting/capture/mirror/index';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { routeAdminPool } from '@/lib/auth/routeAdminPool';
import { createImapConnection } from '@/modules/accounting/services/capture/mirrorConnectionService';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const imap = vi.hoisted(() => ({ hold: null as Promise<void> | null, bodyFetches: 0 }));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    streamer = { write: () => true, push: () => true }; // what the scan's byte meter wraps
    on() { /* the mirror registers an 'error' listener */ }
    close() { /* the guard closes a stopped client */ }
    async connect() { /* fake mailbox */ }
    async getMailboxLock() { return { release: () => undefined }; }
    // uid 1 is logged (the scan-log INSERT takes the key-share lock); uid 2 hints at an invoice, so its body is fetched.
    async *fetch() {
      yield { uid: 1, size: 100, envelope: { subject: 'newsletter', from: [{ address: 'a@x.test' }] } };
      yield { uid: 2, size: 100, envelope: { subject: 'Invoice 1', from: [{ address: 'a@x.test' }] } };
    }
    async fetchOne() { imap.bodyFetches += 1; if (imap.hold) await imap.hold; return false; }
    async logout() { return undefined; }
  },
}));

const ids = newIds();
const { owner, company, other } = ids;
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const mk = async (co: string, name: string) => (await createImapConnection({ companyId: co, displayName: name, accountEmail: `${name}@s07eb.test`,
  imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' })).id;
const inUse = (pool: { totalCount: number; idleCount: number }) => pool.totalCount - pool.idleCount;
const timed = async <T,>(run: () => Promise<T>) => { const t0 = Date.now(); const r = await run(); return { r, ms: Date.now() - t0 }; };
const del = (co: string, id: string) => timed(() => callRoute(connectionRoute, { sub: owner, method: 'DELETE', companyId: co, query: { id } }));

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-s07e-b-encryption-key-over-32-characters');
  await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $2, 'owner')
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = 'owner'`, [company, owner, other]);
}, 60000);

afterAll(async () => {
  await q('DELETE FROM imap_mirror_scan_log WHERE company_id = ANY($1)', [[company, other]]);
  await q('DELETE FROM imap_mirror_connections WHERE company_id = ANY($1)', [[company, other]]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool(), routeAdminPool()]);
});

describe('S-07e part B (946): a burst of DELETEs of a connection a scan holds', () => {
  it('is refused with 409 at once, never reaches the route pool, and does not slow another tenant\'s request', async () => {
    const victim = await mk(company, 'burst-victim');
    await mk(other, 'burst-bystander');
    let release: () => void = () => undefined;
    imap.hold = new Promise<void>((resolve) => { release = resolve; });
    imap.bodyFetches = 0;
    try {
      const scan = callRoute(scanNowRoute, { sub: owner, method: 'POST', companyId: company, query: { id: victim } });
      await vi.waitFor(() => expect(imap.bodyFetches).toBe(1), { timeout: 10_000 });

      // The premise: the scan really does hold the row, so a DELETE that reached the database would queue behind it.
      const probe = await fixture.connect();
      try {
        await probe.query('BEGIN');
        await probe.query("SET LOCAL lock_timeout = '300ms'");
        await expect(probe.query('DELETE FROM imap_mirror_connections WHERE id = $1', [victim])).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await probe.query('ROLLBACK');
        probe.release();
      }

      const N = 30;
      let maxRoutePool = 0;
      const sampler = setInterval(() => { maxRoutePool = Math.max(maxRoutePool, inUse(routeAdminPool())); }, 5);
      try {
        const [bystander, ...burst] = await Promise.all([
          timed(() => callRoute(listRoute, { sub: owner, method: 'GET', companyId: other })),
          ...Array.from({ length: N }, () => del(company, victim)),
        ]);
        expect(burst.map((b) => b.r.status)).toEqual(Array(N).fill(409));
        const slowest = Math.max(...burst.map((b) => b.ms));
        expect(slowest, `the slowest refused DELETE took ${slowest}ms`).toBeLessThan(3000);
        expect(bystander.r.status).toBe(200);
        expect(bystander.ms, `another tenant's request took ${bystander.ms}ms during the burst`).toBeLessThan(1000);
      } finally {
        clearInterval(sampler);
      }
      expect(maxRoutePool).toBe(0);

      release();
      expect((await scan).status).toBe(200);
    } finally {
      release();
      imap.hold = null;
    }
    // The scan's claim is held until the request's stamps have run, a moment after its response: then it can be deleted.
    await vi.waitFor(async () => expect((await del(company, victim)).r.status).toBe(200), { timeout: 10_000, interval: 100 });
  }, 60000);
});

describe('S-07e part B (946): a burst of DELETEs of a row another session holds (no scan)', () => {
  it('all give up with 503 within two lock waits, not queued in pairs behind each other', async () => {
    const id = await mk(company, 'burst-held');
    const holder = await fixture.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM imap_mirror_connections WHERE id = $1 FOR UPDATE', [id]);
      const N = 8; // more than the route pool (3), within the auth pool (10): no waves of waiting for an auth connection
      const burst = await Promise.all(Array.from({ length: N }, () => del(company, id)));
      expect(burst.map((b) => b.r.status)).toEqual(Array(N).fill(503));
      const slowest = Math.max(...burst.map((b) => b.ms));
      expect(slowest, `the slowest DELETE took ${slowest}ms`).toBeLessThan(8000); // 2 s, or 4 s for a waiter handed a connection the instant its own wait ran out (6 s seen at load 25+); a 15 s connect timeout takes 10 s+
      expect(inUse(routeAdminPool())).toBe(0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await del(company, id)).r.status).toBe(200);
  }, 60000);
});
