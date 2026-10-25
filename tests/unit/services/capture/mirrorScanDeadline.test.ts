/**
 * S-07e part B, review round 4: the mail server is the tenant's own, so a scan's duration is
 * the tenant's to choose, and the cron scans its connections one at a time. A server that
 * drips a line every 100 ms (never idle, so ImapFlow's socketTimeout never fires) or that
 * answers a fetch with a throttle BAD asking for 2^31-1 ms stalled the whole tick, for every
 * tenant, for days. Each scan now runs under a hard deadline: the client is closed, the row is
 * stamped (so it goes to the back of the queue; status stays active) and the tick moves on.
 *
 * The real ImapFlow runs against a scripted server (tests/helpers/fakeImapServer.ts); only the
 * deadline is shortened (the services take it as an option).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  statements: [] as { q: string; v: unknown[] }[], rows: [] as Record<string, unknown>[], markError: vi.fn(),
  addr: {} as Record<string, string>,
}));
vi.mock('node:dns/promises', () => ({ lookup: async (host: string) => [{ address: h.addr[host] ?? '93.184.216.99', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  const tag = vi.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    h.statements.push({ q, v });
    return /^SELECT \* FROM \w+_mirror_connections/.test(q) ? h.rows : [];
  });
  return { sql: tag, withTransaction: async (fn: (t: typeof tag) => Promise<unknown>) => fn(tag) };
});
// The due selection and the connection-row stamps run on migration_admin (S-07e part B): the same recorder.
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string, v: unknown[]) => {
    const q = text.replace(/\s+/g, ' ').trim();
    h.statements.push({ q, v });
    return /^SELECT \* FROM \w+_mirror_connections/.test(q) ? h.rows : [];
  }),
}));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'pw' }));
vi.mock('@/lib/documentStorage', () => ({ sha256: vi.fn(() => 'sha'), storeCapturedBytes: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/captureRouterService', () => ({ routeEvent: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/imapMirrorInbox', () => ({ ensureMirrorInbox: vi.fn(), isTransientIngestError: vi.fn() }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/mirrorScanError', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/capture/mirrorScanError')>()), markMirrorScanError: h.markError,
}));

import { log } from '@/lib/logger';
import { scanAllDueConnections } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanAllDueSentConnections } from '@/modules/accounting/services/ar/sentMirrorService';
import { MIRROR_SOCKET_TIMEOUT_MS, MIRROR_THROTTLE_CAP_MS } from '@/modules/accounting/services/capture/mirrorImapClient';
import { fakeServer, installFakeImap, type FakeServer } from '../../../helpers/fakeImapServer';

const DEADLINE = 400;
const MARGIN = 1500;
const LONG_DEADLINE = 20_000; // the scan must end by itself, on the capped backoff, well before it
const COMPANY = '11111111-1111-4111-8111-111111111111';
let fake: ReturnType<typeof installFakeImap>;

const row = (id: string, host: string, kind: 'imap' | 'sent') => ({
  id, company_id: COMPANY, provider: 'imap', account_email: 'ap@co.test', folder: 'INBOX', sent_folder: 'INBOX', scan_cursor: { INBOX: 5 },
  allowed_senders: [], denied_senders: [], imap_host: host, imap_port: 993, imap_use_tls: true, imap_username: 'u',
  imap_password_enc: 'enc', oauth_refresh_token_enc: null, kind,
});

const SERVICES = [
  ['capture mirror', 'imap', (o: { deadlineMs: number }) => scanAllDueConnections(o), 'imap_mirror_connections'],
  ['sent mirror', 'sent', (o: { deadlineMs: number }) => scanAllDueSentConnections(o), 'sent_mirror_connections'],
] as const;

beforeEach(() => {
  h.statements.length = 0; h.markError.mockClear(); vi.mocked(log.warn).mockClear();
  h.addr = { 'bad.test': '93.184.216.1', 'good.test': '93.184.216.2' };
});
afterEach(() => fake?.close());

function serve(bad: Partial<FakeServer>): { bad: FakeServer; good: FakeServer } {
  const servers = { bad: fakeServer(bad), good: fakeServer({ uidNext: 6, messages: [{ uid: 5 }] }) };
  fake = installFakeImap({ '93.184.216.1': servers.bad, '93.184.216.2': servers.good });
  return servers;
}

/** setTimeout with every sleep of a second or more (but the `keep` durations) recorded and compressed; `fireSleeps: false` leaves them pending (and unref'd). */
function recordSleeps(fireSleeps: boolean, keep: number[] = []): number[] {
  const sleeps: number[] = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...a: unknown[]) => {
    if ((ms ?? 0) < 1000 || keep.includes(ms!)) return real(fn, ms, ...a);
    sleeps.push(ms!);
    const t = real(fireSleeps ? fn : () => undefined, fireSleeps ? 1 : ms, ...a);
    if (!fireSleeps) t.unref();
    return t;
  }) as never);
  return sleeps;
}

describe.each(SERVICES)('%s: the per-scan deadline', (_name, kind, tick, table) => {
  const stampOf = (id: string) => h.statements.find((s) => new RegExp(`UPDATE ${table} SET last_scan_at = NOW\\(\\), last_error = \\$1`).test(s.q) && s.v.includes(id));

  it.each([
    ['a server that drips a line every 100 ms and never completes SELECT', { mode: 'drip' as const }],
    ['a server that answers every fetch with a throttle asking for 2^31-1 ms', { mode: 'throttle' as const, uidNext: 8, messages: [{ uid: 6 }, { uid: 7 }] }],
  ])('%s: the tick ends within the deadline, the row is stamped, the next connection is scanned', async (_what, bad) => {
    recordSleeps(false);
    const servers = serve(bad);
    h.rows = [row('bad-1', 'bad.test', kind), row('good-1', 'good.test', kind)];
    const started = Date.now();
    const results = await tick({ deadlineMs: DEADLINE });
    const took = Date.now() - started;

    expect(took).toBeGreaterThanOrEqual(DEADLINE - 50);
    expect(took).toBeLessThan(DEADLINE + MARGIN);
    expect(results.map((r) => r.connectionId)).toEqual(['bad-1', 'good-1']);
    expect(results[0]!.errors).toBe(1);
    expect(results[1]!.errors).toBe(0);
    expect(servers.good.commands.some((c) => /SELECT INBOX/.test(c))).toBe(true); // the next connection was scanned
    // Stamped with a generic text (on migration_admin), not flipped to 'error'.
    const stamp = stampOf('bad-1');
    expect(stamp?.v).toEqual(['Scan timed out', 'bad-1', COMPANY]);
    expect(h.markError).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn).mock.calls.some((c) => /scan stopped/.test(String(c[0])) && (c[1] as { reason?: string }).reason === 'Scan timed out')).toBe(true);
    expect(stampOf('good-1')).toBeUndefined();
  }, 15000);

  it('the abandoned scan writes nothing further and the socket is closed', async () => {
    const servers = serve({ mode: 'drip' });
    h.rows = [row('bad-1', 'bad.test', kind)];
    await tick({ deadlineMs: DEADLINE });
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.sockets[0]!.destroyed).toBe(true);
    expect(servers.bad.connects).toBe(1);
    expect(h.statements.filter((s) => new RegExp(`UPDATE ${table}`).test(s.q)).map((s) => s.v[0])).toEqual(['Scan timed out']);
  }, 15000);

  it('a throttle backoff the server asks for is capped: ImapFlow never sleeps 2^31-1 ms on its say-so', async () => {
    // ImapFlow's connection (90 s) and greeting (16 s) timeouts stay real: fired at 1 ms they raced the fake's greeting.
    const sleeps = recordSleeps(true, [LONG_DEADLINE, 90_000, 16_000]);
    serve({ mode: 'throttle', uidNext: 8, messages: [{ uid: 6 }, { uid: 7 }] });
    h.rows = [row('bad-1', 'bad.test', kind)];
    await tick({ deadlineMs: LONG_DEADLINE });
    // ImapFlow waits 300000 itself (a constant it caps) and then the retry delay, which is the server's hint
    // (clamped to 30 s by ImapFlow, but the hint wins when larger): the sleep right after each 300000.
    const retryDelays = sleeps.flatMap((ms, i) => (sleeps[i - 1] === 300_000 ? [ms] : []));
    expect(retryDelays.length).toBeGreaterThan(0);
    expect(retryDelays.every((ms) => ms <= MIRROR_THROTTLE_CAP_MS)).toBe(true);
    expect(sleeps).not.toContain(2147483647);
  }, 30000);

  it('the socket idle timeout is lowered, and an idle-timeout error event is logged, not thrown', async () => {
    const servers = serve({ mode: 'drip' });
    h.rows = [row('bad-1', 'bad.test', kind)];
    const scan = tick({ deadlineMs: 1500 });
    await vi.waitFor(() => expect(fake.sockets.length).toBe(1), { timeout: 3000 });
    await vi.waitFor(() => expect(servers.bad.commands.some((c) => /SELECT/.test(c))).toBe(true), { timeout: 3000 });
    fake.sockets[0]!.emit('timeout'); // what the idle timer does; with no 'error' listener this is an uncaught exception
    await scan;
    expect(servers.bad.socketTimeouts).toContain(MIRROR_SOCKET_TIMEOUT_MS);
    expect(vi.mocked(log.warn).mock.calls.some((c) => c[0] === 'imap mirror client error')).toBe(true);
  }, 15000);
});
