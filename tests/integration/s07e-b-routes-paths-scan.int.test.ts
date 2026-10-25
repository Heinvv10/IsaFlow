// tests/integration/s07e-b-routes-paths-scan.int.test.ts
//
// S-07e part B (migration 946): no app role may write a connection row, so the scan's
// stamps, cursor included, and the error flip all run on migration_admin (routeAdminQuery),
// each committing on its own. Round 6: made inside a request (scan-now) they are queued and
// run once the request has COMMITTED, in order, so a request that rolls back never moves the
// cursor; scan-now's request holds only the key-share lock its scan-log INSERT takes on the
// row, which those UPDATEs do not wait for, so the request still answers promptly and the
// stamps (the status flip included) land just behind the response. Proven through the real
// scan-now route on the production logins; the IMAP client is stubbed so the scan fails AFTER
// the cursor stamp (the mailbox lock's release throws; the finally block that runs it sits
// after updateCursor).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import scanNowRoute from '../../pages/api/accounting/capture/mirror/[id]/scan-now';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { routeAdminPool } from '@/lib/auth/routeAdminPool';
import { createImapConnection } from '@/modules/accounting/services/capture/mirrorConnectionService';
import { markMirrorScanError } from '@/modules/accounting/services/capture/mirrorScanError';
import { listActiveConnections, scanAllDueConnections, scanConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const imap = vi.hoisted(() => ({ releaseError: 'mailbox lock release failed after the cursor stamp', releaseFails: true }));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    streamer = { write: () => true, push: () => true }; // what the scan's byte meter wraps
    on() { /* the mirror registers an 'error' listener */ }
    async connect() { return undefined; }
    async getMailboxLock() { return { release: () => { if (imap.releaseFails) throw new Error(imap.releaseError); } }; }
    async *fetch() { yield { uid: 9, size: 100, envelope: { subject: 'newsletter', from: [{ address: 'a@x.test' }] } }; }
    async fetchOne() { return false; }
    async logout() { return undefined; }
  },
}));

const ids = newIds();
const { owner, company, other } = ids;
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const row = async (id: string) => (await q('SELECT * FROM imap_mirror_connections WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
// A flip that waited on the request's own row lock would give up after 2 s and be lost (status stays 'active',
// checked below); this bounds the request itself, with room for a loaded box.
const PROMPT_MS = 2500;

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

describe('S-07e part B (946): scan-now fails after its cursor stamp', () => {
  it('answers promptly; the cursor stamp and then the error flip land on migration_admin right behind the response (no wait on its own row)', async () => {
    const { id } = await createImapConnection({ companyId: company, displayName: 'Lock', accountEmail: 'lock@s07eb.test',
      imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' });
    expect(await row(id)).toMatchObject({ status: 'active', scan_cursor: {} });

    const started = Date.now();
    const res = await callRoute(scanNowRoute, { sub: owner, method: 'POST', companyId: company, query: { id } });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect((res.body as { data: Record<string, number> }).data).toMatchObject({ scanned: 1, errors: 1 });
    expect(elapsed, `scan-now took ${elapsed}ms`).toBeLessThan(PROMPT_MS);
    // The cursor stamp was queued first and the error flip behind it: the cursor is there AND the flip is the last word
    // (a flip that ran first would have its last_error cleared by the cursor stamp).
    await vi.waitFor(async () => expect(await row(id)).toMatchObject({ scan_cursor: { INBOX: 9 }, status: 'error', last_error: imap.releaseError }));
  });
});

// No app role can lock a connection row any more (FOR UPDATE needs UPDATE, s07e-b-routes.int.test.ts); another
// migration_admin write can (the fixture's superuser stands in for it). The error write waits 2 s, not for as long
// as the lock is held, and is then lost: the cron scans its connections one after another, so an unbounded wait
// would stall the tick. No app-pool fallback is left (round 5).
describe('S-07e part B (946): a connection row locked by someone else, outside a request (the cron)', () => {
  it('gives the error write one 2 s wait, then moves on without throwing', async () => {
    const { id } = await createImapConnection({ companyId: company, displayName: 'Held', accountEmail: 'held@s07eb.test',
      imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' });
    const holder = await fixture.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM imap_mirror_connections WHERE id = $1 FOR UPDATE', [id]);

      const started = Date.now();
      await expect(markMirrorScanError('imap', { id, companyId: company }, 'boom')).resolves.toBeUndefined();
      const elapsed = Date.now() - started;

      // One 2 s wait + slack; the lock is held for far longer (until the release below).
      expect(elapsed, `markMirrorScanError took ${elapsed}ms`).toBeGreaterThan(1800);
      expect(elapsed, `markMirrorScanError took ${elapsed}ms`).toBeLessThan(4500);
      // It did not land: this failure's flip is lost, as documented (the next failing scan flips again).
      expect(await row(id)).toMatchObject({ status: 'active', last_error: null });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    await markMirrorScanError('imap', { id, companyId: company }, 'boom again');
    expect(await row(id)).toMatchObject({ status: 'error', last_error: 'boom again' });
  }, 30000);
});

// The cron's other writes (the scan log on the app pool; the cursor, the success stamp, the counters on
// migration_admin) wait for a locked row for 2 s at most. A connection whose row is held is skipped for this
// tick, not marked failed, and the connections behind it are still scanned. The due selection takes FOR NO KEY
// UPDATE SKIP LOCKED, so a row locked BEFORE the tick is not even selected; the bounded wait is for a lock taken
// after the selection, which the test sets up by selecting first and scanning the selected connections one by
// one, as the tick does.
describe('S-07e part B (946): the cron meets a connection row locked by someone else', () => {
  it('skips that connection after the bounded wait, leaves it active with its cursor, and scans the next one', async () => {
    imap.releaseFails = false;
    try {
      await q('DELETE FROM imap_mirror_connections WHERE company_id = ANY($1)', [[company, other]]);
      // One connection per company per tick (round 8): the held one is the company's, the free one the other company's.
      const mk = async (name: string, co: string) => (await createImapConnection({ companyId: co, displayName: name, accountEmail: `${name}@s07eb.test`,
        imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' })).id;
      const held = await mk('held-cron', company);
      const free = await mk('free-cron', other);
      const holder = await fixture.connect();
      try {
        // Selected before the lock is taken (the selector would skip a locked row), scanned after.
        const selected = (await listActiveConnections()).filter((c) => c.id === held || c.id === free);
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM imap_mirror_connections WHERE id = $1 FOR UPDATE', [held]);
        expect(selected.map((c) => c.id).sort()).toEqual([held, free].sort());
        expect((await listActiveConnections()).map((c) => c.id)).toEqual(expect.not.arrayContaining([held]));

        const started = Date.now();
        const results = [];
        for (const c of selected) results.push(await scanConnection(c));
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
