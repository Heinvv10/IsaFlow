/**
 * The bounds on one mirror scan, shared by imapMirrorService and sentMirrorService.
 *
 * The cron scans its connections one after another and the mail server is the
 * tenant's own, so nothing about its timing or its sizes can be trusted: ImapFlow's
 * socketTimeout counts idle time only (a server that drips a line every second never
 * trips it), it has no per-command timeout, and it buffers a literal of up to 1 GB
 * whatever size the server reported. Each scan therefore runs under a hard deadline
 * and a byte meter on its client (mirrorScanLimits.ts). When either trips, the client
 * is closed, the connection row is stamped (last_scan_at = NOW(), a generic last_error:
 * SCAN_TIMED_OUT or MESSAGE_TOO_LARGE; status stays active) so it goes to the back of
 * the due queue, and the tick moves to the next connection. The abandoned scan unwinds
 * on its own: the closed client rejects its pending commands, it stops at the next
 * guard.check(), and its catch returns without a stamp of its own (it can finish the
 * write already in flight when the guard tripped).
 *
 * A server that lies about a message's size trips the meter on that message on every
 * tick: the cursor does not pass it until the tenant removes it from the mailbox.
 */
import type { ImapFlow } from 'imapflow';
import { log } from '@/lib/logger';
import { claimScan } from './mirrorScanActive';
import { releaseAfterRequestStamps } from './mirrorScanWrite';
import { ByteMeter } from './mirrorScanLimits';
import { MESSAGE_TOO_LARGE, SCAN_TIMED_OUT, stampScanStopped, type MirrorKind, type MirrorRef } from './mirrorScanError';

export { MAX_MIRROR_MESSAGE_BYTES, clipMirrorText, isOversizedMessage } from './mirrorScanLimits';

/** How long one connection's scan may run, connect to logout. */
export const MIRROR_SCAN_DEADLINE_MS = 120_000;

export interface ScanOptions {
  /** Overrides MIRROR_SCAN_DEADLINE_MS (tests). */
  deadlineMs?: number;
}

export class ScanDeadlineError extends Error {
  constructor() {
    super('Scan timed out');
    this.name = 'ScanDeadlineError';
  }
}

/** Handed to a scan so it can register its client and notice that the scan was stopped. */
export class ScanGuard {
  expired = false;
  /** Why the scan was stopped (the stamp's last_error), once it was. */
  stopReason: string | null = null;
  private client: ImapFlow | null = null;
  private onStop: ((reason: string) => void) | null = null;

  constructor(onStop?: (reason: string) => void) {
    this.onStop = onStop ?? null;
  }

  /** Registers the scan's client and meters its bytes; if the scan was already stopped, closes it and throws. */
  track(client: ImapFlow): ImapFlow {
    this.client = client;
    if (this.expired) {
      this.closeClient();
      throw new ScanDeadlineError();
    }
    new ByteMeter(client, (bytes, limit) => {
      log.warn('mirror server sent a response over its size limit; client closed', { bytes, limit }, 'imap-mirror');
      this.stop(MESSAGE_TOO_LARGE);
    });
    return client;
  }

  /** Throws once the scan was stopped, so an abandoned scan makes no further writes. */
  check(): void {
    if (this.expired) throw new ScanDeadlineError();
  }

  /** Stops the scan: closes its client and tells runGuardedScan (once). */
  stop(reason: string): void {
    if (this.expired) return;
    this.expired = true;
    this.stopReason = reason;
    this.closeClient();
    this.onStop?.(reason);
  }

  private closeClient(): void {
    try {
      this.client?.close();
    } catch (err) {
      log.warn('closing a stopped mirror client failed', { err: String((err as Error)?.message ?? err) }, 'imap-mirror');
    }
  }
}

/**
 * Runs `scan` under the deadline and the byte meter. `result` is the object the scan fills in;
 * when either stops it, it is returned as it stands with one more error counted. A connection
 * that already has a scan running is not scanned again: `result` comes back untouched.
 */
export async function runGuardedScan<R extends { errors: number }>(
  kind: MirrorKind, conn: MirrorRef, result: R,
  scan: (guard: ScanGuard) => Promise<R>, deadlineMs: number = MIRROR_SCAN_DEADLINE_MS,
): Promise<R> {
  // One scan of a connection at a time (mirrorScanActive.ts): the cron skips a connection a scan-now holds.
  const release = claimScan(conn.id);
  if (!release) {
    log.info('mirror scan skipped: a scan of this connection is already running', { connectionId: conn.id, kind }, 'imap-mirror');
    return result;
  }
  let stopped: (reason: string) => void = () => undefined;
  const stop = new Promise<string>((resolve) => { stopped = resolve; });
  const guard = new ScanGuard((reason) => stopped(reason));
  const timer = setTimeout(() => guard.stop(SCAN_TIMED_OUT), deadlineMs);
  const work = scan(guard);
  try {
    const won = await Promise.race([work, stop]);
    if (guard.stopReason === null && typeof won !== 'string') return won;
  } finally {
    clearTimeout(timer);
    // Inside a request (scan-now) the claim is held until the request's stamps have run (mirrorScanWrite.ts).
    releaseAfterRequestStamps(release);
  }
  work.catch((err: unknown) => {
    log.debug('abandoned mirror scan ended', { connectionId: conn.id, err: String((err as Error)?.message ?? err) }, 'imap-mirror');
  });
  const reason = guard.stopReason ?? SCAN_TIMED_OUT;
  log.warn('mirror scan stopped; client closed, moving on', { connectionId: conn.id, kind, reason, deadlineMs }, 'imap-mirror');
  result.errors += 1;
  await stampScanStopped(kind, conn, reason);
  return result;
}
