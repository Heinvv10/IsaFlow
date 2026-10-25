/**
 * The writes an IMAP mirror scan makes (S-07e part B, migration 946), and the cron's
 * due selection. The connection row's stamps (cursor, last_scan_at, last_success_at,
 * last_error, the counter) and the selection run on migration_admin, one fixed
 * statement each, keyed on the connection AND its company: no app role may write the
 * table. The scan log stays on the app pool. In a request (scan-now) the stamps run after its
 * COMMIT, in order (stampScan), so a rolled-back request never moves the cursor. See mirrorScanWrite.ts for both.
 */
import { clipMirrorText } from './mirrorScanLimits';
import { scanWrite, stampConnection, stampScan } from './mirrorScanWrite';

interface Ref { id: string; companyId: string }
type Cursor = Record<string, number>;

export interface ScanLogEntry {
  imapUid: string | null;
  sender: string | null;
  subject: string | null;
  attachmentCount: number;
  outcome: string;
  error?: string | null;
  captureEventIds?: string[];
}

/**
 * The active connections due for a scan, oldest first: never scanned, then the longest
 * waiting; a last_scan_at in the future (only migration_admin can write one now) is due
 * and sorts last. SKIP LOCKED passes over a row another migration_admin write holds; NO KEY
 * UPDATE does not wait for the key-share lock an app role's scan-log INSERT takes.
 */
const DUE = `SELECT * FROM imap_mirror_connections
  WHERE status = 'active'
    AND (last_scan_at IS NULL
         OR last_scan_at > NOW()
         OR last_scan_at < NOW() - (scan_interval_minutes || ' minutes')::INTERVAL)
  ORDER BY CASE WHEN last_scan_at > NOW() THEN 'infinity'::timestamptz ELSE last_scan_at END ASC NULLS FIRST
  LIMIT 20
  FOR NO KEY UPDATE SKIP LOCKED`;

const SET_CURSOR = `UPDATE imap_mirror_connections
  SET scan_cursor = $1::jsonb, last_scan_at = NOW(), last_success_at = NOW(), last_error = NULL
  WHERE id = $2::uuid AND company_id = $3::uuid`;
const SET_SUCCESS = `UPDATE imap_mirror_connections SET last_scan_at = NOW(), last_success_at = NOW(), last_error = NULL
  WHERE id = $1::uuid AND company_id = $2::uuid`;
const SET_STOPPED = `UPDATE imap_mirror_connections SET last_scan_at = NOW(), last_error = $1
  WHERE id = $2::uuid AND company_id = $3::uuid`;
const ADD_INGESTED = `UPDATE imap_mirror_connections SET messages_ingested_total = messages_ingested_total + $1
  WHERE id = $2::uuid AND company_id = $3::uuid`;

export async function selectDueConnections(): Promise<Record<string, unknown>[]> {
  return stampConnection('select due imap mirror connections', DUE, []);
}

export async function logScanEntry(conn: Ref, entry: ScanLogEntry): Promise<void> {
  await scanWrite((q) => q`
    INSERT INTO imap_mirror_scan_log
      (connection_id, company_id, imap_uid, sender, subject,
       attachment_count, outcome, error, capture_event_ids)
    VALUES
      (${conn.id}::uuid, ${conn.companyId}::uuid, ${entry.imapUid},
       ${clipMirrorText(entry.sender)}, ${clipMirrorText(entry.subject)}, ${entry.attachmentCount},
       ${entry.outcome}, ${entry.error ?? null},
       ${entry.captureEventIds ?? null}::uuid[])
  `);
}

export async function updateCursor(conn: Ref & { scanCursor: Cursor }, folder: string, uid: number): Promise<void> {
  const nextCursor = { ...conn.scanCursor, [folder]: uid };
  await stampScan('imap-mirror', 'imap mirror cursor', SET_CURSOR, [JSON.stringify(nextCursor), conn.id, conn.companyId]);
}

/** A scan with nothing past the cursor: still bump last_scan_at so the poll interval kicks in correctly. */
export async function stampSuccess(conn: Ref): Promise<void> {
  await stampScan('imap-mirror', 'imap mirror success stamp', SET_SUCCESS, [conn.id, conn.companyId]);
}

/** A stop shows its error (after any progress); status stays active so the next scan retries. */
export async function stampStopped(conn: Ref, error: string): Promise<void> {
  await stampScan('imap-mirror', 'imap mirror stop stamp', SET_STOPPED, [error, conn.id, conn.companyId]);
}

export async function addIngested(conn: Ref, ingested: number): Promise<void> {
  await stampScan('imap-mirror', 'imap mirror counter', ADD_INGESTED, [ingested, conn.id, conn.companyId]);
}
