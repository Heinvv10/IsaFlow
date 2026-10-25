/**
 * S-07e part B, review round 6: a scan the deadline abandoned stops at the top of each
 * attachment of the message it is on (guard.check()), not only between messages: a message with
 * many attachments no longer keeps ingesting after the tick moved on. Both mirrors. The first
 * attachment's storage write outlasts the deadline; the second must then never be stored, the
 * abandoned scan must log no scan-log entry (the stop is not an ingest failure), and the stamp
 * is the deadline owner's alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ stored: 0, statements: [] as string[], stamps: [] as string[] }));
const SLOW_MS = 120;
const DEADLINE_MS = 30;

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidNext: 0 };
    streamer = { write: () => true, push: () => true };
    on() { /* the mirror registers an 'error' listener */ }
    close() { /* the guard closes a stopped client */ }
    async connect() { /* fake mailbox */ }
    async logout() { /* fake mailbox */ }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() { yield { uid: 11, size: 100, envelope: { from: [{ address: 'ap@supplier.test' }], to: [{ address: 'c@cust.test' }], subject: 'Invoice 11' } }; }
    async fetchOne(uid: string) { return { uid: Number(uid), source: Buffer.from('msg') }; }
  },
}));
vi.mock('mailparser', () => ({
  simpleParser: async () => ({
    subject: 'Invoice', from: { text: 'ap@supplier.test' }, to: { text: 'c@cust.test' },
    attachments: [1, 2].map((n) => ({ contentType: 'application/pdf', size: 3, content: Buffer.from(`pdf${n}`), filename: `i${n}.pdf` })),
  }),
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/lib/documentStorage', () => ({
  sha256: (b: Buffer) => b.toString(),
  storeCapturedBytes: async () => { h.stored += 1; await new Promise((resolve) => setTimeout(resolve, SLOW_MS)); return { bucket: 'b', path: 'p' }; },
}));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', () => ({
  ensureMirrorInbox: vi.fn(async () => 'inbox-1'), isTransientIngestError: vi.fn(() => false),
}));
vi.mock('@/lib/neon', () => {
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    h.statements.push(text);
    return /RETURNING id/.test(text) ? [{ id: crypto.randomUUID() }] : [];
  });
  return { sql, withTransaction: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) };
});
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string) => { h.stamps.push(text.replace(/\s+/g, ' ').trim()); return []; }),
}));

import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const imapConn = (): MirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor: { INBOX: 10 },
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u',
  imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});
const sentConn = (): SentMirrorConnection => ({
  id: 's1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', sentFolder: 'Sent', scanCursor: { Sent: 10 },
  imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});

beforeEach(() => {
  h.stored = 0;
  h.statements.length = 0;
  h.stamps.length = 0;
});

describe.each([
  ['capture mirror', () => scanConnection(imapConn(), { deadlineMs: DEADLINE_MS }), 'imap_mirror'],
  ['sent mirror', () => scanSentConnection(sentConn(), { deadlineMs: DEADLINE_MS }), 'sent_mirror'],
] as const)('%s: an abandoned scan between two attachments of one message', (_name, scan, prefix) => {
  it('stores the first attachment (already in flight) and not the second, logs no entry, advances no cursor', async () => {
    const result = await scan();
    expect(result.errors).toBe(1); // the deadline's own count
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS * 2)); // the abandoned scan unwinds

    expect(h.stored).toBe(1);
    expect(h.statements.filter((t) => new RegExp(`INSERT INTO ${prefix}_scan_log`).test(t))).toEqual([]);
    expect(h.stamps).toHaveLength(1); // the deadline owner's "Scan timed out" stamp, nothing from the scan
    expect(h.stamps[0]).toMatch(/SET last_scan_at = NOW\(\), last_error = \$1/);
    expect(h.stamps.some((t) => /scan_cursor/.test(t))).toBe(false);
  });
});
