// tests/integration/s07e-b-mirror-failure-cap.int.test.ts
//
// Migration 995: a scan that fails for a passing reason (a host name DNS gave no answer for, or an answer in
// private space; the network refused the connection) is counted on the row (consecutive_scan_failures), not
// flipped to 'error' at once. The failure that brings the count to the cap (about a day of scans at the row's own
// interval, at least 3) flips 'active' to 'error'; a successful scan resets the count. An unresolvable name and a
// name resolving into private space follow the identical trajectory (status, last_error, count), so a tenant
// cannot tell from either which internal names resolve. Real Postgres, real scans (scanConnection) on the
// migration_admin pool; DNS and the IMAP client are fakes.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { routeAdminPool } from '@/lib/auth/routeAdminPool';
import { createImapConnection } from '@/modules/accounting/services/capture/mirrorConnectionService';
import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';
import { createSentImapConnection } from '@/modules/accounting/services/ar/sentMirrorAdmin';
import { recordScanFailure } from '@/modules/accounting/services/capture/mirrorScanError';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const fake = vi.hoisted(() => ({ dns: new Map<string, 'fail' | string>(), connectCode: null as string | null,
  metas: [] as Array<{ uid: number; size: number; envelope: { subject: string; to: Array<{ address: string }> } }> }));
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => {
    const answer = fake.dns.get(host) ?? '93.184.216.34';
    if (answer === 'fail') throw Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: 'EAI_AGAIN' });
    return [{ address: answer, family: 4 }];
  },
}));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    streamer = { write: () => true, push: () => true }; // what the scan's byte meter wraps
    on() { /* the mirror registers an 'error' listener */ }
    async connect() {
      if (fake.connectCode) throw Object.assign(new Error(`connect ${fake.connectCode} 93.184.216.34:993`), { code: fake.connectCode });
    }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() { for (const m of fake.metas) yield m; } // empty by default: the scan succeeds with nothing new
    async fetchOne() { return false; }
    async logout() { return undefined; }
  },
}));

const ids = newIds();
const { company, other } = ids;
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const HOST_REFUSED = 'This mail server address is not allowed or could not be resolved';
// 360-minute interval: GREATEST(3, CEIL(1440 / 360)) = 4 failures in a row before 'error'.
const INTERVAL = 360;
const CAP = 4;

const state = async (table: string, id: string) =>
  (await q(`SELECT status, last_error, consecutive_scan_failures FROM ${table} WHERE id = $1`, [id])).rows[0] as
    { status: string; last_error: string | null; consecutive_scan_failures: number };

/** A connection on host, at INTERVAL, as the scan reads it. */
async function imapConn(name: string, host: string): Promise<MirrorConnection> {
  const { id } = await createImapConnection({ companyId: company, displayName: name, accountEmail: `${name}@cap.test`,
    imapHost: host, imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' });
  await q('UPDATE imap_mirror_connections SET scan_interval_minutes = $2 WHERE id = $1', [id, INTERVAL]);
  const r = (await q('SELECT imap_password_enc FROM imap_mirror_connections WHERE id = $1', [id])).rows[0] as { imap_password_enc: string };
  return { id, companyId: company, provider: 'imap', accountEmail: `${name}@cap.test`, folder: 'INBOX', scanCursor: {},
    allowedSenders: [], deniedSenders: [], imapHost: host, imapPort: 993, imapUseTls: true, imapUsername: 'ap',
    imapPasswordEnc: r.imap_password_enc, oauthRefreshTokenEnc: null };
}

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-s07e-b-encryption-key-over-32-characters');
}, 60000);

afterAll(async () => {
  await q('DELETE FROM imap_mirror_connections WHERE company_id = ANY($1)', [[company, other]]);
  await q('DELETE FROM sent_mirror_connections WHERE company_id = ANY($1)', [[company, other]]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool(), routeAdminPool()]);
});

beforeEach(async () => {
  fake.dns.clear();
  fake.connectCode = null;
  fake.metas = [];
  // At most 5 active connections per company (mirrorLimits.ts): each test starts with none.
  await q('DELETE FROM imap_mirror_connections WHERE company_id = $1', [company]);
});

describe('migration 995: consecutive transient scan failures are capped', () => {
  it('a new connection starts at 0', async () => {
    const c = await imapConn('fresh', 'imap.fresh.cap.test');
    expect(await state('imap_mirror_connections', c.id)).toEqual({ status: 'active', last_error: null, consecutive_scan_failures: 0 });
  });

  it('CAP-1 refused connects stay active; the CAP-th sets error', async () => {
    const c = await imapConn('refused', 'imap.refused.cap.test');
    fake.connectCode = 'ECONNREFUSED';
    for (let n = 1; n < CAP; n++) {
      expect((await scanConnection(c)).errors).toBe(1);
      expect(await state('imap_mirror_connections', c.id)).toEqual({
        status: 'active', last_error: 'Mail server could not be reached; will retry', consecutive_scan_failures: n });
    }
    await scanConnection(c);
    expect(await state('imap_mirror_connections', c.id)).toEqual({
      status: 'error', last_error: 'Mail server could not be reached; will retry', consecutive_scan_failures: CAP });
  });

  it('a successful scan in between resets the count, so the cap counts failures in a row', async () => {
    const c = await imapConn('flaky', 'imap.flaky.cap.test');
    fake.connectCode = 'ETIMEDOUT';
    for (let n = 1; n < CAP; n++) await scanConnection(c);
    expect((await state('imap_mirror_connections', c.id)).consecutive_scan_failures).toBe(CAP - 1);

    fake.connectCode = null;
    expect((await scanConnection(c)).errors).toBe(0);
    expect(await state('imap_mirror_connections', c.id)).toEqual({ status: 'active', last_error: null, consecutive_scan_failures: 0 });

    fake.connectCode = 'ETIMEDOUT';
    for (let n = 1; n < CAP; n++) await scanConnection(c);
    expect(await state('imap_mirror_connections', c.id)).toMatchObject({ status: 'active', consecutive_scan_failures: CAP - 1 });
  });

  it('an unresolvable name and a name resolving into private space have identical status, last_error and count, after 1 and after CAP failures', async () => {
    fake.dns.set('imap.gone.cap.test', 'fail');
    fake.dns.set('imap.inside.cap.test', '10.20.30.40');
    const gone = await imapConn('gone', 'imap.gone.cap.test');
    const inside = await imapConn('inside', 'imap.inside.cap.test');
    const both = async () => [await state('imap_mirror_connections', gone.id), await state('imap_mirror_connections', inside.id)];

    await scanConnection(gone);
    await scanConnection(inside);
    const [g1, i1] = await both();
    expect(g1).toEqual({ status: 'active', last_error: HOST_REFUSED, consecutive_scan_failures: 1 });
    expect(i1).toEqual(g1);

    for (let n = 2; n <= CAP; n++) { await scanConnection(gone); await scanConnection(inside); }
    const [gN, iN] = await both();
    expect(gN).toEqual({ status: 'error', last_error: HOST_REFUSED, consecutive_scan_failures: CAP });
    expect(iN).toEqual(gN);
  });

  it('the sent mirror counts and caps the same way, on its own row interval', async () => {
    const { id } = await createSentImapConnection({ companyId: company, displayName: 'Sent', accountEmail: 'sent@cap.test',
      imapHost: 'imap.sent.cap.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' });
    await q('UPDATE sent_mirror_connections SET scan_interval_minutes = $2 WHERE id = $1', [id, INTERVAL]);
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    for (let n = 1; n < CAP; n++) await recordScanFailure('sent', { id, companyId: company }, err);
    expect(await state('sent_mirror_connections', id)).toMatchObject({ status: 'active', consecutive_scan_failures: CAP - 1 });
    await recordScanFailure('sent', { id, companyId: company }, err);
    expect(await state('sent_mirror_connections', id)).toEqual({
      status: 'error', last_error: 'Mail server could not be reached; will retry', consecutive_scan_failures: CAP });
  });

  it('a sent mirror that recovers clears its error and its count, on both the success and the cursor stamp', async () => {
    await q('DELETE FROM sent_mirror_connections WHERE company_id = $1', [company]);
    const { id } = await createSentImapConnection({ companyId: company, displayName: 'Recover', accountEmail: 'recover@cap.test',
      imapHost: 'imap.recover.cap.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' });
    const enc = (await q('SELECT imap_password_enc FROM sent_mirror_connections WHERE id = $1', [id])).rows[0] as { imap_password_enc: string };
    const conn: SentMirrorConnection = { id, companyId: company, provider: 'imap', accountEmail: 'recover@cap.test', sentFolder: 'Sent',
      scanCursor: {}, imapHost: 'imap.recover.cap.test', imapPort: 993, imapUseTls: true, imapUsername: 'ap',
      imapPasswordEnc: enc.imap_password_enc, oauthRefreshTokenEnc: null };
    const failed = { status: 'active', last_error: 'Mail server could not be reached; will retry', consecutive_scan_failures: 2 };
    const recovered = { status: 'active', last_error: null, consecutive_scan_failures: 0 };

    fake.connectCode = 'ECONNREFUSED';
    await scanSentConnection(conn);
    await scanSentConnection(conn);
    expect(await state('sent_mirror_connections', id)).toEqual(failed);
    fake.connectCode = null;
    expect((await scanSentConnection(conn)).errors).toBe(0); // nothing new: the success stamp
    expect(await state('sent_mirror_connections', id)).toEqual(recovered);

    fake.connectCode = 'ECONNREFUSED';
    await scanSentConnection(conn);
    await scanSentConnection(conn);
    expect(await state('sent_mirror_connections', id)).toEqual(failed);
    fake.connectCode = null;
    fake.metas = [{ uid: 7, size: 100, envelope: { subject: 'Invoice', to: [{ address: 'c@x.test' }] } }]; // one new message: the cursor stamp
    await scanSentConnection(conn);
    expect(await state('sent_mirror_connections', id)).toEqual(recovered);
    expect((await q('SELECT scan_cursor FROM sent_mirror_connections WHERE id = $1', [id])).rows[0]).toEqual({ scan_cursor: { Sent: 7 } });
  });

  it('at the shortest interval the cap is a day of scans (288 at 5 minutes)', async () => {
    const c = await imapConn('fast', 'imap.fast.cap.test');
    await q('UPDATE imap_mirror_connections SET scan_interval_minutes = 5, consecutive_scan_failures = 286 WHERE id = $1', [c.id]);
    await recordScanFailure('imap', c, Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    expect(await state('imap_mirror_connections', c.id)).toMatchObject({ status: 'active', consecutive_scan_failures: 287 });
    await recordScanFailure('imap', c, Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    expect(await state('imap_mirror_connections', c.id)).toMatchObject({ status: 'error', consecutive_scan_failures: 288 });
  });

  it('at the longest interval (a day) the cap is still 3 failures in a row, not 1', async () => {
    const c = await imapConn('daily', 'imap.daily.cap.test');
    await q('UPDATE imap_mirror_connections SET scan_interval_minutes = 1440 WHERE id = $1', [c.id]);
    const err = Object.assign(new Error('x'), { code: 'EAI_AGAIN' });
    await recordScanFailure('imap', c, err);
    await recordScanFailure('imap', c, err);
    expect(await state('imap_mirror_connections', c.id)).toMatchObject({ status: 'active', consecutive_scan_failures: 2 });
    await recordScanFailure('imap', c, err);
    expect(await state('imap_mirror_connections', c.id)).toMatchObject({ status: 'error', consecutive_scan_failures: 3 });
  });
});
