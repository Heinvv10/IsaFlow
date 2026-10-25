/**
 * S-07e part B, review round 5 (breaker5 MEDIUM 1): the size cap trusted the server's
 * RFC822.SIZE, and the server is the tenant's own while the cron runs in the shared
 * production process. A server that said 200 bytes and sent 40 MB had the literal buffered,
 * parsed and stored (RSS +260 MB for one message); a missing size was fetched; a 40 MB
 * envelope subject was held for up to 50 messages and written to the scan log.
 *
 * Now (mirrorScanLimits.ts): the bytes are counted as they arrive; one response over
 * MAX_RESPONSE_BYTES (MAX_ENVELOPE_RESPONSE_BYTES while the envelopes are listed) closes the
 * client, the row is stamped and the tick moves on; a missing size is too large; a source over
 * the cap is not parsed; subjects are clipped to 500 characters before any write.
 *
 * The real ImapFlow runs against tests/helpers/fakeImapServer.ts, which streams a lying body
 * only as fast as the client reads it, so `sentBytes` shows where the client stopped. That byte
 * count is the memory proof; no RSS bound is asserted (process memory moves with GC and box load).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImapFlow } from 'imapflow';

const h = vi.hoisted(() => ({
  statements: [] as { q: string; v: unknown[]; pool: 'app' | 'route' }[], rows: [] as Record<string, unknown>[],
  addr: {} as Record<string, string>, nextId: 1,
}));
vi.mock('node:dns/promises', () => ({ lookup: async (host: string) => [{ address: h.addr[host] ?? '93.184.216.99', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  const tag = vi.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    h.statements.push({ q, v, pool: 'app' });
    return /RETURNING id/.test(q) ? [{ id: `00000000-0000-4000-8000-${String(h.nextId++).padStart(12, '0')}` }] : [];
  });
  return { sql: tag, withTransaction: async (fn: (t: typeof tag) => Promise<unknown>) => fn(tag) };
});
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string, v: unknown[]) => {
    const q = text.replace(/\s+/g, ' ').trim();
    h.statements.push({ q, v, pool: 'route' });
    return /^SELECT c\.\* FROM \w+_mirror_connections c/.test(q) ? h.rows : [];
  }),
}));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'pw' }));
vi.mock('@/lib/documentStorage', () => ({ sha256: (b: Buffer) => `sha-${b.length}`, storeCapturedBytes: vi.fn(async () => ({ bucket: 'b', path: 'p' })) }));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', () => ({
  ensureMirrorInbox: vi.fn(async () => '00000000-0000-4000-8000-0000000000aa'), isTransientIngestError: () => false,
}));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: (_n: string, fn: () => void) => fn() }));

import { scanAllDueConnections, scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanAllDueSentConnections, scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';
import { MESSAGE_TOO_LARGE } from '@/modules/accounting/services/capture/mirrorScanError';
import {
  ByteMeter, MAX_ENVELOPE_RESPONSE_BYTES, MAX_MIRROR_MESSAGE_BYTES, MAX_MIRROR_TEXT_CHARS, MAX_RESPONSE_BYTES,
} from '@/modules/accounting/services/capture/mirrorScanLimits';
import { fakeServer, installFakeImap, type FakeServer } from '../../../helpers/fakeImapServer';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const BAD = '93.184.216.1';
const GOOD = '93.184.216.2';
const MB = 1024 * 1024;
/** The lying body: three times the capture limit, as breaker5 sent it. */
const LIE = 40 * MB;
let fake: ReturnType<typeof installFakeImap>;

const row = (id: string, host: string) => ({
  id, company_id: COMPANY, provider: 'imap', account_email: 'ap@co.test', folder: 'INBOX', sent_folder: 'INBOX', scan_cursor: { INBOX: 5 },
  allowed_senders: [], denied_senders: [], imap_host: host, imap_port: 993, imap_use_tls: true, imap_username: 'u',
  imap_password_enc: 'enc', oauth_refresh_token_enc: null,
});
const imapConn = (): MirrorConnection => ({
  id: 'c1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor: { INBOX: 5 },
  allowedSenders: [], deniedSenders: [], imapHost: 'good.test', imapPort: 993, imapUseTls: true, imapUsername: 'u',
  imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});
const sentConn = (): SentMirrorConnection => ({
  id: 's1', companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', sentFolder: 'INBOX', scanCursor: { INBOX: 5 },
  imapHost: 'good.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});

const SERVICES = [
  ['capture mirror', () => scanAllDueConnections(), () => scanConnection(imapConn()), 'imap_mirror_connections', 'imap_mirror_scan_log'],
  ['sent mirror', () => scanAllDueSentConnections(), () => scanSentConnection(sentConn()), 'sent_mirror_connections', 'sent_mirror_scan_log'],
] as const;

beforeEach(() => {
  h.statements.length = 0; h.nextId = 1;
  h.addr = { 'bad.test': BAD, 'good.test': GOOD };
  h.rows = [row('bad-1', 'bad.test'), row('good-1', 'good.test')];
});
afterEach(() => fake?.close());

function serve(bad: Partial<FakeServer>, good: Partial<FakeServer> = { uidNext: 6, messages: [{ uid: 5 }] }) {
  const servers = { bad: fakeServer(bad), good: fakeServer(good) };
  fake = installFakeImap({ [BAD]: servers.bad, [GOOD]: servers.good });
  return servers;
}

const stopStamps = (table: string) => h.statements.filter((s) => s.pool === 'route'
  && new RegExp(`^UPDATE ${table} SET last_scan_at = NOW\\(\\), last_error = \\$1 WHERE`).test(s.q)).map((s) => s.v);
const bodyFetches = (server: FakeServer) => server.commands.filter((c) => /UID FETCH \d+ \(UID BODY/.test(c)).map((c) => Number(c.split(' ')[3]));
const docsInserted = () => h.statements.filter((s) => /^INSERT INTO captured_documents/.test(s.q));

describe('the limits', () => {
  it('a response may carry a message at the cap with room to spare, and an envelope far less', () => {
    expect(MAX_RESPONSE_BYTES).toBe(Math.ceil(MAX_MIRROR_MESSAGE_BYTES * 1.5));
    expect(MAX_ENVELOPE_RESPONSE_BYTES).toBeLessThan(MAX_MIRROR_MESSAGE_BYTES / 10);
    expect(LIE).toBeGreaterThan(MAX_RESPONSE_BYTES * 1.5);
  });

  it('a client without the parser stream it meters is refused, rather than scanned unbounded', () => {
    expect(() => new ByteMeter({} as ImapFlow, () => undefined)).toThrow(/cannot be size-limited/);
  });
});

describe.each(SERVICES)('%s', (_name, tick, scanOne, table, logTable) => {
  it('a server that reports 200 bytes and sends 40 MB: the client is closed near the limit, the row is stamped, the next connection is scanned', async () => {
    const servers = serve({ uidNext: 7, messages: [{ uid: 6, size: 200, bodyBytes: LIE }] });
    const results = await tick();

    expect(servers.bad.sentBytes).toBeLessThan(MAX_RESPONSE_BYTES + 4 * MB);
    expect(fake.sockets[0]!.destroyed).toBe(true); // the first connection scanned is the lying one
    expect(results.map((r) => r.connectionId)).toEqual(['bad-1', 'good-1']);
    expect(results[0]!.errors).toBe(1);
    expect(results[1]!.errors).toBe(0);
    expect(stopStamps(table)).toEqual([[MESSAGE_TOO_LARGE, 'bad-1', COMPANY]]);
    expect(servers.good.commands.some((c) => /SELECT INBOX/.test(c))).toBe(true);
    expect(docsInserted()).toEqual([]);
  }, 60000);

  it('an envelope whose subject is a 40 MB literal: the client is closed past 1 MB, during the listing', async () => {
    const servers = serve({ uidNext: 7, messages: [{ uid: 6, subjectBytes: LIE }] });
    const results = await tick();
    expect(servers.bad.sentBytes).toBeLessThan(MAX_ENVELOPE_RESPONSE_BYTES + 4 * MB);
    expect(bodyFetches(servers.bad)).toEqual([]);
    expect(results[0]!.errors).toBe(1);
    expect(stopStamps(table)).toEqual([[MESSAGE_TOO_LARGE, 'bad-1', COMPANY]]);
    expect(h.statements.some((s) => s.q.startsWith(`INSERT INTO ${logTable}`) && s.v.includes('bad-1'))).toBe(false);
  }, 60000);

  it('a message with no RFC822.SIZE is too large: not fetched, logged skipped_too_large, passed', async () => {
    const servers = serve({}, { uidNext: 8, messages: [{ uid: 6, noSize: true, pdf: 'nosize' }, { uid: 7, pdf: 'sized' }] });
    const r = await scanOne();
    expect(bodyFetches(servers.good)).toEqual([7]);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(h.statements.some((s) => s.q.startsWith(`INSERT INTO ${logTable}`) && s.v.includes('6') && s.v.includes('skipped_too_large'))).toBe(true);
  });

  it('a source over the cap that stays under the response limit is not parsed: nothing captured, the scan goes on', async () => {
    const servers = serve({}, { uidNext: 8, messages: [{ uid: 6, size: 200, bodyBytes: MAX_MIRROR_MESSAGE_BYTES + 4096 }, { uid: 7, pdf: 'next' }] });
    const r = await scanOne();
    expect(bodyFetches(servers.good)).toEqual([6, 7]);
    expect(r.errors).toBe(0);
    expect(docsInserted().every((s) => !s.v.includes(MAX_MIRROR_MESSAGE_BYTES + 4096))).toBe(true);
    expect(stopStamps(table)).toEqual([]);
  }, 30000);

  it('a 2000-character subject is written clipped to 500, in the scan log and in what is captured', async () => {
    const subject = `Invoice ${'x'.repeat(2000)}`;
    serve({}, { uidNext: 7, messages: [{ uid: 6, subject, pdf: 'long' }] });
    await scanOne();
    const logged = h.statements.find((s) => s.q.startsWith(`INSERT INTO ${logTable}`))!;
    expect(logged.v).toContain(subject.slice(0, MAX_MIRROR_TEXT_CHARS));
    expect(logged.v).not.toContain(subject);
    const written = h.statements.filter((s) => s.pool === 'app').flatMap((s) => s.v).filter((v): v is string => typeof v === 'string');
    expect(written.some((v) => v.includes('x'.repeat(MAX_MIRROR_TEXT_CHARS - 8)))).toBe(true);
    expect(written.every((v) => !v.includes('x'.repeat(MAX_MIRROR_TEXT_CHARS)))).toBe(true);
  });
});
