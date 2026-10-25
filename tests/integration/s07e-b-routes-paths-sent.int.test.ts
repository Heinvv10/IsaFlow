// tests/integration/s07e-b-routes-paths-sent.int.test.ts
//
// S-07e part B (migration 946): sent_mirror_connections is written by the app
// pools only on the scan stamps; create, update, disconnect, delete and
// markScanError's status flip run on migration_admin. Proven through the real
// routes on the production logins (disconnect has no route: the service is
// called directly); the IMAP client is stubbed (no network).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import sentIndex from '../../pages/api/accounting/ar/sent-mirror/connections/index';
import sentItem from '../../pages/api/accounting/ar/sent-mirror/connections/[id]/index';
import scanNowRoute from '../../pages/api/accounting/ar/sent-mirror/connections/[id]/scan-now';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { decrypt } from '@/lib/encryption';
import { createSentImapConnection, disconnectSentConnection } from '@/modules/accounting/services/ar/sentMirrorAdmin';
import { listActiveSentConnections, scanAllDueSentConnections } from '@/modules/accounting/services/ar/sentMirrorService';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const imap = vi.hoisted(() => ({ connectError: null as string | null,
  metas: [] as Array<{ uid: number; envelope: { subject: string; to: Array<{ address: string }> } }> }));
// The create route and the scan resolve the IMAP host first (imapTargetGuard): the fake .test names are a public address here.
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidNext: 100 };
    async connect() { if (imap.connectError) throw new Error(imap.connectError); }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() { for (const m of imap.metas) yield m; }
    async fetchOne(seq: string) { return { uid: Number(seq), source: Buffer.from('From: me@s07eb.test\r\nTo: c@x.test\r\nSubject: hi\r\n\r\nno attachment\r\n') }; }
    async logout() { return undefined; }
  },
}));

const ids = newIds();
const { owner, company, other } = ids;
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const row = async (id: string) => (await q('SELECT * FROM sent_mirror_connections WHERE id = $1', [id])).rows[0] as Record<string, unknown> | undefined;
const as = (route: unknown, method: string, opts: { body?: unknown; id?: string } = {}) =>
  callRoute(route, { sub: owner, method, companyId: company, body: opts.body, query: opts.id ? { id: opts.id } : {} });
const conn = (r: { body: unknown }) => (r.body as { data: { connection: Record<string, unknown> } }).data.connection;
const create = () => as(sentIndex, 'POST', { body: { displayName: 'Sent', accountEmail: `me-${crypto.randomUUID().slice(0, 8)}@s07eb.test`,
  imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'me', imapPassword: 'mailbox-pw' } });

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-s07e-b-encryption-key-over-32-characters');
  await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = 'owner'`, [company, owner]);
}, 60000);

afterAll(async () => {
  await q('DELETE FROM sent_mirror_connections WHERE company_id = ANY($1)', [[company, other]]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool()]);
});

beforeEach(() => { imap.connectError = null; imap.metas = []; });

describe('S-07e part B (946): sent-mirror connections, through the routes on the production logins', () => {
  it('create, list, update, disconnect, delete; the mailbox password is stored encrypted and wiped on disconnect', async () => {
    const created = await create();
    expect(created.status).toBe(201);
    const id = String(conn(created).id);
    const stored = await row(id);
    expect(stored).toMatchObject({ company_id: company, provider: 'imap', status: 'active', sent_folder: 'Sent', scan_interval_minutes: 10 });
    expect(decrypt(String(stored!.imap_password_enc))).toBe('mailbox-pw');

    const listed = await as(sentIndex, 'GET');
    expect((listed.body as { data: { items: Array<{ id: string }> } }).data.items.map((c) => c.id)).toContain(id);

    expect((await as(sentItem, 'PATCH', { id, body: { sentFolder: 'Sent Items', scanIntervalMinutes: 30 } })).status).toBe(200);
    expect(await row(id)).toMatchObject({ sent_folder: 'Sent Items', scan_interval_minutes: 30 });

    expect(await disconnectSentConnection(id, company)).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'disconnected', imap_password_enc: null });
    expect((await row(id))!.disconnected_at).not.toBeNull();

    expect((await as(sentItem, 'DELETE', { id })).status).toBe(200);
    expect(await row(id)).toBeUndefined();
  });

  it('a scan\'s stamp (cursor, last_scan_at, last_success_at) writes on the app pool', async () => {
    const id = String(conn(await create()).id);
    imap.metas = [{ uid: 9, envelope: { subject: 'hi', to: [{ address: 'c@x.test' }] } }];
    const scan = await as(scanNowRoute, 'POST', { id });
    expect(scan.status).toBe(200);
    expect((scan.body as { data: Record<string, number> }).data).toMatchObject({ scanned: 1, skipped: 1, errors: 0 });
    const r = await row(id);
    expect(r!.scan_cursor).toEqual({ Sent: 9 });
    expect(r!.last_scan_at).not.toBeNull();
    expect(r!.last_success_at).not.toBeNull();
    expect(r!.status).toBe('active');
    expect((await q('SELECT outcome FROM sent_mirror_scan_log WHERE connection_id = $1', [id])).rows).toEqual([{ outcome: 'skipped_no_attachment' }]);
  });

  it('the app pool may write the counter stamps but not status, the host or a delete (42501)', async () => {
    const id = String(conn(await create()).id);
    const pool = getDbPool();
    await pool.query('UPDATE sent_mirror_connections SET messages_captured_total = 2, messages_linked_total = 1 WHERE id = $1', [id]);
    expect(await row(id)).toMatchObject({ messages_captured_total: 2, messages_linked_total: 1 });
    await expect(pool.query(`UPDATE sent_mirror_connections SET status = 'error' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query(`UPDATE sent_mirror_connections SET imap_host = 'evil.test' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('DELETE FROM sent_mirror_connections WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501' });
  });

  it('a scan that cannot connect records the error and flips the status via migration_admin', async () => {
    const id = String(conn(await create()).id);
    imap.connectError = 'connect ECONNREFUSED';
    const scan = await as(scanNowRoute, 'POST', { id });
    expect(scan.status).toBe(200);
    expect((scan.body as { data: Record<string, number> }).data.errors).toBe(1);
    // The error is stamped in the request; the status flip is deferred until it has committed (mirrorScanError.ts).
    await vi.waitFor(async () => expect(await row(id)).toMatchObject({ status: 'error', last_error: 'connect ECONNREFUSED' }), { timeout: 10000 });
    expect((await row(id))!.last_scan_at).not.toBeNull();
  });
});

describe('S-07e part B (946): another tenant\'s sent-mirror connection', () => {
  it('an owner of company A cannot update, delete or scan company B\'s connection, nor disconnect it by id', async () => {
    const theirs = (await createSentImapConnection({ companyId: other, displayName: 'Theirs', accountEmail: 'b@theirs.test',
      imapHost: 'imap.theirs.test', imapPort: 993, imapUsername: 'u', imapPassword: 'their-pw' })).id;
    const before = await row(theirs);
    expect((await as(sentItem, 'PATCH', { id: theirs, body: { sentFolder: 'X', scanIntervalMinutes: 1 } })).status).toBe(404);
    expect((await as(sentItem, 'DELETE', { id: theirs })).status).toBe(404);
    expect((await as(scanNowRoute, 'POST', { id: theirs })).status).toBe(404);
    expect(await disconnectSentConnection(theirs, company)).toBe(false);
    expect(await row(theirs)).toEqual(before);
  });
});

// An app login may write last_scan_at (a scan stamp), so it can stamp another tenant's row into the future; the
// cron's due check used to wait for that time to pass, which silenced the connection for good.
describe('S-07e part B (946): the cron treats a last_scan_at in the future as due', () => {
  const make = async (name: string, lastScan: string | null): Promise<string> => {
    const { id } = await createSentImapConnection({ companyId: other, displayName: name, accountEmail: `${name}@s07eb.test`,
      imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'me', imapPassword: 'mailbox-pw' });
    if (lastScan !== null) {
      // As the app login, the way a forged stamp arrives.
      await getDbPool().query('UPDATE sent_mirror_connections SET last_scan_at = $2::timestamptz WHERE id = $1', [id, lastScan]);
    }
    return id;
  };

  it('picks never-scanned, due, and future-stamped rows (even \'infinity\'), and leaves a row scanned a minute ago', async () => {
    await q('DELETE FROM sent_mirror_connections WHERE company_id = ANY($1)', [[company, other]]);
    const never = await make('never', null);
    const stale = await make('stale', new Date(Date.now() - 600_000).toISOString());
    const fresh = await make('fresh', new Date(Date.now() - 60_000).toISOString());
    const future = await make('future', '9999-01-01T00:00:00Z');
    const soon = await make('soon', new Date(Date.now() + 60_000).toISOString());
    const forever = await make('forever', 'infinity');
    const due = (await listActiveSentConnections()).map((c) => c.id);
    expect(due).toEqual(expect.arrayContaining([never, stale, future, soon, forever]));
    expect(due).not.toContain(fresh);
    // Never-scanned and future-stamped rows come first, ahead of the row that has merely waited longest.
    expect(due.indexOf(stale)).toBeGreaterThan(Math.max(due.indexOf(never), due.indexOf(future), due.indexOf(forever)));
  });

  it('a scan of the cron then stamps it back to now', async () => {
    await q('DELETE FROM sent_mirror_connections WHERE company_id = ANY($1)', [[company, other]]);
    const future = await make('future2', '9999-01-01T00:00:00Z');
    const results = await scanAllDueSentConnections();
    expect(results.find((r) => r.connectionId === future)).toMatchObject({ errors: 0 });
    const r = await row(future);
    expect(new Date(r!.last_scan_at as string | Date).getTime()).toBeLessThan(Date.now() + 5000);
    expect(r).toMatchObject({ status: 'active', last_error: null });
  });
});

// The cron's other writes (the scan log, the cursor, the success stamp, the counters) wait for a locked row for
// 2 s at most, outside a request. A connection whose row is held is skipped for this tick, not marked failed, and
// the connections behind it are still scanned.
describe('S-07e part B (946): the cron meets a sent-mirror row locked by someone else', () => {
  it('skips that connection after the bounded wait, leaves it active with its cursor, and scans the next one', async () => {
    imap.metas = [{ uid: 9, envelope: { subject: 'Invoice', to: [{ address: 'c@x.test' }] } }];
    await q('DELETE FROM sent_mirror_connections WHERE company_id = $1', [company]);
    const mk = async (name: string) => (await createSentImapConnection({ companyId: company, displayName: name, accountEmail: `${name}@s07eb.test`,
      imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'me', imapPassword: 'mailbox-pw' })).id;
    const held = await mk('held-cron');
    const free = await mk('free-cron');
    const holder = await fixture.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM sent_mirror_connections WHERE id = $1 FOR UPDATE', [held]);

      const started = Date.now();
      const results = await scanAllDueSentConnections();
      const elapsed = Date.now() - started;

      // One 2 s wait (the scan log's key-share lock), not the lock's holding time and not a per-write 2 s.
      expect(elapsed, `the tick took ${elapsed}ms`).toBeGreaterThan(1800);
      expect(elapsed, `the tick took ${elapsed}ms`).toBeLessThan(5000);
      expect(results.find((r) => r.connectionId === held)).toMatchObject({ errors: 0, captured: 0 });
      expect(results.find((r) => r.connectionId === free)).toMatchObject({ scanned: 1, errors: 0 });
      expect(await row(held)).toMatchObject({ status: 'active', last_error: null, scan_cursor: {}, last_scan_at: null });
      expect(await row(free)).toMatchObject({ status: 'active', last_error: null, scan_cursor: { Sent: 9 } });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    await scanAllDueSentConnections();
    expect(await row(held)).toMatchObject({ status: 'active', last_error: null, scan_cursor: { Sent: 9 } });
  }, 30000);
});
