/**
 * Which mirror connections have a scan running in this process, so one connection
 * is never scanned twice at once: the cron's tick and a tenant's scan-now both
 * start from the same stored cursor, and the de-dupe in both mirrors is a
 * check-then-insert with no unique index behind it (capturedDocumentHash.ts), so
 * two overlapping scans of one mailbox can capture a file twice.
 *
 * A scan holds its claim from runGuardedScan's start until it settles or its guard
 * stops it (the deadline, the byte meter), whichever is first: an abandoned scan
 * only finishes the write already in flight and stops at its next guard.check(), and
 * a claim that waited for it could outlive a hung database call.
 * Inside a request (scan-now) the release itself waits for the request's queued stamps
 * (mirrorScanWrite.releaseAfterRequestStamps), so a cron tick cannot start before the
 * scan-now's documents have COMMITTED; a backstop timer bounds that wait.
 *
 * In-process only. Production runs one process; with more, two scans of one
 * connection can still overlap across them (named in the S-07e part B runbook).
 */
const active = new Set<string>();

/** True while a scan of this connection (either mirror: ids are UUIDs) holds its claim. */
export function isScanActive(connectionId: string): boolean {
  return active.has(connectionId);
}

/** Claims the connection for one scan; null when another scan already holds it. The release is idempotent. */
export function claimScan(connectionId: string): (() => void) | null {
  if (active.has(connectionId)) return null;
  active.add(connectionId);
  return () => { active.delete(connectionId); };
}

/**
 * The 409 a connection's update, disconnect and delete routes answer while a scan of it holds its claim. A scan-now's
 * scan-log INSERT holds a key-share lock on the row, which blocks a DELETE; without this refusal each such request sat
 * on an auth-pool connection waiting for the route pool and the row (up to 2 s each), and a tenant's burst of them
 * stalled every tenant's requests. Refused here, before any database call, it costs nothing.
 */
export const SCAN_ACTIVE_MESSAGE = 'A scan of this connection is running. Try again in a minute.';
