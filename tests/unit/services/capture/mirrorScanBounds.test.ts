/**
 * S-07e part B, review round 4, against the real ImapFlow and a scripted server
 * (tests/helpers/fakeImapServer.ts): what a scan will fetch, ingest and store as its cursor.
 *
 * - A message whose RFC822.SIZE is over the cap is never fetched (its source literal can be
 *   a gigabyte, held in memory and copied by the parser); it is skipped, logged, and passed.
 * - A UID outside 1..2^32-1 is never ingested and never written as the cursor (the next scan
 *   would reject it and rescan from UID 1, every tick).
 * - The capture mirror ingests a file the tenant already holds only once: a re-scan after a
 *   lock skip, a cursor reset or a re-sent invoice captures nothing twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ statements: [] as { q: string; v: unknown[] }[], hashes: new Set<string>(), nextId: 1 }));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.7', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  const tag = vi.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    h.statements.push({ q, v });
    // captured_documents as a table of hashes: the dedupe lookup finds what an INSERT stored.
    if (/^INSERT INTO captured_documents/.test(q)) h.hashes.add(String(v.find((x) => typeof x === 'string' && x.startsWith('sha-'))));
    if (/^SELECT 1 FROM captured_documents/.test(q)) return h.hashes.has(String(v[1])) ? [{ '?column?': 1 }] : [];
    if (/RETURNING id/.test(q)) return [{ id: `00000000-0000-4000-8000-${String(h.nextId++).padStart(12, '0')}` }];
    return [];
  });
  return { sql: tag, withTransaction: async (fn: (t: typeof tag) => Promise<unknown>) => fn(tag) };
});
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'pw' }));
vi.mock('@/lib/documentStorage', () => ({ sha256: (b: Buffer) => `sha-${b.toString().trim()}`, storeCapturedBytes: vi.fn(async () => ({ bucket: 'b', path: 'p' })) }));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', () => ({ ensureMirrorInbox: vi.fn(async () => '00000000-0000-4000-8000-0000000000aa'), isTransientIngestError: () => false }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: (_n: string, fn: () => void) => fn() }));

import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';
import { MAX_MIRROR_MESSAGE_BYTES } from '@/modules/accounting/services/capture/mirrorScanGuard';
import { MAX_FILE_SIZE } from '@/modules/accounting/services/capture/captureLimits';
import { fakeServer, installFakeImap, type FakeServer } from '../../../helpers/fakeImapServer';

const COMPANY = '11111111-1111-4111-8111-111111111111';
let fake: ReturnType<typeof installFakeImap>;
let server: FakeServer;

const imapConn = (cursor = 5): MirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor: { INBOX: cursor },
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u',
  imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});
const sentConn = (cursor = 5): SentMirrorConnection => ({
  id: 's1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', sentFolder: 'INBOX', scanCursor: { INBOX: cursor },
  imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});

const SERVICES = [
  ['capture mirror', (c = 5) => scanConnection(imapConn(c)), 'imap_mirror_scan_log', 'imap_mirror_connections'],
  ['sent mirror', (c = 5) => scanSentConnection(sentConn(c)), 'sent_mirror_scan_log', 'sent_mirror_connections'],
] as const;

const cursorWrites = () => h.statements.filter((s) => /SET scan_cursor =/.test(s.q)).map((s) => JSON.parse(String(s.v[0])) as Record<string, number>);
const logged = (table: string) => h.statements.filter((s) => new RegExp(`INSERT INTO ${table}`).test(s.q));
const bodyFetches = () => server.commands.filter((c) => /UID FETCH \d+ \(UID BODY/.test(c)).map((c) => Number(c.split(' ')[3]));

beforeEach(() => { h.statements.length = 0; h.hashes.clear(); h.nextId = 1; });
afterEach(() => fake?.close());

function serve(over: Partial<FakeServer>) {
  server = fakeServer(over);
  fake = installFakeImap({ '93.184.216.7': server });
}

describe('the message size cap', () => {
  it('is the capture pipeline\'s largest file as base64 plus headers: above it the pipeline could not read the attachment', () => {
    expect(MAX_MIRROR_MESSAGE_BYTES).toBeGreaterThan(MAX_FILE_SIZE);
    expect(MAX_MIRROR_MESSAGE_BYTES).toBeLessThan(MAX_FILE_SIZE * 1.5);
  });
});

describe.each(SERVICES)('%s', (_name, scan, logTable) => {
  it('never fetches the body of a message over the cap: skipped, logged, passed; the next message is read', async () => {
    serve({ uidNext: 8, messages: [{ uid: 6, size: MAX_MIRROR_MESSAGE_BYTES + 1, pdf: 'big' }, { uid: 7, pdf: 'small' }] });
    const r = await scan();
    expect(bodyFetches()).toEqual([7]);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(logged(logTable).some((s) => s.v.includes('6') && s.v.includes('skipped_too_large'))).toBe(true);
    expect(cursorWrites()).toEqual([{ INBOX: 7 }]);
  });

  it('a message exactly at the cap is fetched', async () => {
    serve({ uidNext: 7, messages: [{ uid: 6, size: MAX_MIRROR_MESSAGE_BYTES, pdf: 'edge' }] });
    await scan();
    expect(bodyFetches()).toEqual([6]);
  });

  it('a UID of 2^32 in the answer is not fetched, not ingested and never stored as the cursor', async () => {
    serve({ uidNext: 4294967297, messages: [{ uid: 6, pdf: 'six' }, { uid: 4294967296, pdf: 'huge' }] });
    await scan();
    expect(bodyFetches()).toEqual([6]);
    expect(cursorWrites()).toEqual([{ INBOX: 6 }]);
    expect(JSON.stringify(h.statements.map((s) => s.v))).not.toContain('4294967296');
  });
});

describe('capture mirror: the same file is ingested once', () => {
  const insertedDocs = () => h.statements.filter((s) => /^INSERT INTO captured_documents/.test(s.q)).length;
  const insertedEvents = () => h.statements.filter((s) => /^INSERT INTO capture_events/.test(s.q)).length;

  it('a second scan of the same mail (cursor reset, lock skip, forged cursor) captures nothing again, and says so in the log', async () => {
    serve({ uidNext: 7, messages: [{ uid: 6, pdf: 'inv-1' }] });
    const first = await scanConnection(imapConn(5));
    expect(first.ingested).toBe(1);
    expect(insertedDocs()).toBe(1);

    const again = await scanConnection(imapConn(5));
    expect(again.ingested).toBe(0);
    expect(again.skipped).toBe(1);
    expect(insertedDocs()).toBe(1);
    expect(insertedEvents()).toBe(1);
    const outcomes = h.statements.filter((s) => /INSERT INTO imap_mirror_scan_log/.test(s.q)).map((s) => s.v[6]);
    expect(outcomes).toEqual(['ingested', 'skipped_duplicate']);
    expect(cursorWrites()).toEqual([{ INBOX: 6 }, { INBOX: 6 }]); // the cursor still advances past a duplicate
  });

  it('the same invoice re-sent as a new message is not captured twice; a different file is', async () => {
    serve({ uidNext: 9, messages: [{ uid: 6, pdf: 'inv-1' }, { uid: 7, pdf: 'inv-1' }, { uid: 8, pdf: 'inv-2' }] });
    const r = await scanConnection(imapConn(5));
    expect(r.ingested).toBe(2);
    expect(insertedDocs()).toBe(2);
    expect(insertedEvents()).toBe(2);
  });

  it('looks the hash up under the connection\'s company', async () => {
    serve({ uidNext: 7, messages: [{ uid: 6, pdf: 'inv-1' }] });
    await scanConnection(imapConn(5));
    const lookup = h.statements.find((s) => /^SELECT 1 FROM captured_documents/.test(s.q))!;
    expect(lookup.q).toContain('cd.company_id = ?::uuid');
    expect(lookup.v).toEqual([COMPANY, 'sha-inv-1']);
  });
});
