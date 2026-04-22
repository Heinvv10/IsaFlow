/**
 * Capture Query Service
 * Read-only queries for capture_events joined with captured_documents.
 */

import { sql } from '@/lib/neon';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CaptureEventRow {
  eventId: string;
  companyId: string;
  inboxId: string | null;
  receivedAt: string;
  channel: string;
  sender: string | null;
  subject: string | null;
  status: string;
  error: string | null;
  postedBy: string | null;
  postedAt: string | null;
  capturedDocumentId: string | null;
  // Joined from captured_documents
  vendorName: string | null;
  documentDate: string | null;
  referenceNumber: string | null;
  totalAmount: number | null;
  extractedData: unknown;
  fileName: string | null;
  fileType: string | null;
  documentType: string | null;
}

type Row = Record<string, unknown>;

function mapEvent(row: Row): CaptureEventRow {
  return {
    eventId: row.event_id as string,
    companyId: row.company_id as string,
    inboxId: row.inbox_id as string | null,
    receivedAt: new Date(row.received_at as string).toISOString(),
    channel: row.channel as string,
    sender: row.sender as string | null,
    subject: row.subject as string | null,
    status: row.status as string,
    error: row.error as string | null,
    postedBy: row.posted_by as string | null,
    postedAt: row.posted_at ? new Date(row.posted_at as string).toISOString() : null,
    capturedDocumentId: row.captured_document_id as string | null,
    vendorName: row.vendor_name as string | null,
    documentDate: row.document_date
      ? new Date(row.document_date as string).toISOString().split('T')[0]!
      : null,
    referenceNumber: row.reference_number as string | null,
    totalAmount:
      row.total_amount != null
        ? parseFloat(String(row.total_amount))
        : null,
    extractedData: row.extracted_data ?? null,
    fileName: row.file_name as string | null,
    fileType: row.file_type as string | null,
    documentType: row.document_type as string | null,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const PENDING_STATUSES = ['received', 'extracting', 'extracted'] as const;

/**
 * List pending events (received / extracting / extracted) with joined document data.
 * Pass `status` to filter to a single status value.
 */
export async function listPendingEvents(
  companyId: string,
  limit = 50,
  status?: string,
): Promise<CaptureEventRow[]> {
  let rows: Row[];

  if (status) {
    rows = await sql`
      SELECT
        ce.id          AS event_id,
        ce.company_id,
        ce.inbox_id,
        ce.received_at,
        ce.channel,
        ce.sender,
        ce.subject,
        ce.status,
        ce.error,
        ce.posted_by,
        ce.posted_at,
        ce.captured_document_id,
        cd.vendor_name,
        cd.document_date,
        cd.reference_number,
        cd.total_amount,
        cd.extracted_data,
        cd.file_name,
        cd.file_type,
        cd.document_type
      FROM capture_events ce
      LEFT JOIN captured_documents cd
        ON cd.id = ce.captured_document_id AND cd.company_id = ${companyId}
      WHERE ce.company_id = ${companyId}
        AND ce.status = ${status}
      ORDER BY ce.received_at DESC
      LIMIT ${limit}
    ` as Row[];
  } else {
    rows = await sql`
      SELECT
        ce.id          AS event_id,
        ce.company_id,
        ce.inbox_id,
        ce.received_at,
        ce.channel,
        ce.sender,
        ce.subject,
        ce.status,
        ce.error,
        ce.posted_by,
        ce.posted_at,
        ce.captured_document_id,
        cd.vendor_name,
        cd.document_date,
        cd.reference_number,
        cd.total_amount,
        cd.extracted_data,
        cd.file_name,
        cd.file_type,
        cd.document_type
      FROM capture_events ce
      LEFT JOIN captured_documents cd
        ON cd.id = ce.captured_document_id AND cd.company_id = ${companyId}
      WHERE ce.company_id = ${companyId}
        AND ce.status = ANY(${PENDING_STATUSES as unknown as string[]})
      ORDER BY ce.received_at DESC
      LIMIT ${limit}
    ` as Row[];
  }

  return rows.map(mapEvent);
}

/** Fetch a single event with its joined document data. */
export async function getEvent(
  eventId: string,
  companyId: string,
): Promise<CaptureEventRow | null> {
  const rows = await sql`
    SELECT
      ce.id          AS event_id,
      ce.company_id,
      ce.inbox_id,
      ce.received_at,
      ce.channel,
      ce.sender,
      ce.subject,
      ce.status,
      ce.error,
      ce.posted_by,
      ce.posted_at,
      ce.captured_document_id,
      cd.vendor_name,
      cd.document_date,
      cd.reference_number,
      cd.total_amount,
      cd.extracted_data,
      cd.file_name,
      cd.file_type,
      cd.document_type
    FROM capture_events ce
    LEFT JOIN captured_documents cd
      ON cd.id = ce.captured_document_id AND cd.company_id = ${companyId}
    WHERE ce.id = ${eventId}::uuid
      AND ce.company_id = ${companyId}
    LIMIT 1
  ` as Row[];

  if (rows.length === 0) return null;
  return mapEvent(rows[0]!);
}
