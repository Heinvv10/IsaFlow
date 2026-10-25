/**
 * S-07e part B, review round 3: an INSERT into a scan log takes a key-share lock
 * on its connection row through the foreign key, which another session's
 * FOR UPDATE blocks. The cron scans its connections one after another, so the
 * scan-log write waits at most 2 s for the row outside a request (a short
 * transaction with a transaction-local lock_timeout). Round 5: the writes to the
 * connection row itself (cursor, success stamp, counters) run on migration_admin
 * (routeAdminQuery, whose own transaction waits 2 s: routeAdminPool.test.ts), in
 * a request too, and never on the app pool. A write that gives up (55P03) makes
 * the scan skip the connection for this tick: warned, not marked failed, cursor
 * not advanced. Inside a request (scan-now) the scan-log write is the request's
 * own and its failure is handled as before. Both mirror services; mailbox,
 * parser, storage and the pools are fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/lib/als';

const h = vi.hoisted(() => ({
  uids: [] as number[],
  uidNext: 0,
  /** Statement text that raises 55P03 when it runs. */
  failOn: null as RegExp | null,
  /** The SQLSTATE it raises. */
  failCode: '55P03',
  direct: [] as string[],
  txs: [] as Array<{ statements: Array<{ text: string; values: unknown[] }> }>,
  /** Statements sent through routeAdminQuery (migration_admin). */
  route: [] as string[],
  markError: vi.fn(),
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidNext: h.uidNext };
    streamer = { write: () => true, push: () => true }; // what the scan's byte meter wraps
    on() { /* the mirror registers an 'error' listener */ }
    async connect() { /* fake mailbox */ }
    async logout() { /* fake mailbox */ }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() {
      for (const uid of h.uids) yield { uid, size: 100, envelope: { from: [{ address: 'ap@supplier.test' }], to: [{ address: 'c@cust.test' }], subject: `Invoice ${uid}` } };
    }
    async fetchOne(uid: string) { return { uid: Number(uid), source: Buffer.from(`msg ${uid}`) }; }
  },
}));
vi.mock('mailparser', () => ({
  simpleParser: async () => ({
    subject: 's', from: { text: 'ap@supplier.test' }, to: { text: 'c@cust.test' },
    attachments: [{ contentType: 'application/pdf', size: 3, content: Buffer.from('pdf'), filename: 'i.pdf' }],
  }),
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/documentStorage', () => ({ sha256: () => 'sha', storeCapturedBytes: async () => ({ bucket: 'b', path: 'p' }) }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', () => ({
  ensureMirrorInbox: vi.fn(async () => 'inbox-1'), isTransientIngestError: vi.fn(() => false),
}));
vi.mock('@/modules/accounting/services/capture/mirrorScanError', () => ({ markMirrorScanError: h.markError }));
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string) => {
    const t = text.replace(/\s+/g, ' ').trim();
    h.route.push(t);
    if (h.failOn?.test(t)) throw Object.assign(new Error('statement failed'), { code: h.failCode });
    return [];
  }),
}));
vi.mock('@/lib/neon', () => {
  const failure = () => Object.assign(new Error('statement failed'), { code: h.failCode });
  const run = (record: (text: string, values: unknown[]) => void) => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    record(text, values);
    if (h.failOn?.test(text)) throw failure();
    return /RETURNING id/.test(text) ? [{ id: crypto.randomUUID() }] : [];
  };
  return {
    sql: run((text) => h.direct.push(text)),
    withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = { statements: [] as Array<{ text: string; values: unknown[] }> };
      h.txs.push(tx);
      return fn(run((text, values) => tx.statements.push({ text, values })));
    },
  };
});

import { als } from '@/lib/als';
import { log } from '@/lib/logger';
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
const requestCtx = (): RequestContext => ({ client: {} as RequestContext['client'], userId: 'u1', claims: {}, afterCommit: [] });

/** [service, scan, connection table, the writes that can lock: [what, mailbox UIDs, UIDNEXT, statement]] */
const SERVICES = [
  ['capture mirror', () => scanConnection(imapConn()), 'imap_mirror_connections', 'imap-mirror', [
    ['the scan log insert', [11], 0, /INSERT INTO imap_mirror_scan_log/],
    ['the cursor stamp', [11], 0, /UPDATE imap_mirror_connections SET scan_cursor/],
    ['the ingested counter', [11], 0, /messages_ingested_total = messages_ingested_total \+/],
    ['the success stamp of a scan that found nothing', [], 0, /SET last_scan_at = NOW\(\), last_success_at = NOW\(\)/],
  ]],
  ['sent mirror', () => scanSentConnection(sentConn()), 'sent_mirror_connections', 'sent-mirror', [
    ['the scan log insert', [11], 0, /INSERT INTO sent_mirror_scan_log/],
    ['the cursor stamp', [11], 0, /UPDATE sent_mirror_connections SET scan_cursor/],
    ['the capture counters', [11], 0, /messages_captured_total = messages_captured_total \+/],
    ['the success stamp of a scan that found nothing', [], 0, /SET last_scan_at = NOW\(\), last_success_at = NOW\(\)/],
    ['the early exit stamp (nothing past the cursor)', [], 11, /SET last_scan_at = NOW\(\), last_success_at = NOW\(\)/],
  ]],
] as const;

beforeEach(() => {
  h.uids = [];
  h.uidNext = 0;
  h.failOn = null;
  h.failCode = '55P03';
  h.direct.length = 0;
  h.txs.length = 0;
  h.route.length = 0;
  h.markError.mockClear();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

describe.each(SERVICES)('%s, outside a request (the cron)', (_name, scan, table, scope, writes) => {
  it('the scan log write is a transaction that waits 2 s for the row at most; the connection row is written on migration_admin only', async () => {
    h.uids = [11];
    await scan();
    const logs = h.txs.filter((t) => t.statements.some((s) => /_scan_log/.test(s.text)));
    expect(logs.length).toBeGreaterThanOrEqual(1);
    for (const t of logs) {
      expect(t.statements[0]!.text).toContain("set_config('lock_timeout', ?, true)"); // transaction-local, set first
      expect(t.statements[0]!.values).toEqual(['2s']);
    }
    // The cursor stamp and the counter: migration_admin, never the app pool (no app role may write the table).
    expect(h.route.filter((t) => t.startsWith(`UPDATE ${table}`)).length).toBeGreaterThanOrEqual(2);
    const onApp = [...h.direct, ...h.txs.flatMap((t) => t.statements.map((x) => x.text))].filter((t) => t.includes(table));
    expect(onApp).toEqual([]);
    // No scan-log write ran on the pool directly, where the wait is unbounded.
    expect(h.direct.filter((t) => /_scan_log/.test(t) && /^INSERT/.test(t))).toEqual([]);
  });

  it.each(writes)('%s gives up on a locked row: the scan skips the connection, warns, and does not mark it failed', async (_what, uids, uidNext, statement) => {
    h.uids = [...uids];
    h.uidNext = uidNext;
    h.failOn = statement;
    const r = await scan();
    expect(r.errors).toBe(0);
    expect(h.markError).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn).mock.calls.filter((c) => c[2] === scope && /skipped this tick/.test(String(c[0])))).toHaveLength(1);
    expect(vi.mocked(log.warn).mock.calls.some((c) => /ingest failed/.test(String(c[0])))).toBe(false);
  });

  it('a locked scan-log insert stops the scan before its cursor moves', async () => {
    h.uids = [11, 12];
    h.failOn = /_scan_log/;
    await scan();
    const attempted = h.txs.flatMap((t) => t.statements.map((s) => s.text));
    expect(h.route.some((t) => /SET scan_cursor/.test(t))).toBe(false);
    expect(attempted.filter((t) => /INSERT INTO \w+_scan_log/.test(t))).toHaveLength(1); // 12 was never looked at
  });

  it('a write that fails for another reason is still a failed scan', async () => {
    h.uids = [11];
    h.failOn = /_scan_log/;
    h.failCode = '08006';
    await scan();
    expect(h.markError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn).mock.calls.some((c) => c[2] === scope && /skipped this tick/.test(String(c[0])))).toBe(false);
  });
});

describe.each(SERVICES)('%s, inside a request (scan-now)', (_name, scan, table, scope) => {
  it('logs on the request\'s own transaction (no transaction of its own, no lock_timeout change); stamps on migration_admin', async () => {
    h.uids = [11];
    await als.run(requestCtx(), () => scan());
    expect(h.txs).toEqual([]);
    expect(h.direct.some((t) => /set_config/.test(t))).toBe(false);
    expect(h.direct.some((t) => /_scan_log/.test(t))).toBe(true);
    expect(h.direct.some((t) => t.includes(table))).toBe(false);
    expect(h.route.some((t) => t.startsWith(`UPDATE ${table} SET scan_cursor`))).toBe(true);
  });

  it('a stamp that waits out its 2 s there is a skip too (its transaction is its own, not the request\'s)', async () => {
    h.uids = [11];
    h.failOn = new RegExp(`UPDATE ${table} SET scan_cursor`);
    const r = await als.run(requestCtx(), () => scan());
    expect(r.errors).toBe(0);
    expect(h.markError).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn).mock.calls.filter((c) => c[2] === scope && /skipped this tick/.test(String(c[0])))).toHaveLength(1);
  });

  it('a 55P03 there is the scan\'s failure as before, not a skip', async () => {
    h.uids = [11];
    h.failOn = /_scan_log/;
    const r = await als.run(requestCtx(), () => scan());
    expect(r.errors).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(log.warn).mock.calls.some((c) => c[2] === scope && /skipped this tick/.test(String(c[0])))).toBe(false);
  });
});
