/**
 * The writes a sent-folder mirror scan makes (S-07e part B, migration 946), and the
 * cron's due selection. The connection row's stamps (cursor, last_scan_at,
 * last_success_at, the counters) and the selection run on migration_admin, one fixed
 * statement each, keyed on the connection AND its company: no app role may write the
 * table. The scan log stays on the app pool. In a request (scan-now) the stamps run after its
 * COMMIT, in order (stampScan), so a rolled-back request never moves the cursor. See capture/mirrorScanWrite.ts for both.
 */
import { clipMirrorText } from '@/modules/accounting/services/capture/mirrorScanLimits';
import { scanWrite, stampConnection, stampScan } from '@/modules/accounting/services/capture/mirrorScanWrite';

interface Ref { id: string; companyId: string }

export interface ScanLogEntry {
  imapUid: string | null;
  recipient: string | null;
  subject: string | null;
  attachmentCount: number;
  outcome: 'linked_to_invoice' | 'captured_outbound' | 'skipped_no_attachment' | 'skipped_too_large' | 'error';
  error?: string | null;
  linkedInvoiceIds?: string[];
  capturedDocumentIds?: string[];
}

/** As the capture mirror's (imapMirrorWrites.ts): oldest first, a future last_scan_at due and last. */
const DUE = `SELECT * FROM sent_mirror_connections
  WHERE status = 'active'
    AND (last_scan_at IS NULL
         OR last_scan_at > NOW()
         OR last_scan_at < NOW() - (scan_interval_minutes || ' minutes')::INTERVAL)
  ORDER BY CASE WHEN last_scan_at > NOW() THEN 'infinity'::timestamptz ELSE last_scan_at END ASC NULLS FIRST
  LIMIT 20
  FOR NO KEY UPDATE SKIP LOCKED`;

const SET_CURSOR = `UPDATE sent_mirror_connections
  SET scan_cursor = $1::jsonb, last_scan_at = NOW(), last_success_at = NOW()
  WHERE id = $2::uuid AND company_id = $3::uuid`;
const SET_SUCCESS = `UPDATE sent_mirror_connections SET last_scan_at = NOW(), last_success_at = NOW()
  WHERE id = $1::uuid AND company_id = $2::uuid`;
const ADD_COUNTERS = `UPDATE sent_mirror_connections
  SET messages_captured_total = messages_captured_total + $1, messages_linked_total = messages_linked_total + $2
  WHERE id = $3::uuid AND company_id = $4::uuid`;

export async function selectDueSentConnections(): Promise<Record<string, unknown>[]> {
  return stampConnection('select due sent mirror connections', DUE, []);
}

export async function logScanEntry(conn: Ref, entry: ScanLogEntry): Promise<void> {
  await scanWrite((q) => q`
    INSERT INTO sent_mirror_scan_log
      (connection_id, company_id, imap_uid, recipient, subject,
       attachment_count, outcome, error,
       linked_invoice_ids, captured_document_ids)
    VALUES
      (${conn.id}::uuid, ${conn.companyId}::uuid, ${entry.imapUid},
       ${clipMirrorText(entry.recipient)}, ${clipMirrorText(entry.subject)}, ${entry.attachmentCount},
       ${entry.outcome}, ${entry.error ?? null},
       ${entry.linkedInvoiceIds ?? null}::uuid[],
       ${entry.capturedDocumentIds ?? null}::uuid[])
  `);
}

export async function advanceCursor(conn: Ref & { scanCursor: Record<string, number> }, folder: string, uid: number): Promise<void> {
  const nextCursor = { ...conn.scanCursor, [folder]: uid };
  await stampScan('sent-mirror', 'sent mirror cursor', SET_CURSOR, [JSON.stringify(nextCursor), conn.id, conn.companyId]);
}

/** A scan with nothing past the cursor: bump last_scan_at so the poll interval kicks in. */
export async function stampSuccess(conn: Ref): Promise<void> {
  await stampScan('sent-mirror', 'sent mirror success stamp', SET_SUCCESS, [conn.id, conn.companyId]);
}

export async function addCounters(conn: Ref, captured: number, linked: number): Promise<void> {
  await stampScan('sent-mirror', 'sent mirror counters', ADD_COUNTERS, [captured, linked, conn.id, conn.companyId]);
}
