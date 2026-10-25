/**
 * S-07e part B, review round 2: `scan_cursor` is a column the app pool may
 * write, so a forged claim can put anything in it. A cursor went straight into
 * `FETCH <cursor + 1>:*`; 1.5 or 1e20 makes the server answer BAD, the scan
 * throws, and the connection flips to 'error' (the victim's). A folder's cursor
 * is now used only when it is a positive safe integer; otherwise it is logged
 * and the folder is scanned as if it had none. Both mirror services, with the
 * mailbox recording the range it was asked for.
 *
 * Round 3: an IMAP number is at most 2^32 - 1 (a larger one is a BAD from a strict
 * server, or, on the sent mirror, a folder skipped for good), and a cursor at or
 * past the mailbox's UIDNEXT can never be reached, so it is judged invalid too.
 *
 * Round 4: such a cursor is clamped to UIDNEXT - 1 (nothing old is scanned, new mail is
 * picked up) and the clamped value is written back; it was a rescan from UID 1.
 *
 * Round 5: no app role may write `scan_cursor` any more (the write is migration_admin's,
 * routeAdminQuery); these checks stay as a defence against an ops edit or a server whose
 * UIDNEXT went backwards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ ranges: [] as string[], markError: vi.fn(), uidNext: 0, statements: [] as { q: string; v: unknown[] }[] }));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidNext: h.uidNext };
    streamer = { write: () => true, push: () => true }; // what the scan's byte meter wraps
    on() { /* the mirror registers an 'error' listener */ }
    async connect() { /* fake mailbox */ }
    async logout() { /* fake mailbox */ }
    async getMailboxLock() { return { release: () => undefined }; }
    // eslint-disable-next-line require-yield
    async *fetch(range: string) { h.ranges.push(range); }
  },
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  const sql = vi.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => { h.statements.push({ q: strings.join('?').replace(/\s+/g, ' ').trim(), v }); return []; });
  return { sql, withTransaction: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) };
});
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string, v: unknown[]) => { h.statements.push({ q: text.replace(/\s+/g, ' ').trim(), v }); return []; }),
}));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/documentStorage', () => ({ sha256: vi.fn(), storeCapturedBytes: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', () => ({ ensureMirrorInbox: vi.fn(), isTransientIngestError: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/mirrorScanError', () => ({ markMirrorScanError: h.markError }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));

import { log } from '@/lib/logger';
import { readCursor } from '@/modules/accounting/services/capture/mirrorCursor';
import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const imapConn = (scanCursor: unknown): MirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor: scanCursor as Record<string, number>,
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u',
  imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});
const sentConn = (scanCursor: unknown): SentMirrorConnection => ({
  id: 's1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', sentFolder: 'Sent', scanCursor: scanCursor as Record<string, number>,
  imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});

beforeEach(() => {
  h.ranges.length = 0;
  h.statements.length = 0;
  h.uidNext = 0;
  h.markError.mockClear();
  vi.mocked(log.warn).mockClear();
});

const BAD = [['2^32, one past an IMAP number', 2 ** 32], ['the largest safe integer', Number.MAX_SAFE_INTEGER], ['a fraction', 1.5], ['negative', -1], ['a string', 'x'], ['past the safe integers', 1e20], ['a numeric string', '5'], ['zero', 0], ['NaN', NaN], ['an object', { n: 1 }], ['an array', [3]], ['true', true]] as const;

const readCursorUid = (...a: Parameters<typeof readCursor>) => readCursor(...a).uid;

describe('readCursor', () => {
  const ref = { id: 'c1', kind: 'imap-mirror' } as const;

  it('uses a positive safe integer as it is', () => {
    expect(readCursorUid({ INBOX: 41 }, 'INBOX', ref)).toBe(41);
    expect(readCursorUid({ INBOX: 0xfffffffe }, 'INBOX', ref)).toBe(0xfffffffe);
    expect(readCursorUid({ INBOX: 0xffffffff }, 'INBOX', ref)).toBe(0xffffffff);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('with the mailbox UIDNEXT known, a cursor below it is used, up to UIDNEXT - 1', () => {
    expect(readCursorUid({ INBOX: 41 }, 'INBOX', ref, 100)).toBe(41);
    expect(readCursorUid({ INBOX: 99 }, 'INBOX', ref, 100)).toBe(99);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([['equal to UIDNEXT', 100], ['past UIDNEXT', 101], ['far past UIDNEXT', 0xfffffffe]])('a cursor %s is clamped to UIDNEXT - 1 and flagged to be stored, with a warning', (_what, cursor) => {
    expect(readCursor({ INBOX: cursor }, 'INBOX', ref, 100)).toEqual({ uid: 99, clamped: true });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toMatchObject({ connectionId: 'c1', folder: 'INBOX', uidNext: 100 });
  });

  it('a mailbox with UIDNEXT 1 (empty) writes nothing and logs nothing: no clamp, no warning on every tick', () => {
    expect(readCursor({ INBOX: 7 }, 'INBOX', ref, 1)).toEqual({ uid: 0, clamped: false });
    expect(readCursor({ INBOX: 1 }, 'INBOX', ref, 1)).toEqual({ uid: 0, clamped: false });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a cursor that is used as it is, or is invalid, is not flagged to be stored', () => {
    expect(readCursor({ INBOX: 41 }, 'INBOX', ref, 100).clamped).toBe(false);
    expect(readCursor({ INBOX: 1.5 }, 'INBOX', ref, 100).clamped).toBe(false);
    expect(readCursor({}, 'INBOX', ref, 100).clamped).toBe(false);
  });

  it('UIDNEXT unknown (0) leaves a cursor to the 2^32 bound alone', () => {
    expect(readCursorUid({ INBOX: 5000 }, 'INBOX', ref, 0)).toBe(5000);
  });

  it('a folder with no cursor, or no cursor object at all, is a first scan and not worth a warning', () => {
    expect(readCursorUid({}, 'INBOX', ref)).toBe(0);
    expect(readCursorUid({ Other: 4 }, 'INBOX', ref)).toBe(0);
    expect(readCursorUid(null, 'INBOX', ref)).toBe(0);
    expect(readCursorUid(undefined, 'INBOX', ref)).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(BAD)('%s is ignored, with a warning that names the connection and folder but not the value', (_what, value) => {
    expect(readCursorUid({ INBOX: value }, 'INBOX', ref)).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toMatchObject({ connectionId: 'c1', folder: 'INBOX' });
  });

  it.each([['a string', '{"INBOX":4}'], ['an array', [4]], ['a number', 4]])('a scan_cursor that is %s is ignored with a warning', (_what, value) => {
    expect(readCursorUid(value, 'INBOX', ref)).toBe(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ['capture mirror', (c: unknown) => scanConnection(imapConn(c)), 'INBOX', 'imap-mirror'],
  ['sent mirror', (c: unknown) => scanSentConnection(sentConn(c)), 'Sent', 'sent-mirror'],
] as const)('%s scans', (name, scan, folder, scope) => {
  const afterClamp = name === 'sent mirror' ? [] : ['100:*'];

  it('on from a good cursor', async () => {
    await scan({ [folder]: 41 });
    expect(h.ranges).toEqual(['42:*']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('from the start when the folder has no cursor', async () => {
    await scan({});
    expect(h.ranges).toEqual(['1:*']);
  });

  it.each(BAD)('from the start, not from a forged cursor that is %s, and the connection is not marked failed', async (_what, value) => {
    await scan({ [folder]: value });
    expect(h.ranges).toEqual(['1:*']);
    expect(h.markError).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn).mock.calls.some((c) => c[2] === scope && /scan_cursor/.test(String(c[0])))).toBe(true);
  });

  it.each([['2^32 - 2, a valid number but not one this mailbox has', 0xfffffffe], ['UIDNEXT itself', 100], ['past UIDNEXT', 5000]])(
    'with UIDNEXT 100 from the mailbox, a cursor of %s is clamped to 99: nothing old is rescanned, not marked failed', async (_what, cursor) => {
      h.uidNext = 100;
      await scan({ [folder]: cursor });
      expect(h.ranges).toEqual(afterClamp); // nothing past 99 exists: the sent mirror does not even ask
      expect(h.markError).not.toHaveBeenCalled();
      expect(vi.mocked(log.warn).mock.calls.some((c) => c[2] === scope && /UIDNEXT/.test(String(c[0])))).toBe(true);
    });

  it('the clamped cursor is written back (else the forged one holds the folder silent until UIDNEXT overtakes it)', async () => {
    h.uidNext = 100;
    await scan({ [folder]: 5000 });
    const write = h.statements.find((s) => /scan_cursor =/.test(s.q));
    expect(write).toBeDefined();
    expect(JSON.parse(String(write!.v[0]))).toEqual({ [folder]: 99 });
  });

  it('an empty mailbox (UIDNEXT 1) with a stored cursor writes no cursor and logs nothing, every tick: only the success stamp', async () => {
    h.uidNext = 1;
    for (let tick = 0; tick < 2; tick += 1) await scan({ [folder]: 7 });
    expect(h.statements.filter((s) => /scan_cursor =/.test(s.q))).toEqual([]);
    expect(h.statements.filter((s) => /SET last_scan_at = NOW\(\), last_success_at = NOW\(\)/.test(s.q))).toHaveLength(2);
    expect(log.warn).not.toHaveBeenCalled();
    expect(h.markError).not.toHaveBeenCalled();
  });

  it('with UIDNEXT 100, a cursor of 99 (the newest message already seen) is a good cursor', async () => {
    h.uidNext = 100;
    await scan({ [folder]: 98 });
    expect(h.ranges).toEqual(['99:*']);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('only the folder it scans is judged: a forged value for another folder is left alone', async () => {
    await scan({ [folder]: 7, Elsewhere: 1.5 });
    expect(h.ranges).toEqual(['8:*']);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
