/**
 * The app-pool writes an IMAP mirror scan makes to its connection row and scan
 * log (S-07e part B, migration 946): the scan stamps, the cursor, the counter
 * and the log. Each is keyed on the connection AND its company, and each waits
 * a bounded time for the row outside a request (mirrorScanWrite.ts).
 */
import { scanWrite } from './mirrorScanWrite';

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

export async function logScanEntry(conn: Ref, entry: ScanLogEntry): Promise<void> {
  await scanWrite((q) => q`
    INSERT INTO imap_mirror_scan_log
      (connection_id, company_id, imap_uid, sender, subject,
       attachment_count, outcome, error, capture_event_ids)
    VALUES
      (${conn.id}::uuid, ${conn.companyId}::uuid, ${entry.imapUid},
       ${entry.sender}, ${entry.subject}, ${entry.attachmentCount},
       ${entry.outcome}, ${entry.error ?? null},
       ${entry.captureEventIds ?? null}::uuid[])
  `);
}

export async function updateCursor(conn: Ref & { scanCursor: Cursor }, folder: string, uid: number): Promise<void> {
  const nextCursor = { ...conn.scanCursor, [folder]: uid };
  await scanWrite((q) => q`
    UPDATE imap_mirror_connections
    SET scan_cursor = ${JSON.stringify(nextCursor)}::jsonb,
        last_scan_at = NOW(),
        last_success_at = NOW(), last_error = NULL,
        messages_ingested_total = messages_ingested_total
    WHERE id = ${conn.id}::uuid AND company_id = ${conn.companyId}::uuid
  `);
}

/** A scan with nothing past the cursor: still bump last_scan_at so the poll interval kicks in correctly. */
export async function stampSuccess(conn: Ref): Promise<void> {
  await scanWrite((q) => q`
    UPDATE imap_mirror_connections
    SET last_scan_at = NOW(), last_success_at = NOW(), last_error = NULL
    WHERE id = ${conn.id}::uuid AND company_id = ${conn.companyId}::uuid
  `);
}

/** A stop shows its error (after any progress); status stays active so the next scan retries. */
export async function stampStopped(conn: Ref, error: string): Promise<void> {
  await scanWrite((q) => q`
    UPDATE imap_mirror_connections SET last_scan_at = NOW(), last_error = ${error}
    WHERE id = ${conn.id}::uuid AND company_id = ${conn.companyId}::uuid
  `);
}

export async function addIngested(conn: Ref, ingested: number): Promise<void> {
  await scanWrite((q) => q`
    UPDATE imap_mirror_connections
    SET messages_ingested_total = messages_ingested_total + ${ingested}
    WHERE id = ${conn.id}::uuid AND company_id = ${conn.companyId}::uuid
  `);
}
