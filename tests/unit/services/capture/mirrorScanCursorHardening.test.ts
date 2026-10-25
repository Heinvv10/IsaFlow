/**
 * S-07e part B, review round 2: `scan_cursor` is a column the app pool may
 * write, so a forged claim can put anything in it. A cursor went straight into
 * `FETCH <cursor + 1>:*`; 1.5 or 1e20 makes the server answer BAD, the scan
 * throws, and the connection flips to 'error' (the victim's). A folder's cursor
 * is now used only when it is a positive safe integer; otherwise it is logged
 * and the folder is scanned as if it had none. Both mirror services, with the
 * mailbox recording the range it was asked for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ ranges: [] as string[], markError: vi.fn() }));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidNext: 0 };
    async connect() { /* fake mailbox */ }
    async logout() { /* fake mailbox */ }
    async getMailboxLock() { return { release: () => undefined }; }
    // eslint-disable-next-line require-yield
    async *fetch(range: string) { h.ranges.push(range); }
  },
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/documentStorage', () => ({ sha256: vi.fn(), storeCapturedBytes: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', () => ({ ensureMirrorInbox: vi.fn(), isTransientIngestError: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/mirrorScanError', () => ({ markMirrorScanError: h.markError }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));

import { log } from '@/lib/logger';
import { readCursorUid } from '@/modules/accounting/services/capture/mirrorCursor';
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
  h.markError.mockClear();
  vi.mocked(log.warn).mockClear();
});

const BAD = [['a fraction', 1.5], ['negative', -1], ['a string', 'x'], ['past the safe integers', 1e20], ['a numeric string', '5'], ['zero', 0], ['NaN', NaN], ['an object', { n: 1 }], ['an array', [3]], ['true', true]] as const;

describe('readCursorUid', () => {
  const ref = { id: 'c1', kind: 'imap-mirror' } as const;

  it('uses a positive safe integer as it is', () => {
    expect(readCursorUid({ INBOX: 41 }, 'INBOX', ref)).toBe(41);
    expect(readCursorUid({ INBOX: Number.MAX_SAFE_INTEGER }, 'INBOX', ref)).toBe(Number.MAX_SAFE_INTEGER);
    expect(log.warn).not.toHaveBeenCalled();
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
] as const)('%s scans', (_name, scan, folder, scope) => {
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

  it('only the folder it scans is judged: a forged value for another folder is left alone', async () => {
    await scan({ [folder]: 7, Elsewhere: 1.5 });
    expect(h.ranges).toEqual(['8:*']);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
