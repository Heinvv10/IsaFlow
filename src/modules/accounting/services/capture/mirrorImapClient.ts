/**
 * The ImapFlow client a mirror scan connects with, shared by imapMirrorService and
 * sentMirrorService. A tenant's mail server is untrusted input to the cron, so the
 * client is bounded where ImapFlow lets it be:
 *
 * - `socketTimeout` is idle-only (a server that keeps talking never trips it), so it
 *   is lowered to MIRROR_SOCKET_TIMEOUT_MS; the whole scan is bounded by the deadline
 *   in mirrorScanGuard.ts.
 * - A throttle answer ("Suggested Backoff Time: N milliseconds") makes ImapFlow sleep
 *   min(N, 5 min) and then sleep N again, uncapped, before each of 4 retries. ImapFlow
 *   has no option for it, but it logs the error object it then throws, so a logger that
 *   caps `err.throttleReset` on the way bounds the second sleep to MIRROR_THROTTLE_CAP_MS.
 * - 'error' events (an idle timeout emits one) have a listener, else Node treats them
 *   as an uncaught exception.
 */
import { ImapFlow } from 'imapflow';
import { log } from '@/lib/logger';

/** Idle time on the socket after which ImapFlow gives up on it. */
export const MIRROR_SOCKET_TIMEOUT_MS = 60_000;

/** The longest ImapFlow's retry of a throttled request waits on a server's say-so. */
export const MIRROR_THROTTLE_CAP_MS = 10_000;

export interface MirrorClientTarget {
  host: string;
  servername?: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

function ignore(): void {
  // ImapFlow's own log lines are not kept (logger: false before this logger existed).
}

function capThrottle(entry: unknown): void {
  const err = (entry as { err?: { throttleReset?: unknown } } | null)?.err;
  if (!err || typeof err.throttleReset !== 'number' || err.throttleReset <= MIRROR_THROTTLE_CAP_MS) return;
  log.warn('imap server asked for a long throttle backoff; capped', { requestedMs: err.throttleReset, cappedMs: MIRROR_THROTTLE_CAP_MS }, 'imap-mirror');
  err.throttleReset = MIRROR_THROTTLE_CAP_MS;
}

export function createMirrorClient(target: MirrorClientTarget): ImapFlow {
  const client = new ImapFlow({
    host: target.host, servername: target.servername, port: target.port, secure: target.secure,
    auth: { user: target.user, pass: target.pass },
    socketTimeout: MIRROR_SOCKET_TIMEOUT_MS,
    logger: { debug: ignore, info: ignore, warn: capThrottle, error: ignore },
  });
  client.on('error', (err: unknown) => {
    const e = err as { message?: unknown; code?: unknown } | null;
    log.warn('imap mirror client error', { err: String(e?.message ?? err), code: e?.code }, 'imap-mirror');
  });
  return client;
}
