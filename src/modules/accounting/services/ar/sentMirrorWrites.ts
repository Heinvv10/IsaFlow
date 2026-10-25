/**
 * The app-pool writes a sent-folder mirror scan makes to its connection row and
 * scan log (S-07e part B, migration 946): the scan stamps, the cursor, the
 * counters and the log. Each is keyed on the connection AND its company, and
 * each waits a bounded time for the row outside a request (mirrorScanWrite.ts).
 */
import { scanWrite } from '@/modules/accounting/services/capture/mirrorScanWrite';

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

export async function logScanEntry(conn: Ref, entry: ScanLogEntry): Promise<void> {
  await scanWrite((q) => q`
    INSERT INTO sent_mirror_scan_log
      (connection_id, company_id, imap_uid, recipient, subject,
       attachment_count, outcome, error,
       linked_invoice_ids, captured_document_ids)
    VALUES
      (${conn.id}::uuid, ${conn.companyId}::uuid, ${entry.imapUid},
       ${entry.recipient}, ${entry.subject}, ${entry.attachmentCount},
       ${entry.outcome}, ${entry.error ?? null},
       ${entry.linkedInvoiceIds ?? null}::uuid[],
       ${entry.capturedDocumentIds ?? null}::uuid[])
  `);
}

export async function advanceCursor(conn: Ref & { scanCursor: Record<string, number> }, folder: string, uid: number): Promise<void> {
  const nextCursor = { ...conn.scanCursor, [folder]: uid };
  await scanWrite((q) => q`
    UPDATE sent_mirror_connections
    SET scan_cursor = ${JSON.stringify(nextCursor)}::jsonb,
        last_scan_at = NOW(),
        last_success_at = NOW()
    WHERE id = ${conn.id}::uuid AND company_id = ${conn.companyId}::uuid
  `);
}

/** A scan with nothing past the cursor: bump last_scan_at so the poll interval kicks in. */
export async function stampSuccess(conn: Ref): Promise<void> {
  await scanWrite((q) => q`
    UPDATE sent_mirror_connections
    SET last_scan_at = NOW(), last_success_at = NOW()
    WHERE id = ${conn.id}::uuid AND company_id = ${conn.companyId}::uuid
  `);
}

export async function addCounters(conn: Ref, captured: number, linked: number): Promise<void> {
  await scanWrite((q) => q`
    UPDATE sent_mirror_connections
    SET messages_captured_total = messages_captured_total + ${captured},
        messages_linked_total   = messages_linked_total   + ${linked}
    WHERE id = ${conn.id}::uuid AND company_id = ${conn.companyId}::uuid
  `);
}
