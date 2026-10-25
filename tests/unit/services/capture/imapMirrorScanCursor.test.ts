/**
 * The IMAP mirror's cursor never passes a message whose ingest failed for want
 * of the database (S-07d review: during a deploy window, or a code-only
 * rollback, the old release's inbox upsert is refused 42501 and every scanned
 * invoice used to be skipped for good). The mailbox, the parser, storage and
 * both pools are fakes; the cursor written to imap_mirror_connections is read
 * back from the recorded statements.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sql: [] as Array<{ text: string; values: unknown[] }>,
  upsertFails: new Set<number>(),
  upserts: 0,
  failWith: null as unknown,
  docInsertFails: 0,
  docInserts: 0,
  stampFails: 0,
  stamps: 0,
  empty: false,
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    async connect() { /* fake mailbox */ }
    async logout() { /* fake mailbox */ }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() {
      for (const uid of h.empty ? [] : [11, 12, 13]) yield { uid, envelope: { from: [{ address: 'ap@supplier.test' }], subject: `Invoice ${uid}` } };
    }
    async fetchOne(uid: string) { return { uid: Number(uid), source: Buffer.from(`msg ${uid}`) }; }
  },
}));
vi.mock('mailparser', () => ({
  simpleParser: async (source: Buffer) => ({
    subject: source.toString(), from: { text: 'ap@supplier.test' },
    // Message 12 carries two attachments.
    attachments: Array.from({ length: source.toString() === 'msg 12' ? 2 : 1 },
      (_, i) => ({ contentType: 'application/pdf', size: 3, content: Buffer.from(`pdf${i}`), filename: `i${i}.pdf` })),
  }),
}));
// The scan resolves the host before it connects (imapTargetGuard): imap.test is a public address here.
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/documentStorage', () => ({
  sha256: () => 'sha', storeCapturedBytes: async () => ({ bucket: 'b', path: 'p' }),
}));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: async () => undefined }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: () => undefined }));
vi.mock('@/lib/neon', () => {
  const sql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    h.sql.push({ text, values });
    if (text.startsWith('INSERT INTO captured_documents') && ++h.docInserts === h.docInsertFails) {
      return Promise.reject(Object.assign(new Error('connection terminated'), { code: '08006' }));
    }
    if (text.startsWith('UPDATE captured_documents SET storage_bucket') && ++h.stamps === h.stampFails) {
      return Promise.reject(Object.assign(new Error('connection terminated'), { code: '08006' }));
    }
    return Promise.resolve(/RETURNING id/.test(text) ? [{ id: crypto.randomUUID() }] : []);
  });
  // The scan's bookkeeping writes run in a short transaction (bounded lock wait); here it is the same recorder.
  return { sql, withTransaction: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) };
});
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminTx: async (_label: string, fn: (c: unknown) => unknown) => {
    h.upserts += 1;
    if (h.upsertFails.has(h.upserts)) throw h.failWith;
    return fn({ query: async () => ({ rows: [{ id: crypto.randomUUID() }] }) });
  },
}));

import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';

const conn: MirrorConnection = {
  id: 'c1', companyId: '11111111-1111-4111-8111-111111111111', provider: 'imap', accountEmail: 'ap@co.test',
  folder: 'INBOX', scanCursor: { INBOX: 10 }, allowedSenders: [], deniedSenders: [],
  imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
};

/** The cursor the scan wrote, or null when it wrote none. */
function cursorWritten(): number | null {
  const w = h.sql.find((s) => s.text.startsWith('UPDATE imap_mirror_connections SET scan_cursor'));
  return w ? (JSON.parse(String(w.values[0])) as Record<string, number>).INBOX! : null;
}
const documentsCreated = () => h.sql.filter((s) => s.text.startsWith('INSERT INTO captured_documents')).length;

describe('IMAP mirror scan: the cursor and a failed ingest', () => {
  beforeEach(() => {
    h.sql.length = 0;
    h.upsertFails.clear();
    h.upserts = 0;
    h.docInsertFails = 0;
    h.docInserts = 0;
    h.stampFails = 0;
    h.stamps = 0;
    h.empty = false;
  });

  it('a clean scan advances the cursor to the last message', async () => {
    const r = await scanConnection(conn);
    expect([r.ingested, r.errors, cursorWritten()]).toEqual([4, 0, 13]);
    // A success clears an earlier stop's error.
    expect(h.sql.find((q) => q.text.startsWith('UPDATE imap_mirror_connections SET scan_cursor'))?.text).toContain('last_error = NULL');
    expect(h.sql.some((q) => /SET last_scan_at = NOW\(\), last_error = \?/.test(q.text))).toBe(false);
  });

  it.each([
    ['refused by privilege (old code, new schema)', Object.assign(new Error('permission denied for table capture_inboxes'), { code: '42501' })],
    ['a pool checkout timeout', new Error('timeout exceeded when trying to connect')],
  ])('%s: stops there, the cursor stays before it, and no document is left behind', async (_, err) => {
    h.failWith = err;
    h.upsertFails.add(2); // message 12
    const r = await scanConnection(conn);
    expect([r.ingested, r.errors, cursorWritten()]).toEqual([1, 1, 11]);
    expect(documentsCreated()).toBe(1); // message 11's only
  });

  it('a failure of the message itself is logged and passed, as before', async () => {
    h.failWith = Object.assign(new Error('duplicate key'), { code: '23505' });
    h.upsertFails.add(2);
    const r = await scanConnection(conn);
    expect([r.ingested, r.errors, cursorWritten()]).toEqual([2, 1, 13]);
  });

  it('the first message failing leaves the cursor where it was, shows the error and stamps no success', async () => {
    h.failWith = Object.assign(new Error('permission denied for table capture_inboxes'), { code: '42501' });
    h.upsertFails.add(1); // message 11, the first of the batch
    const r = await scanConnection(conn);
    expect([r.ingested, r.errors, cursorWritten()]).toEqual([0, 1, null]);
    expect(h.sql.some((q) => /last_success_at = NOW\(\)/.test(q.text))).toBe(false);
    const stamped = h.sql.find((q) => q.text.startsWith('UPDATE imap_mirror_connections SET last_scan_at = NOW(), last_error'));
    expect(stamped?.values[0]).toBe('permission denied for table capture_inboxes');
    expect(h.sql.some((q) => /status = CASE/.test(q.text))).toBe(false); // stays active: the next scan retries
  });

  it('a failure inside the first attachment, after its document row, is retried; that row is left pending (runbook)', async () => {
    h.stampFails = 2; // message 12's first attachment: its storage stamp
    const r = await scanConnection(conn);
    expect([r.errors, cursorWritten()]).toEqual([1, 11]);
    expect(documentsCreated()).toBe(2); // 11's, and 12's first, left without an event
    // Progress (message 11) is recorded, and so is the stop's error after it.
    const writes = h.sql.filter((q) => q.text.startsWith('UPDATE imap_mirror_connections')).map((q) => q.text);
    expect(writes.findIndex((t) => t.includes('scan_cursor'))).toBeLessThan(writes.findIndex((t) => /last_error = \?/.test(t)));
  });

  it('a database failure after part of a message was ingested is passed, so nothing is captured twice', async () => {
    h.docInsertFails = 3; // message 12's second attachment (11's one, then 12's first)
    const r = await scanConnection(conn);
    expect([r.errors, cursorWritten()]).toEqual([1, 13]);
    expect(documentsCreated()).toBe(4); // 11, 12a, 12b (refused), 13: none retried
  });

  // S-07e part B: the role that stamps is the app pool's, so every stamp names the company as well as the row.
  describe('every stamp on the connection row is keyed on id AND company_id', () => {
    const stamps = () => h.sql.filter((q) => q.text.startsWith('UPDATE imap_mirror_connections'));
    const keyed = (q: { text: string; values: unknown[] }) =>
      q.text.includes('WHERE id = ?::uuid AND company_id = ?::uuid') && q.values.slice(-2).join() === `${conn.id},${conn.companyId}`;

    it('a scan that ingests: the cursor stamp and the counter', async () => {
      await scanConnection(conn);
      expect(stamps()).toHaveLength(2);
      expect(stamps()[0]!.text).toContain('SET scan_cursor = ?');
      expect(stamps()[1]!.text).toContain('messages_ingested_total = messages_ingested_total + ?');
      expect(stamps().every(keyed)).toBe(true);
    });

    it('a scan with nothing new: the last_scan_at bump', async () => {
      h.empty = true;
      await scanConnection(conn);
      expect(stamps()).toHaveLength(1);
      expect(stamps()[0]!.text).toContain('last_success_at = NOW(), last_error = NULL');
      expect(stamps().every(keyed)).toBe(true);
    });

    it('a scan that stops on a transient failure: the error stamp', async () => {
      h.failWith = Object.assign(new Error('permission denied'), { code: '42501' });
      h.upsertFails.add(1);
      await scanConnection(conn);
      expect(stamps()).toHaveLength(1);
      expect(stamps()[0]!.text).toContain('last_error = ?');
      expect(stamps().every(keyed)).toBe(true);
    });
  });
});
