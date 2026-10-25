// tests/integration/s07e-b-routes-paths-scan-now.int.test.ts
//
// S-07e part B (migration 946), review round 6, through the real routes on the production logins:
//  - a scan-now whose request ROLLS BACK (the handler throws after the scan: 500) leaves the
//    connection row as it was: the cursor, last_scan_at and counters are stamped only after the
//    request's COMMIT, so the cursor never passes documents the rollback removed; the same scan on
//    a request that commits moves the cursor;
//  - a second scan-now is refused (409) while one is running: for the same connection, and for
//    another connection of the same company; the first still completes.
// The IMAP client is stubbed; its connect() can be held open.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import scanNowRoute from '../../pages/api/accounting/capture/mirror/[id]/scan-now';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { routeAdminPool } from '@/lib/auth/routeAdminPool';
import { createImapConnection, deleteConnection } from '@/modules/accounting/services/capture/mirrorConnectionService';
import { getConnection, scanConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const imap = vi.hoisted(() => ({ hold: null as Promise<void> | null, connects: 0 }));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    streamer = { write: () => true, push: () => true }; // what the scan's byte meter wraps
    on() { /* the mirror registers an 'error' listener */ }
    close() { /* the guard closes a stopped client */ }
    async connect() { imap.connects += 1; if (imap.hold) await imap.hold; }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() { yield { uid: 9, size: 100, envelope: { subject: 'newsletter', from: [{ address: 'a@x.test' }] } }; }
    async fetchOne() { return false; }
    async logout() { return undefined; }
  },
}));

const ids = newIds();
const { owner, company } = ids;
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const row = async (id: string) => (await q('SELECT * FROM imap_mirror_connections WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
const mk = async (name: string) => (await createImapConnection({ companyId: company, displayName: name, accountEmail: `${name}@s07eb.test`,
  imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' })).id;

/** What scan-now does, then a handler failure: withErrorHandler answers 500 and withAuth ROLLS BACK. */
const failingScanNow = withAuth(withErrorHandler((async (req: CompanyAuthedRequest) => {
  const conn = await getConnection(String(req.query.id), req.companyId);
  await scanConnection(conn!);
  throw new Error('the handler failed after the scan');
}) as never));

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-s07e-b-encryption-key-over-32-characters');
  await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = 'owner'`, [company, owner]);
}, 60000);

afterAll(async () => {
  await q('DELETE FROM imap_mirror_connections WHERE company_id = $1', [company]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool(), routeAdminPool()]);
});

describe('S-07e part B (946): a scan-now whose request rolls back', () => {
  it('leaves the cursor, last_scan_at and the scan log as they were; the same scan on a request that commits moves the cursor', async () => {
    const id = await mk('rollback');
    const failed = await callRoute(failingScanNow, { sub: owner, method: 'POST', companyId: company, query: { id } });
    expect(failed.status).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 500)); // an eager stamp would have landed by now
    expect(await row(id)).toMatchObject({ scan_cursor: {}, last_scan_at: null, last_success_at: null, status: 'active' });
    expect((await q('SELECT count(*)::int AS n FROM imap_mirror_scan_log WHERE connection_id = $1', [id])).rows[0]).toEqual({ n: 0 });

    const ok = await callRoute(scanNowRoute, { sub: owner, method: 'POST', companyId: company, query: { id } });
    expect(ok.status).toBe(200);
    await vi.waitFor(async () => expect(await row(id)).toMatchObject({ scan_cursor: { INBOX: 9 }, status: 'active' }));
    expect((await row(id)).last_scan_at).not.toBeNull();
  });
});

describe('S-07e part B (946): a second scan-now while one is running', () => {
  it('is refused with 409 (same connection, and another connection of the company); the first completes; the next is allowed', async () => {
    const first = await mk('busy-1');
    const second = await mk('busy-2');
    let release: () => void = () => undefined;
    imap.hold = new Promise<void>((resolve) => { release = resolve; });
    imap.connects = 0;
    try {
      const running = callRoute(scanNowRoute, { sub: owner, method: 'POST', companyId: company, query: { id: first } });
      await vi.waitFor(() => expect(imap.connects).toBe(1));

      const sameConnection = await callRoute(scanNowRoute, { sub: owner, method: 'POST', companyId: company, query: { id: first } });
      const sameCompany = await callRoute(scanNowRoute, { sub: owner, method: 'POST', companyId: company, query: { id: second } });
      expect(sameConnection.status).toBe(409);
      expect(sameCompany.status).toBe(409);
      expect(imap.connects).toBe(1); // neither started a scan

      release();
      expect((await running).status).toBe(200);
    } finally {
      release();
      imap.hold = null;
    }
    expect((await callRoute(scanNowRoute, { sub: owner, method: 'POST', companyId: company, query: { id: second } })).status).toBe(200);
  }, 30000);
});

// Round 6: the settings writes (create, update, disconnect, reactivate, delete) run on routeAdminPool, not on the
// credential pool that sign-in shares, and wait 2 s for a row at most (that pool's migrationAdminTx waits 5 s). A
// delete held up by another migration_admin session (the fixture's superuser stands in) holds one route-pool
// connection, none of the credential pool's, and gives up at 2 s.
describe('S-07e part B (946): a delete blocked on a locked connection row', () => {
  it('holds a route-pool connection (never the credential pool\'s) and gives up at 2 s with 55P03', async () => {
    const id = await mk('blocked');
    const inUse = (pool: { totalCount: number; idleCount: number }) => pool.totalCount - pool.idleCount;
    const holder = await fixture.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM imap_mirror_connections WHERE id = $1 FOR UPDATE', [id]);

      const started = Date.now();
      const deleting = deleteConnection(id, company);
      const failed = expect(deleting).rejects.toMatchObject({ code: '55P03' });
      await vi.waitFor(() => expect(inUse(routeAdminPool())).toBe(1));
      expect(inUse(migrationAdminPool())).toBe(0);
      await failed;
      const elapsed = Date.now() - started;
      expect(elapsed, `the delete took ${elapsed}ms`).toBeGreaterThan(1800);
      expect(elapsed, `the delete took ${elapsed}ms`).toBeLessThan(4500);
      expect(inUse(routeAdminPool())).toBe(0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await row(id)).toBeDefined();
    expect(await deleteConnection(id, company)).toBe(true);
  }, 30000);
});
