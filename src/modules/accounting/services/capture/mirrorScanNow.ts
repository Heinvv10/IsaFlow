/**
 * The bounds on a tenant's "scan now" (the two scan-now routes), which runs a scan
 * inside a request: it holds that request's auth-pool connection and its
 * transaction for as long as the scan runs, and the pools are shared with every
 * other tenant's requests.
 *
 *  - One scan-now per company at a time, and none for a connection that already
 *    has a scan running (a cron tick's or another scan-now's): ScanNowBusyError,
 *    which the routes answer with a 409. Checked and claimed with no await between,
 *    so two requests cannot both pass. In-process, like mirrorScanActive.ts: prod
 *    runs one process; with more, the limit is per process.
 *  - The IMAP side of it runs under SCAN_NOW_DEADLINE_MS, not the cron's
 *    MIRROR_SCAN_DEADLINE_MS (120 s), so a request holds its connection for 30 s
 *    at most (a scan that overruns is closed and stamped like the cron's).
 */
import { isScanActive } from './mirrorScanActive';
import type { ScanOptions } from './mirrorScanGuard';

/** How long a scan-now may run, connect to logout. */
export const SCAN_NOW_DEADLINE_MS = 30_000;

export class ScanNowBusyError extends Error {
  constructor(readonly reason: 'connection' | 'company') {
    super(reason === 'connection'
      ? 'A scan of this connection is already running. Try again in a minute.'
      : 'Another scan for this company is already running. Try again in a minute.');
    this.name = 'ScanNowBusyError';
  }
}

const busyCompanies = new Set<string>();

/** Runs `scan` with the scan-now deadline, or throws ScanNowBusyError before starting it. */
export async function runScanNow<T>(
  conn: { id: string; companyId: string },
  scan: (opts: ScanOptions) => Promise<T>,
): Promise<T> {
  // The checks below and the scan's claimScan (the first statement of runGuardedScan, reached through `scan` with no
  // await in between) must stay in one synchronous run: an await before claimScan lets a cron tick claim the connection
  // in the gap, and this scan-now then answers 200 with zeros instead of 409. mirrorScanClaimOrder.test.ts pins it.
  if (isScanActive(conn.id)) throw new ScanNowBusyError('connection');
  if (busyCompanies.has(conn.companyId)) throw new ScanNowBusyError('company');
  busyCompanies.add(conn.companyId);
  try {
    return await scan({ deadlineMs: SCAN_NOW_DEADLINE_MS });
  } finally {
    busyCompanies.delete(conn.companyId);
  }
}
