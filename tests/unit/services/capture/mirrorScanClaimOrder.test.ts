/**
 * S-07e part B, review round 7, two properties of a scan's claim (mirrorScanActive.ts):
 *
 * 1. It is taken synchronously. runScanNow checks isScanActive and the scan then claims with no await in between; an
 *    await added before claimScan would let a cron tick claim the connection in the gap, and the scan-now would answer
 *    200 with zeros instead of 409. Pinned for runScanNow with each mirror's real scan, and for runGuardedScan itself.
 * 2. Inside a request (scan-now) it is held until the request's queued stamps have run, not released when the scan
 *    returns: released earlier, a cron tick could start before the scan-now's documents COMMIT, read the old cursor
 *    and capture a file twice. It is freed after the last stamp, when the request does not commit, and (backstop) if
 *    neither is ever reported. Outside a request it is freed at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@/lib/als';

const h = vi.hoisted(() => ({
  /** Holds the fake mailbox's connect() so a scan stays open. */
  gate: null as Promise<void> | null,
  /** Holds every connection-row stamp. */
  stampGate: null as Promise<void> | null,
  stamped: [] as string[],
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidNext: 0 };
    streamer = { write: () => true, push: () => true };
    on() { /* the mirror registers an 'error' listener */ }
    async connect() { if (h.gate) await h.gate; }
    async logout() { /* fake mailbox */ }
    async getMailboxLock() { return { release: () => undefined }; }
    async *fetch() { /* an empty mailbox */ }
  },
}));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/encryption', () => ({ decrypt: () => 'password' }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withTransaction: vi.fn() }));
vi.mock('@/lib/auth/routeAdminPool', () => ({
  routeAdminQuery: vi.fn(async (label: string) => {
    if (h.stampGate) await h.stampGate;
    h.stamped.push(label);
    return [];
  }),
}));

import { als } from '@/lib/als';
import { drainAfterCommit, settleAfterRollback } from '@/lib/afterCommit';
import { claimScan, isScanActive } from '@/modules/accounting/services/capture/mirrorScanActive';
import { runGuardedScan } from '@/modules/accounting/services/capture/mirrorScanGuard';
import { ScanNowBusyError, runScanNow } from '@/modules/accounting/services/capture/mirrorScanNow';
import { CLAIM_BACKSTOP_MS } from '@/modules/accounting/services/capture/mirrorScanWrite';
import { updateCursor } from '@/modules/accounting/services/capture/imapMirrorWrites';
import { scanConnection, type MirrorConnection } from '@/modules/accounting/services/capture/imapMirrorService';
import { scanSentConnection, type SentMirrorConnection } from '@/modules/accounting/services/ar/sentMirrorService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ref = { id: ID, companyId: COMPANY };
const requestCtx = (): RequestContext => ({ client: {} as RequestContext['client'], userId: 'u1', claims: {}, afterCommit: [], afterRollback: [] });
const imapConn = (): MirrorConnection => ({
  id: ID, companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', folder: 'INBOX', scanCursor: { INBOX: 10 },
  allowedSenders: [], deniedSenders: [], imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u',
  imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});
const sentConn = (): SentMirrorConnection => ({
  id: ID, companyId: COMPANY, provider: 'imap', accountEmail: 'ap@co.test', sentFolder: 'Sent', scanCursor: { Sent: 10 },
  imapHost: 'imap.test', imapPort: 993, imapUseTls: true, imapUsername: 'u', imapPasswordEnc: 'enc', oauthRefreshTokenEnc: null,
});
const opened = () => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { gate, open };
};

beforeEach(() => {
  h.gate = null;
  h.stampGate = null;
  h.stamped.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  ['capture mirror', (opts: { deadlineMs?: number }) => scanConnection(imapConn(), opts)],
  ['sent mirror', (opts: { deadlineMs?: number }) => scanSentConnection(sentConn(), opts)],
] as const)('%s: the claim is taken synchronously', (_name, scan) => {
  it('the connection is claimed in the same synchronous run as runScanNow\'s check, so a second scan-now gets 409 at once', async () => {
    const g = opened();
    h.gate = g.gate;
    const first = runScanNow(ref, scan);
    expect(isScanActive(ID)).toBe(true); // no await has happened yet
    await expect(runScanNow(ref, scan)).rejects.toMatchObject({ reason: 'connection' });
    await expect(runScanNow(ref, scan)).rejects.toBeInstanceOf(ScanNowBusyError);
    g.open();
    await first;
    expect(isScanActive(ID)).toBe(false);
  });
});

describe('runGuardedScan\'s claim', () => {
  it('is taken before the first await', () => {
    const g = opened();
    const running = runGuardedScan('imap', ref, { errors: 0 }, async () => { await g.gate; return { errors: 0 }; });
    expect(isScanActive(ID)).toBe(true);
    g.open();
    return running;
  });

  it('is freed at once when there is no request (the cron)', async () => {
    await runGuardedScan('imap', ref, { errors: 0 }, async () => ({ errors: 0 }));
    expect(isScanActive(ID)).toBe(false);
  });

  it('inside a request it outlives the scan until the request\'s queued stamps have run, then is freed after the LAST one', async () => {
    const ctx = requestCtx();
    let openStamps: () => void = () => undefined;
    h.stampGate = new Promise<void>((resolve) => { openStamps = resolve; }); // stamps held
    await als.run(ctx, () => runGuardedScan('imap', ref, { errors: 0 }, async () => {
      await updateCursor({ ...ref, scanCursor: {} }, 'INBOX', 12);
      return { errors: 0 };
    }));
    expect(isScanActive(ID)).toBe(true); // the scan has returned; nothing has COMMITTED
    expect(claimScan(ID)).toBeNull(); // a cron tick cannot start

    drainAfterCommit(ctx); // COMMIT
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.stamped).toEqual([]);
    expect(isScanActive(ID)).toBe(true); // the stamp is still running
    openStamps();
    await vi.waitFor(() => expect(isScanActive(ID)).toBe(false));
    expect(h.stamped).toHaveLength(1);
  });

  it('a stamp queued by the stop path (after the scan\'s own release point) is also run before the claim is freed', async () => {
    const ctx = requestCtx();
    let openStamps: () => void = () => undefined;
    h.stampGate = new Promise<void>((resolve) => { openStamps = resolve; });
    await als.run(ctx, () => runGuardedScan('imap', ref, { errors: 0 }, () => new Promise(() => undefined), 20));
    expect(isScanActive(ID)).toBe(true);
    drainAfterCommit(ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isScanActive(ID)).toBe(true); // the deadline's stop stamp is still running
    openStamps();
    await vi.waitFor(() => expect(isScanActive(ID)).toBe(false));
    expect(h.stamped).toEqual(['scan stop stamp (imap mirror)']);
  });

  it('inside a request that does not commit it is freed when the owner reports the rollback, with no stamp run', async () => {
    const ctx = requestCtx();
    await als.run(ctx, () => runGuardedScan('imap', ref, { errors: 0 }, async () => {
      await updateCursor({ ...ref, scanCursor: {} }, 'INBOX', 12);
      return { errors: 0 };
    }));
    expect(isScanActive(ID)).toBe(true);
    ctx.afterCommit = undefined;
    settleAfterRollback(ctx, false);
    await vi.waitFor(() => expect(isScanActive(ID)).toBe(false));
    expect(h.stamped).toEqual([]);
  });

  it('a request that never reports either way frees the claim at the backstop, not never', async () => {
    vi.useFakeTimers();
    const ctx = requestCtx();
    await als.run(ctx, () => runGuardedScan('imap', ref, { errors: 0 }, async () => ({ errors: 0 })));
    expect(isScanActive(ID)).toBe(true);
    vi.advanceTimersByTime(CLAIM_BACKSTOP_MS - 1);
    expect(isScanActive(ID)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isScanActive(ID)).toBe(false);
  });

  it('a request that has already finished frees the claim at once (nothing left to wait for)', async () => {
    const ctx = requestCtx();
    ctx.finished = true;
    await als.run(ctx, () => runGuardedScan('imap', ref, { errors: 0 }, async () => ({ errors: 0 })));
    expect(isScanActive(ID)).toBe(false);
  });
});
