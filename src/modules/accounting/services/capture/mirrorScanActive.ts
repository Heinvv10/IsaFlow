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
