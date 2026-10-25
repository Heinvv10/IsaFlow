/**
 * S-07e part B (migration 946): no app role may write a connection row, so every
 * stamp a sent-mirror scan writes to it runs on migration_admin (routeAdminQuery),
 * and since that role bypasses RLS it names the company as well as the row (id AND
 * company_id). None reaches the app pool. The mailbox, the parser, storage and the
 * pools are fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sql: [] as Array<{ text: string; values: unknown[]; pool: 'app' | 'route' }>,
  uids: [] as number[],
  uidNext: 0,
  attachments: [] as Array<{ contentType: string; size: number; content: Buffer; filename: string }>,
  existing: false,
}));

vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidNext: h.uidNext };
    streamer = { write: () => true, push: () => true }; // what the scan's byte meter wraps
    on() { /* the mirror registers an 'error' listener */ }
    async connect() { /* fake mailbox */ }
    async logout() { /* fake mailbox */ }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() { for (const uid of h.uids) yield { uid, size: 100, envelope: { to: [{ address: 'c@cust.test' }], subject: `Invoice ${uid}` } }; }
    async fetchOne(uid: string) { return { uid: Number(uid), source: Buffer.from(`msg ${uid}`) }; }
  },
}));
vi.mock('mailparser', () => ({ simpleParser: async () => ({ subject: 's', to: { text: 'c@cust.test' }, attachments: h.attachments }) }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/documentStorage', () => ({ sha256: () => 'sha', storeCapturedBytes: async () => ({ bucket: 'b', path: 'p' }) }));
vi.mock('@/lib/auth/migrationAdminPool', () => ({ migrationAdminTx: async () => undefined }));
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string, values: unknown[]) => {
    h.sql.push({ text: text.replace(/\s+/g, ' ').trim(), values, pool: 'route' });
    return [];
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    h.sql.push({ text, values, pool: 'app' });
    if (text.startsWith('SELECT cd.id AS document_id')) return h.existing ? [{ document_id: 'd0', invoice_id: 'i0', document_type: 'x' }] : [];
    return /RETURNING id/.test(text) ? [{ id: crypto.randomUUID() }] : [];
  });
  // The scan's bookkeeping writes run in a short transaction (bounded lock wait); here it is the same recorder.
  return { sql, withTransaction: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) };
});

import { scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';

const conn: SentMirrorConnection = {
  id: 's1', companyId: '11111111-1111-4111-8111-111111111111', provider: 'imap', accountEmail: 'ap@co.test', sentFolder: 'Sent',
  scanCursor: { Sent: 10 }, imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc',
  oauthRefreshTokenEnc: null,
};
const pdf = { contentType: 'application/pdf', size: 3, content: Buffer.from('pdf'), filename: 'i.pdf' };
const stamps = () => h.sql.filter((q) => q.text.startsWith('UPDATE sent_mirror_connections'));
const keyed = (q: { text: string; values: unknown[]; pool: string }) => q.pool === 'route'
  && /WHERE id = \$(\d)::uuid AND company_id = \$(\d)::uuid$/.test(q.text) && q.values.slice(-2).join() === `${conn.id},${conn.companyId}`;
const onAppPool = () => h.sql.filter((q) => q.pool === 'app' && /sent_mirror_connections/.test(q.text));

beforeEach(() => {
  h.sql.length = 0;
  h.uids = [11, 12];
  h.uidNext = 0;
  h.attachments = [pdf];
  h.existing = false;
});

describe('sent-mirror scan stamps are keyed on id AND company_id', () => {
  it('a scan that captures: the cursor stamp and the counters', async () => {
    const r = await scanSentConnection(conn);
    expect([r.captured, r.errors]).toEqual([2, 0]);
    expect(stamps()).toHaveLength(2);
    expect(stamps()[0]!.text).toContain('SET scan_cursor = $1::jsonb');
    expect(stamps()[1]!.text).toContain('messages_captured_total = messages_captured_total + $1');
    expect(stamps().every(keyed)).toBe(true);
    expect(onAppPool()).toEqual([]);
  });

  it('a scan that only links existing documents bumps the linked counter', async () => {
    h.existing = true;
    const r = await scanSentConnection(conn);
    expect([r.linked, r.captured]).toEqual([2, 0]);
    expect(stamps().at(-1)!.text).toContain('messages_linked_total');
    expect(stamps().every(keyed)).toBe(true);
    expect(onAppPool()).toEqual([]);
  });

  it('a mailbox with nothing past the cursor: the early last_scan_at bump', async () => {
    h.uidNext = 11;
    await scanSentConnection(conn);
    expect(stamps()).toHaveLength(1);
    expect(stamps()[0]!.text).toContain('last_scan_at = NOW(), last_success_at = NOW()');
    expect(stamps().every(keyed)).toBe(true);
    expect(onAppPool()).toEqual([]);
  });

  it('a scan that finds no new message: the last_scan_at bump', async () => {
    h.uids = [];
    await scanSentConnection(conn);
    expect(stamps()).toHaveLength(1);
    expect(stamps().every(keyed)).toBe(true);
    expect(onAppPool()).toEqual([]);
  });
});
