// tests/integration/s07e-b-routes-paths-imap.int.test.ts
//
// S-07e part B (migration 946): no app role writes imap_mirror_connections.
// Create, update, disconnect, reactivate and delete run on migration_admin
// (migrationAdminTx); the scan stamps (cursor, last_scan_at, last_success_at,
// last_error, the counter), the status flip and the due selection on the same
// login's own pool (routeAdminQuery, review round 5). Proven through the real
// routes on the production logins; the IMAP client is stubbed (no network).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import mirrorIndex from '../../pages/api/accounting/capture/mirror/index';
import mirrorItem from '../../pages/api/accounting/capture/mirror/[id]/index';
import disconnectRoute from '../../pages/api/accounting/capture/mirror/[id]/disconnect';
import scanNowRoute from '../../pages/api/accounting/capture/mirror/[id]/scan-now';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { routeAdminPool } from '@/lib/auth/routeAdminPool';
import { decrypt } from '@/lib/encryption';
import { createImapConnection, reactivateConnection } from '@/modules/accounting/services/capture/mirrorConnectionService';
import { listActiveConnections, scanAllDueConnections } from '@/modules/accounting/services/capture/imapMirrorService';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const imap = vi.hoisted(() => ({ connectError: null as string | null,
  metas: [] as Array<{ uid: number; size?: number; envelope: { subject: string; from: Array<{ address: string }> } }> }));
// The create route and the scan resolve the IMAP host first (imapTargetGuard): the fake .test names are a public address here.
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    streamer = { write: () => true, push: () => true }; // what the scan's byte meter wraps
    on() { /* the mirror registers an 'error' listener */ }
    async connect() { if (imap.connectError) throw new Error(imap.connectError); }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() { for (const m of imap.metas) yield m; }
    async fetchOne() { return false; }
    async logout() { return undefined; }
  },
}));

const ids = newIds();
const { owner, company, other } = ids;
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const row = async (id: string) => (await q('SELECT * FROM imap_mirror_connections WHERE id = $1', [id])).rows[0] as Record<string, unknown> | undefined;
const as = (route: unknown, method: string, opts: { body?: unknown; id?: string } = {}, companyId = company) =>
  callRoute(route, { sub: owner, method, companyId, body: opts.body, query: opts.id ? { id: opts.id } : {} });
const conn = (r: { body: unknown }) => (r.body as { data: { connection: Record<string, unknown> } }).data.connection;
const create = (extra: Record<string, unknown> = {}) => as(mirrorIndex, 'POST', { body: { displayName: 'Inbox', accountEmail: `ap-${crypto.randomUUID().slice(0, 8)}@s07eb.test`,
  imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw', ...extra } });

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-s07e-b-encryption-key-over-32-characters');
  await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = 'owner'`, [company, owner]);
}, 60000);

afterAll(async () => {
  await q('DELETE FROM imap_mirror_connections WHERE company_id = ANY($1)', [[company, other]]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool(), routeAdminPool()]);
});

beforeEach(() => { imap.connectError = null; imap.metas = []; });

describe('S-07e part B (946): IMAP mirror connections, through the routes on the production logins', () => {
  it('create, list, update, disconnect, reactivate, delete; the mailbox password is stored encrypted and wiped on disconnect', async () => {
    const created = await create({ allowedSenders: ['a@x.test'] });
    expect(created.status).toBe(201);
    const id = String(conn(created).id);
    const stored = await row(id);
    expect(stored).toMatchObject({ company_id: company, provider: 'imap', status: 'active', folder: 'INBOX', scan_interval_minutes: 5 });
    expect(stored!.imap_password_enc).not.toBe('mailbox-pw');
    expect(decrypt(String(stored!.imap_password_enc))).toBe('mailbox-pw');

    const listed = await as(mirrorIndex, 'GET');
    expect((listed.body as { data: { items: Array<{ id: string }> } }).data.items.map((c) => c.id)).toContain(id);

    const patched = await as(mirrorItem, 'PATCH', { id, body: { allowedSenders: ['b@x.test'], deniedSenders: ['bad.test'],
      scanIntervalMinutes: 15, folder: 'Invoices' } });
    expect(patched.status).toBe(200);
    const after = await row(id);
    expect(after).toMatchObject({ scan_interval_minutes: 15, folder: 'Invoices' });
    expect(after!.allowed_senders).toEqual(['b@x.test']);
    expect(after!.denied_senders).toEqual(['bad.test']);

    expect((await as(disconnectRoute, 'POST', { id })).status).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'disconnected', imap_password_enc: null });
    expect((await row(id))!.disconnected_at).not.toBeNull();

    await q(`UPDATE imap_mirror_connections SET last_error = 'old' WHERE id = $1`, [id]);
    expect(await reactivateConnection(id, company)).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'active', last_error: null, disconnected_at: null });

    expect((await as(mirrorItem, 'DELETE', { id })).status).toBe(200);
    expect(await row(id)).toBeUndefined();
  });

  it('a scan\'s stamp (cursor, last_scan_at, last_success_at, last_error) is written, on migration_admin', async () => {
    const id = String(conn(await create()).id);
    await q(`UPDATE imap_mirror_connections SET last_error = 'stale' WHERE id = $1`, [id]);
    imap.metas = [{ uid: 7, size: 100, envelope: { subject: 'newsletter', from: [{ address: 'a@x.test' }] } }];
    const scan = await as(scanNowRoute, 'POST', { id });
    expect(scan.status).toBe(200);
    expect((scan.body as { data: Record<string, number> }).data).toMatchObject({ scanned: 1, ingested: 0, skipped: 1, errors: 0 });
    // The stamps are queued for after the request's COMMIT (round 6): they land just behind the response.
    await vi.waitFor(async () => expect((await row(id))!.scan_cursor).toEqual({ INBOX: 7 }));
    const r = await row(id);
    expect(r!.last_scan_at).not.toBeNull();
    expect(r!.last_success_at).not.toBeNull();
    expect(r!.last_error).toBeNull();
    expect(r!.status).toBe('active');
    expect((await q('SELECT outcome FROM imap_mirror_scan_log WHERE connection_id = $1', [id])).rows).toEqual([{ outcome: 'skipped_not_invoice' }]);
  });

  it('the app pool may write neither a stamp nor status nor the host (42501)', async () => {
    const id = String(conn(await create()).id);
    const pool = getDbPool();
    await expect(pool.query('UPDATE imap_mirror_connections SET messages_ingested_total = messages_ingested_total + 3 WHERE id = $1', [id]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('UPDATE imap_mirror_connections SET last_scan_at = NULL WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    expect((await row(id))!.messages_ingested_total).toBe(0);
    await expect(pool.query(`UPDATE imap_mirror_connections SET status = 'error' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query(`UPDATE imap_mirror_connections SET imap_host = 'evil.test' WHERE id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('DELETE FROM imap_mirror_connections WHERE id = $1', [id])).rejects.toMatchObject({ code: '42501' });
  });

  it('a scan that cannot connect records the error and flips the status via migration_admin', async () => {
    const id = String(conn(await create()).id);
    imap.connectError = 'connect ECONNREFUSED';
    const scan = await as(scanNowRoute, 'POST', { id });
    expect(scan.status).toBe(200);
    expect((scan.body as { data: Record<string, number> }).data.errors).toBe(1);
    // Written on migration_admin just after the request's COMMIT (round 6: mirrorScanError.ts queues it with the other stamps).
    await vi.waitFor(async () => expect(await row(id)).toMatchObject({ status: 'error', last_error: 'connect ECONNREFUSED' }));
    expect((await row(id))!.last_scan_at).not.toBeNull();
  });
});

describe('S-07e part B (946): another tenant\'s IMAP connection', () => {
  it('an owner of company A cannot update, disconnect or delete company B\'s connection, nor scan it', async () => {
    const theirs = (await createImapConnection({ companyId: other, displayName: 'Theirs', accountEmail: 'b@theirs.test',
      imapHost: 'imap.theirs.test', imapPort: 993, imapUsername: 'u', imapPassword: 'their-pw' })).id;
    const before = await row(theirs);
    expect((await as(mirrorItem, 'PATCH', { id: theirs, body: { folder: 'X', scanIntervalMinutes: 5, allowedSenders: ['evil.test'] } })).status).toBe(404);
    expect((await as(disconnectRoute, 'POST', { id: theirs })).status).toBe(404);
    expect((await as(mirrorItem, 'DELETE', { id: theirs })).status).toBe(404);
    expect((await as(scanNowRoute, 'POST', { id: theirs })).status).toBe(404);
    expect(await row(theirs)).toEqual(before);
  });
});

// While last_scan_at was app-writable (rounds 1-4) an app login could stamp another tenant's row into the future,
// and the cron's due check used to wait for that time to pass, which silenced the connection for good. Round 5
// refuses the forgery; a future stamp (an ops write, a clock step) is still due and sorts last.
describe('S-07e part B (946): the cron treats a last_scan_at in the future as due', () => {
    // Round 8: the due selection takes one connection per company, and a company holds at most 5: each row gets a company of its own.
  const solo: string[] = [];
  const soloCompany = async (): Promise<string> => {
    const id = crypto.randomUUID();
    await q('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [id, `s07eb-solo-${id.slice(0, 8)}`]);
    solo.push(id);
    return id;
  };
  afterEach(async () => {
    await q('DELETE FROM imap_mirror_connections WHERE company_id = ANY($1)', [solo]);
    await q('DELETE FROM companies WHERE id = ANY($1)', [solo]);
    solo.length = 0;
  });
const make = async (name: string, lastScan: string | null): Promise<string> => {
    const { id } = await createImapConnection({ companyId: await soloCompany(), displayName: name, accountEmail: `${name}@s07eb.test`,
      imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' });
    if (lastScan !== null) {
      // The app login's forgery is refused; the stamp is set as the table's owner would.
      await expect(getDbPool().query('UPDATE imap_mirror_connections SET last_scan_at = $2::timestamptz WHERE id = $1', [id, lastScan]))
        .rejects.toMatchObject({ code: '42501' });
      await q('UPDATE imap_mirror_connections SET last_scan_at = $2::timestamptz WHERE id = $1', [id, lastScan]);
    }
    return id;
  };

  it('picks never-scanned, due, and future-stamped rows (even \'infinity\'), and leaves a row scanned a minute ago', async () => {
    await q('DELETE FROM imap_mirror_connections WHERE company_id = ANY($1)', [[company, other]]);
    const never = await make('never', null);
    const stale = await make('stale', new Date(Date.now() - 600_000).toISOString());
    const fresh = await make('fresh', new Date(Date.now() - 60_000).toISOString());
    const future = await make('future', '9999-01-01T00:00:00Z');
    const soon = await make('soon', new Date(Date.now() + 60_000).toISOString());
    const forever = await make('forever', 'infinity');
    const due = (await listActiveConnections()).map((c) => c.id);
    expect(due).toEqual(expect.arrayContaining([never, stale, future, soon, forever]));
    expect(due).not.toContain(fresh);
    // Round 4: a never-scanned row first, then the row that has waited longest; the future-stamped rows (forged or not) last.
    expect(due.indexOf(never)).toBeLessThan(due.indexOf(stale));
    expect(due.indexOf(stale)).toBeLessThan(Math.min(due.indexOf(future), due.indexOf(soon), due.indexOf(forever)));
  });

  it('a scan of the cron then stamps it back to now', async () => {
    await q('DELETE FROM imap_mirror_connections WHERE company_id = ANY($1)', [[company, other]]);
    const future = await make('future2', '9999-01-01T00:00:00Z');
    const results = await scanAllDueConnections();
    expect(results.find((r) => r.connectionId === future)).toMatchObject({ errors: 0 });
    const r = await row(future);
    expect(new Date(r!.last_scan_at as string | Date).getTime()).toBeLessThan(Date.now() + 5000);
    expect(r).toMatchObject({ status: 'active', last_error: null });
  });
});
