/**
 * S-07e part B, review round 6: a scan-now (runScanNow around the real scan) stops its IMAP
 * work after SCAN_NOW_DEADLINE_MS (30 s), where the cron's scan runs for MIRROR_SCAN_DEADLINE_MS
 * (120 s): proven end to end against a mail server whose connect never answers, with only
 * setTimeout faked. The stopped scan is stamped, frees its connection claim for the next scan,
 * and a cron scan of a connection a scan-now holds is skipped, not run beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ connects: 0, closed: 0, stamps: [] as Array<{ text: string; values: unknown[] }> }));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    streamer = { write: () => true, push: () => true }; // what the scan's byte meter wraps
    on() { /* the mirror registers an 'error' listener */ }
    connect() { h.connects += 1; return new Promise<void>(() => undefined); } // a server that never answers
    close() { h.closed += 1; }
    async logout() { /* unreachable: connect never settles */ }
  },
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withTransaction: vi.fn() }));
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (_label: string, text: string, values: unknown[]) => {
    h.stamps.push({ text: text.replace(/\s+/g, ' ').trim(), values });
    return [];
  }),
}));

import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { MIRROR_SCAN_DEADLINE_MS } from '@/modules/accounting/services/capture/mirrorScanGuard';
import { runScanNow, SCAN_NOW_DEADLINE_MS } from '@/modules/accounting/services/capture/mirrorScanNow';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const conn = (id = 'c1'): MirrorConnection => ({
  id, companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor: {},
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u',
  imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});

/** Lets the scan reach its (never answered) connect(); not vi.waitFor, which advances faked timers. */
const reachConnect = async () => {
  await vi.advanceTimersByTimeAsync(0);
  expect(h.connects).toBeGreaterThan(0);
};

beforeEach(() => {
  h.connects = 0; h.closed = 0; h.stamps.length = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { vi.useRealTimers(); });

describe('scan-now deadline', () => {
  it('stops the scan at 30 s: client closed, one error counted, the row stamped "Scan timed out" (status untouched)', async () => {
    const settled = vi.fn();
    const running = runScanNow(conn(), (opts) => scanConnection(conn(), opts)).then(settled);
    await reachConnect();

    await vi.advanceTimersByTimeAsync(SCAN_NOW_DEADLINE_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await running;

    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]![0]).toMatchObject({ connectionId: 'c1', errors: 1 });
    expect(h.closed).toBeGreaterThan(0);
    expect(h.stamps).toHaveLength(1);
    expect(h.stamps[0]!.text).toMatch(/^UPDATE imap_mirror_connections SET last_scan_at = NOW\(\), last_error = \$1 WHERE id = \$2::uuid AND company_id = \$3::uuid$/);
    expect(h.stamps[0]!.values).toEqual(['Scan timed out', 'c1', COMPANY]);
  });

  it('the cron\'s scan of the same server is still waiting at 30 s: it has the long deadline', async () => {
    const settled = vi.fn();
    const running = scanConnection(conn('c2')).then(settled);
    await reachConnect();

    await vi.advanceTimersByTimeAsync(SCAN_NOW_DEADLINE_MS + 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MIRROR_SCAN_DEADLINE_MS - SCAN_NOW_DEADLINE_MS);
    await running;
    expect(settled.mock.calls[0]![0]).toMatchObject({ connectionId: 'c2', errors: 1 });
  });

  it('a scan that was stopped frees its connection: the next scan-now of it starts', async () => {
    const first = runScanNow(conn('c3'), (opts) => scanConnection(conn('c3'), opts));
    await reachConnect();
    await vi.advanceTimersByTimeAsync(SCAN_NOW_DEADLINE_MS);
    await first;

    h.connects = 0;
    const second = runScanNow(conn('c3'), (opts) => scanConnection(conn('c3'), opts));
    await reachConnect();
    expect(h.connects).toBe(1);
    await vi.advanceTimersByTimeAsync(SCAN_NOW_DEADLINE_MS);
    await second;
  });

  it('a cron scan of a connection a scan-now holds does not run beside it (no second connect, nothing counted)', async () => {
    const nowScan = runScanNow(conn('c4'), (opts) => scanConnection(conn('c4'), opts));
    await reachConnect();

    const skipped = await scanConnection(conn('c4'));
    expect(skipped).toEqual({ connectionId: 'c4', scanned: 0, ingested: 0, skipped: 0, errors: 0 });
    expect(h.connects).toBe(1);

    await vi.advanceTimersByTimeAsync(SCAN_NOW_DEADLINE_MS);
    await nowScan;
  });
});
