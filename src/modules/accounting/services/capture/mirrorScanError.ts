/**
 * A mirror scan's failure, recorded on its connection row (S-07e part B,
 * migration 946). Shared by imapMirrorService and sentMirrorService.
 *
 * No app role may write a connection row, so both writes here run on the
 * migration_admin login (`routeAdminQuery`: its own pool, a short transaction
 * that waits at most 2 s for the row), from a fixed statement per table, keyed
 * on the connection AND its company (that role bypasses RLS):
 *   - markMirrorScanError: last_scan_at, last_error, and status 'active' to
 *     'error' (the connection is not scanned again until it is reconnected);
 *   - stampScanStopped: last_scan_at and last_error only, status untouched (a
 *     scan stopped by its deadline or its byte meter: retried next interval).
 * recordScanFailure picks between them for a scan that threw: a transient failure
 * (isTransientScanFailure: DNS gave no answer, or the network refused, timed out or
 * dropped the connection) is stamped and retried next interval, since one DNS blip
 * once disabled a new mailbox for good (2026-11-15); anything else, a rejected login,
 * a refused target and every unclassified error included, still marks it 'error'.
 * Inside a request (scan-now) the write is queued with the scan's other stamps and
 * runs after the request COMMITs (mirrorScanWrite.ts afterRequestCommit), in order:
 * a cursor stamp made earlier in the scan must not land after, and clear, this error.
 *
 * Never throws: the cron scans many connections and one connection's
 * bookkeeping must not stop the tick. A write that waited 2 s in vain (55P03)
 * warns and is lost; the next failing scan writes again.
 */

import { log } from '@/lib/logger';
import { routeAdminQuery } from '@/lib/auth/routeAdminPool';
import { ImapTargetError } from '@/lib/imapTargetGuard';
import { LOCK_NOT_AVAILABLE, afterRequestCommit } from './mirrorScanWrite';

export type MirrorKind = 'imap' | 'sent';
export interface MirrorRef { id: string; companyId: string }

const MARK_ERROR = {
  imap: `UPDATE imap_mirror_connections
            SET last_scan_at = NOW(), last_error = $1,
                status = CASE WHEN status = 'active' THEN 'error' ELSE status END
          WHERE id = $2::uuid AND company_id = $3::uuid`,
  sent: `UPDATE sent_mirror_connections
            SET last_scan_at = NOW(), last_error = $1,
                status = CASE WHEN status = 'active' THEN 'error' ELSE status END
          WHERE id = $2::uuid AND company_id = $3::uuid`,
} as const;

const STAMP_STOPPED = {
  imap: `UPDATE imap_mirror_connections SET last_scan_at = NOW(), last_error = $1
          WHERE id = $2::uuid AND company_id = $3::uuid`,
  sent: `UPDATE sent_mirror_connections SET last_scan_at = NOW(), last_error = $1
          WHERE id = $2::uuid AND company_id = $3::uuid`,
} as const;

/** What a tenant sees when its mail server held a scan past the deadline; the log has the details. */
export const SCAN_TIMED_OUT = 'Scan timed out';

/** What a tenant sees when its mail server sent more for one message than the size it reported allows. */
export const MESSAGE_TOO_LARGE = 'A message was larger than its server said; the scan was stopped';

/** What a tenant sees when the network failed its scan; never the address it tried. The log has the details. */
export const MAIL_SERVER_UNREACHABLE = 'Mail server could not be reached; will retry';

/**
 * Codes of a connect or socket that failed on the way, not on the server's say-so: Node's
 * (net, dns) and ImapFlow's own (socket idle, connect/greeting/STARTTLS deadlines, a socket
 * already gone, a close straight after connecting).
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
  'ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT',
  'NoConnection', 'EConnectionClosed', 'ClosedAfterConnectTLS', 'ClosedAfterConnectText',
]);

/** True only for a failure worth retrying as is; unknown errors are permanent (fail closed). */
export function isTransientScanFailure(err: unknown): boolean {
  if (err instanceof ImapTargetError) return err.transient;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; authenticationFailed?: unknown };
  if (e.authenticationFailed === true) return false;
  return typeof e.code === 'string' && TRANSIENT_CODES.has(e.code);
}

const SCOPE = { imap: 'imap-mirror', sent: 'sent-mirror' } as const;

async function write(kind: MirrorKind, conn: MirrorRef, text: string, error: string, what: string): Promise<void> {
  await afterRequestCommit(SCOPE[kind], `${what} (${kind} mirror)`, () => writeNow(kind, conn, text, error, what));
}

async function writeNow(kind: MirrorKind, conn: MirrorRef, text: string, error: string, what: string): Promise<void> {
  try {
    await routeAdminQuery(`${what} (${kind} mirror)`, text, [error, conn.id, conn.companyId]);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === LOCK_NOT_AVAILABLE) {
      log.warn(`mirror ${what} timed out on a row lock; skipped`, { connectionId: conn.id, kind, code }, SCOPE[kind]);
    } else {
      log.error(`mirror ${what} failed`, { connectionId: conn.id, kind, code, err }, SCOPE[kind]);
    }
  }
}

/** A failed scan: the error is stamped and an active connection becomes 'error'. Never throws. */
export async function markMirrorScanError(kind: MirrorKind, conn: MirrorRef, error: string): Promise<void> {
  await write(kind, conn, MARK_ERROR[kind], error, 'scan error write');
}

/**
 * A scan its guard stopped (mirrorScanGuard.ts): the generic stamp, status untouched. The row's
 * last_scan_at moves to now, so it goes to the back of the due queue. Never throws.
 */
export async function stampScanStopped(kind: MirrorKind, conn: MirrorRef, reason: string): Promise<void> {
  await write(kind, conn, STAMP_STOPPED[kind], reason, 'scan stop stamp');
}

/** A scan that threw: stamped and retried when transient, else marked 'error' with its message. Never throws. */
export async function recordScanFailure(kind: MirrorKind, conn: MirrorRef, err: unknown): Promise<void> {
  if (isTransientScanFailure(err)) {
    await stampScanStopped(kind, conn, err instanceof ImapTargetError ? err.message : MAIL_SERVER_UNREACHABLE);
  } else {
    await markMirrorScanError(kind, conn, err instanceof Error ? err.message : String(err));
  }
}
