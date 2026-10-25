// tests/integration/s07e-b-routes-paths-scan.int.test.ts
//
// S-07e part B (migration 946): scan-now's request transaction holds the
// connection row from the scan's cursor stamp on. If the scan then fails, the
// status flip to 'error' (migration_admin, not an app-pool column) would wait
// on that row lock until its 5s lock_timeout, then give up. mirrorScanError.ts
// therefore stamps the error in the request and defers the flip until the
// request has committed. Proven through the real scan-now route on the
// production logins; the IMAP client is stubbed so the scan fails AFTER the
// cursor stamp (the mailbox lock's release throws; the finally block that
// runs it sits after updateCursor).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import scanNowRoute from '../../pages/api/accounting/capture/mirror/[id]/scan-now';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { createImapConnection } from '@/modules/accounting/services/capture/mirrorConnectionService';
import { markMirrorScanError } from '@/modules/accounting/services/capture/mirrorScanError';
import { scanAllDueConnections } from '@/modules/accounting/services/capture/imapMirrorService';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const imap = vi.hoisted(() => ({ releaseError: 'mailbox lock release failed after the cursor stamp', releaseFails: true }));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    async connect() { return undefined; }
    async getMailboxLock() { return { release: () => { if (imap.releaseFails) throw new Error(imap.releaseError); } }; }
    async *fetch() { yield { uid: 9, envelope: { subject: 'newsletter', from: [{ address: 'a@x.test' }] } }; }
    async fetchOne() { return false; }
    async logout() { return undefined; }
  },
}));

const ids = newIds();
const { owner, company } = ids;
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const row = async (id: string) => (await q('SELECT * FROM imap_mirror_connections WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
// Well under migration_admin's 5s lock_timeout: a flip that waited on the row would not return in this time.
const PROMPT_MS = 2500;

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-s07e-b-encryption-key-over-32-characters');
  await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = 'owner'`, [company, owner]);
}, 60000);

afterAll(async () => {
  await q('DELETE FROM imap_mirror_connections WHERE company_id = $1', [company]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool()]);
});

describe('S-07e part B (946): scan-now fails after its cursor stamp', () => {
  it('answers promptly, then migration_admin flips the status to error once the request has committed', async () => {
    const { id } = await createImapConnection({ companyId: company, displayName: 'Lock', accountEmail: 'lock@s07eb.test',
      imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' });
    expect(await row(id)).toMatchObject({ status: 'active', scan_cursor: {} });

    const started = Date.now();
    const res = await callRoute(scanNowRoute, { sub: owner, method: 'POST', companyId: company, query: { id } });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect((res.body as { data: Record<string, number> }).data).toMatchObject({ scanned: 1, errors: 1 });
    expect(elapsed, `scan-now took ${elapsed}ms`).toBeLessThan(PROMPT_MS);
    // The cursor stamp (the row lock's source) committed with the request, so the failure came after it.
    expect((await row(id)).scan_cursor).toEqual({ INBOX: 9 });
    await vi.waitFor(async () => expect(await row(id)).toMatchObject({ status: 'error', last_error: imap.releaseError }), { timeout: 10000 });
  });
});

// An app role can lock a connection row (FOR UPDATE needs only the column UPDATE it holds). The flip waits its
// 5 s lock_timeout, and the fallback stamp that follows waits 2 s, not for as long as the lock is held: the
// cron scans its connections one after another, so an unbounded wait would stall the tick.
describe('S-07e part B (946): a connection row locked by someone else, outside a request (the cron)', () => {
  it('records the error as far as it can, within the two lock waits, and never throws', async () => {
    const { id } = await createImapConnection({ companyId: company, displayName: 'Held', accountEmail: 'held@s07eb.test',
      imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' });
    const holder = await fixture.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM imap_mirror_connections WHERE id = $1 FOR UPDATE', [id]);

      const started = Date.now();
      await expect(markMirrorScanError('imap', { id, companyId: company }, 'boom')).resolves.toBeUndefined();
      const elapsed = Date.now() - started;

      // 5 s (flip) + 2 s (stamp) + slack; the lock is held for far longer (until the release below).
      expect(elapsed, `markMirrorScanError took ${elapsed}ms`).toBeGreaterThan(5000);
      expect(elapsed, `markMirrorScanError took ${elapsed}ms`).toBeLessThan(9500);
      // Neither write landed: this failure's flip is lost, as documented (the next failing scan flips again).
      expect(await row(id)).toMatchObject({ status: 'active', last_error: null });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    await markMirrorScanError('imap', { id, companyId: company }, 'boom again');
    expect(await row(id)).toMatchObject({ status: 'error', last_error: 'boom again' });
  }, 30000);
});

// The cron's other writes (the scan log, the cursor, the success stamp, the counters) wait for a locked row for
// 2 s at most, outside a request. A connection whose row is held is skipped for this tick, not marked failed, and
// the connections behind it are still scanned.
describe('S-07e part B (946): the cron meets a connection row locked by someone else', () => {
  it('skips that connection after the bounded wait, leaves it active with its cursor, and scans the next one', async () => {
    imap.releaseFails = false;
    try {
      await q('DELETE FROM imap_mirror_connections WHERE company_id = $1', [company]);
      const mk = async (name: string) => (await createImapConnection({ companyId: company, displayName: name, accountEmail: `${name}@s07eb.test`,
        imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' })).id;
      const held = await mk('held-cron');
      const free = await mk('free-cron');
      const holder = await fixture.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM imap_mirror_connections WHERE id = $1 FOR UPDATE', [held]);

        const started = Date.now();
        const results = await scanAllDueConnections();
        const elapsed = Date.now() - started;

        // One 2 s wait (the scan log's key-share lock), not the lock's holding time and not a per-write 2 s.
        expect(elapsed, `the tick took ${elapsed}ms`).toBeGreaterThan(1800);
        expect(elapsed, `the tick took ${elapsed}ms`).toBeLessThan(5000);
        expect(results.find((r) => r.connectionId === held)).toMatchObject({ errors: 0, ingested: 0 });
        expect(results.find((r) => r.connectionId === free)).toMatchObject({ scanned: 1, errors: 0 });
        expect(await row(held)).toMatchObject({ status: 'active', last_error: null, scan_cursor: {}, last_scan_at: null });
        expect(await row(free)).toMatchObject({ status: 'active', last_error: null, scan_cursor: { INBOX: 9 } });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      // Next tick, the row free: it is scanned.
      await scanAllDueConnections();
      expect(await row(held)).toMatchObject({ status: 'active', last_error: null, scan_cursor: { INBOX: 9 } });
    } finally {
      imap.releaseFails = true;
    }
  }, 30000);
});
