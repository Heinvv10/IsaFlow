/**
 * The bounds on one mirror scan, shared by imapMirrorService and sentMirrorService.
 *
 * The cron scans its connections one after another and the mail server is the
 * tenant's own, so nothing about its timing can be trusted: ImapFlow's socketTimeout
 * counts idle time only (a server that drips a line every second never trips it) and
 * it has no per-command timeout. Each scan therefore runs under a hard deadline.
 * When it passes, the client is closed, the connection row is stamped
 * (last_scan_at = NOW(), a generic last_error; status stays active) so it goes to the
 * back of the due queue, and the tick moves to the next connection. The abandoned scan
 * unwinds on its own: the closed client rejects its pending commands, and it stops at
 * the next guard.check() without writing anything further.
 *
 * Also here: the size cap on a message whose body the scan is about to fetch. The
 * source literal is held in memory (and copied again by the parser), so a message
 * larger than the capture pipeline can read is skipped by its RFC822.SIZE.
 */
import type { ImapFlow } from 'imapflow';
import { log } from '@/lib/logger';
import { MAX_FILE_SIZE } from './captureLimits';
import { stampScanTimeout, type MirrorKind, type MirrorRef } from './mirrorScanError';

/** How long one connection's scan may run, connect to logout. */
export const MIRROR_SCAN_DEADLINE_MS = 120_000;

/**
 * The largest message (RFC822.SIZE) a scan fetches: the capture pipeline's largest file,
 * as base64 (4/3) plus 64 KB for headers and the text part.
 */
export const MAX_MIRROR_MESSAGE_BYTES = Math.ceil((MAX_FILE_SIZE * 4) / 3) + 64 * 1024;

export interface ScanOptions {
  /** Overrides MIRROR_SCAN_DEADLINE_MS (tests). */
  deadlineMs?: number;
}

/** True when the server reported a size and it is over the cap; a message with no reported size is not skipped. */
export function isOversizedMessage(size: unknown): boolean {
  return typeof size === 'number' && size > MAX_MIRROR_MESSAGE_BYTES;
}

export class ScanDeadlineError extends Error {
  constructor() {
    super('Scan timed out');
    this.name = 'ScanDeadlineError';
  }
}

/** Handed to a scan so it can register its client and notice the deadline. */
export class ScanGuard {
  expired = false;
  private client: ImapFlow | null = null;

  /** Registers the scan's client; if the deadline already passed, closes it and stops the scan. */
  track(client: ImapFlow): ImapFlow {
    this.client = client;
    if (this.expired) {
      this.closeClient();
      throw new ScanDeadlineError();
    }
    return client;
  }

  /** Throws once the deadline has passed, so an abandoned scan makes no further writes. */
  check(): void {
    if (this.expired) throw new ScanDeadlineError();
  }

  expire(): void {
    this.expired = true;
    this.closeClient();
  }

  private closeClient(): void {
    try {
      this.client?.close();
    } catch (err) {
      log.warn('closing a timed-out mirror client failed', { err: String((err as Error)?.message ?? err) }, 'imap-mirror');
    }
  }
}

const EXPIRED = Symbol('scan deadline');

/**
 * Runs `scan` under the deadline. `result` is the object the scan fills in; when the
 * deadline wins, it is returned as it stands with one more error counted.
 */
export async function runGuardedScan<R extends { errors: number }>(
  kind: MirrorKind, conn: MirrorRef, result: R,
  scan: (guard: ScanGuard) => Promise<R>, deadlineMs: number = MIRROR_SCAN_DEADLINE_MS,
): Promise<R> {
  const guard = new ScanGuard();
  const work = scan(guard);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof EXPIRED>((resolve) => { timer = setTimeout(() => resolve(EXPIRED), deadlineMs); });
  try {
    const won = await Promise.race([work, deadline]);
    if (won !== EXPIRED) return won;
  } finally {
    clearTimeout(timer);
  }
  guard.expire();
  work.catch((err: unknown) => {
    log.debug('abandoned mirror scan ended', { connectionId: conn.id, err: String((err as Error)?.message ?? err) }, 'imap-mirror');
  });
  log.warn('mirror scan passed its deadline; client closed, moving on', { connectionId: conn.id, kind, deadlineMs }, 'imap-mirror');
  result.errors += 1;
  await stampScanTimeout(kind, conn);
  return result;
}
