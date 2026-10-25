/**
 * S-07e part B, review round 6: a stamp commits on its own connection, so a scan-now's cursor,
 * success stamp and counters made while its request is open would outlive a request that then
 * rolls back (a failed COMMIT, a thrown handler): the cursor would pass documents the rollback
 * removed, and the next scan would never ingest them. In a request every stamp of a scan is
 * therefore queued (runAfterCommit) and runs only once the request has COMMITTED, in the order
 * it was made; a rollback drops the queue. Outside a request (the cron) a stamp runs at once.
 * Both mirrors, the real stamp writers and a real scan; the mailbox and the pools are fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/lib/als';

const h = vi.hoisted(() => ({
  route: [] as string[],
  /** Resolves the first stamp late, to prove the second one waits for it. */
  gate: null as Promise<void> | null,
  uids: [] as number[],
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidNext: 0 };
    streamer = { write: () => true, push: () => true };
    on() { /* the mirror registers an 'error' listener */ }
    async connect() { /* fake mailbox */ }
    async logout() { /* fake mailbox */ }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() {
      for (const uid of h.uids) yield { uid, size: 100, envelope: { from: [{ address: 'ap@supplier.test' }], to: [{ address: 'c@cust.test' }], subject: 'newsletter' } };
    }
    async fetchOne(uid: string) { return { uid: Number(uid), source: Buffer.from('msg') }; }
  },
}));
vi.mock('mailparser', () => ({ simpleParser: async () => ({ subject: 's', from: { text: 'a' }, attachments: [] }) }));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withTransaction: vi.fn() }));
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string) => {
    if (h.gate && /scan_cursor/.test(text)) await h.gate;
    h.route.push(text.replace(/\s+/g, ' ').trim());
    return [];
  }),
}));

import { als } from '@/lib/als';
import { drainAfterCommit, settleAfterRollback } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { markMirrorScanError } from '@/modules/accounting/services/capture/mirrorScanError';
import { addIngested, stampSuccess as imapSuccess, updateCursor } from '@/modules/accounting/services/capture/imapMirrorWrites';
import { addCounters, advanceCursor, stampSuccess as sentSuccess } from '@/modules/accounting/services/ar/sentMirrorWrites';
import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ref = { id: 'c1', companyId: COMPANY };
const requestCtx = (): RequestContext => ({ client: {} as RequestContext['client'], userId: 'u1', claims: {}, afterCommit: [], afterRollback: [] });
const imapConn = (): MirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor: { INBOX: 10 },
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u',
  imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});
const sentConn = (): SentMirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', sentFolder: 'Sent', scanCursor: { Sent: 10 },
  imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});

const STAMPS = [
  ['capture mirror', 'imap_mirror_connections', async () => {
    await updateCursor({ ...ref, scanCursor: {} }, 'INBOX', 12);
    await imapSuccess(ref);
    await addIngested(ref, 2);
  }, () => scanConnection(imapConn())],
  ['sent mirror', 'sent_mirror_connections', async () => {
    await advanceCursor({ ...ref, scanCursor: {} }, 'Sent', 12);
    await sentSuccess(ref);
    await addCounters(ref, 1, 1);
  }, () => scanSentConnection(sentConn())],
] as const;

beforeEach(() => {
  h.route.length = 0;
  h.gate = null;
  h.uids = [];
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

describe.each(STAMPS)('%s: stamps made by a scan', (_name, table, stamp, scan) => {
  it('outside a request they run at once', async () => {
    await stamp();
    expect(h.route).toHaveLength(3);
    expect(h.route.every((t) => t.startsWith(`UPDATE ${table}`))).toBe(true);
  });

  it('inside a request nothing runs until the request has COMMITTED, then all of them, in the order they were made', async () => {
    const ctx = requestCtx();
    await als.run(ctx, stamp);
    expect(h.route).toEqual([]);
    expect(ctx.afterCommit).toHaveLength(1); // one queue per request, not one callback per stamp
    drainAfterCommit(ctx);
    await vi.waitFor(() => expect(h.route).toHaveLength(3));
    expect(h.route[0]).toContain('SET scan_cursor');
    expect(h.route[1]).toMatch(/SET last_scan_at = NOW\(\), last_success_at = NOW\(\)/);
    expect(h.route[2]).toMatch(/_total = /);
  });

  it('inside a request that ROLLS BACK (withAuth drops the queue and never drains it) none of them ever runs', async () => {
    const ctx = requestCtx();
    await als.run(ctx, stamp);
    ctx.afterCommit = undefined;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.route).toEqual([]);
  });

  it('a slow first stamp is finished before the next starts (an error flip cannot land before a cursor stamp and be cleared by it)', async () => {
    let open: () => void = () => undefined;
    h.gate = new Promise<void>((resolve) => { open = resolve; });
    const ctx = requestCtx();
    await als.run(ctx, async () => {
      await stamp();
      await markMirrorScanError(table.startsWith('imap') ? 'imap' : 'sent', ref, 'boom');
    });
    drainAfterCommit(ctx);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.route).toEqual([]); // held at the cursor stamp: nothing behind it has run
    open();
    await vi.waitFor(() => expect(h.route).toHaveLength(4));
    expect(h.route[0]).toContain('SET scan_cursor');
    expect(h.route[3]).toContain("status = CASE WHEN status = 'active'");
  });

  it('a stamp made after its request finished (an abandoned scan) is dropped, with a warning, not run on a stranger\'s turn', async () => {
    const ctx = requestCtx();
    ctx.finished = true;
    await als.run(ctx, stamp);
    expect(h.route).toEqual([]);
    expect(ctx.afterCommit).toEqual([]);
    expect(vi.mocked(log.warn).mock.calls.filter((c) => /stamp dropped/.test(String(c[0])))).toHaveLength(3);
  });

  it('a whole scan-now whose request rolls back leaves the cursor where it was; one that commits advances it', async () => {
    h.uids = [11, 12];
    const rolledBack = requestCtx();
    await als.run(rolledBack, scan);
    rolledBack.afterCommit = undefined;
    settleAfterRollback(rolledBack, false); // the owner's finally: frees the scan's claim, which the next scan needs
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.route.filter((t) => /SET scan_cursor/.test(t))).toEqual([]);

    const committed = requestCtx();
    await als.run(committed, scan);
    drainAfterCommit(committed);
    await vi.waitFor(() => expect(h.route.some((t) => /SET scan_cursor/.test(t))).toBe(true));
  });
});
