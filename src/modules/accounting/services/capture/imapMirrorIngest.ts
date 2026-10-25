/**
 * The IMAP mirror's ingest of one attachment: the captured_documents row, its bytes in
 * storage, the capture_events row, and the hand-off to the capture router.
 *
 * A file the tenant already holds (same company_id and raw_bytes_sha256, see
 * isFileAlreadyCaptured) is not ingested again: the same attachment reaches a mailbox
 * twice (a forwarded or re-sent invoice), and a scan that is repeated (a lock skip after
 * some messages were ingested, a cursor reset) must capture nothing twice. Nothing else
 * de-duplicates: captured_documents has no unique index on the hash. The sender and
 * subject written to capture_events are clipped (mirrorScanLimits.clipMirrorText).
 */
import type { Attachment, ParsedMail } from 'mailparser';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runAfterCommit } from '@/lib/afterCommit';
import { sha256, storeCapturedBytes } from '@/lib/documentStorage';
import { routeEvent } from '@/modules/accounting/services/capture/captureRouterService';
import { isFileAlreadyCaptured } from './capturedDocumentHash';
import { clipMirrorText } from './mirrorScanLimits';

type Row = Record<string, unknown>;

interface IngestTarget { companyId: string }

/** The capture event for this attachment, or null when the tenant already holds the same file. */
export async function ingestAttachment(
  conn: IngestTarget, inboxId: string,
  parsed: ParsedMail,
  att: Attachment,
): Promise<string | null> {
  const content = att.content as Buffer;
  const sha = sha256(content);
  if (await isFileAlreadyCaptured(conn.companyId, sha)) return null;
  const mime = (att.contentType ?? 'application/octet-stream').toLowerCase();
  const filename = att.filename ?? `mirror-${sha.slice(0, 8)}`;

  // Create captured_documents row first — storeCapturedBytes needs the id
  // so it can scope the storage key.
  const [doc] = (await sql`
    INSERT INTO captured_documents (
      company_id, file_name, file_type, file_size, status,
      raw_bytes_sha256, raw_bytes_size
    ) VALUES (
      ${conn.companyId}::uuid, ${filename}, ${mime}, ${content.length},
      'pending', ${sha}, ${content.length}
    )
    RETURNING id
  `) as Row[];

  const documentId = String(doc!.id);

  // Upload the raw bytes + stamp the pointer
  const stored = await storeCapturedBytes(conn.companyId, documentId, content, mime);
  await sql`
    UPDATE captured_documents
    SET storage_bucket = ${stored.bucket}, storage_path = ${stored.path}
    WHERE id = ${documentId}::uuid AND company_id = ${conn.companyId}::uuid
  `;

  const [event] = (await sql`
    INSERT INTO capture_events (
      company_id, inbox_id, channel, sender, subject,
      status, captured_document_id
    ) VALUES (
      ${conn.companyId}::uuid, ${inboxId}::uuid,
      'imap_mirror', ${clipMirrorText(parsed.from?.text)}, ${clipMirrorText(parsed.subject)},
      'received', ${documentId}::uuid
    )
    RETURNING id
  `) as Row[];

  const eventId = String(event!.id);

  // Hand off to router after the ingest commits — scan-now runs inside withAuth,
  // whose connection this must not outlive (R-075). The cron has no request
  // transaction, so there it starts immediately.
  runAfterCommit('imap mirror routeEvent', () => routeEvent(eventId, conn.companyId).catch((err) => {
    log.warn('routeEvent failed for mirror ingest', { eventId, err }, 'imap-mirror');
  }));

  return eventId;
}
