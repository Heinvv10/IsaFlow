/**
 * Lookups of a tenant's captured_documents by the SHA-256 of the raw file, shared by
 * the two mailbox mirrors. Every query is scoped by company_id: a hash collision
 * across tenants never links or hides anything. `idx_captured_documents_sha_company`
 * (migration 436) serves them. There is NO unique index, so these are the only thing
 * standing between a re-scan of a mailbox and a second copy of every file in it.
 */
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

export interface HashMatch {
  documentId: string;
  invoiceId: string | null;
  documentType: string | null;
}

/**
 * The tenant's oldest captured_documents row with this hash, and any customer_invoice
 * that already points at it (the snapshot link from Phase 1). Used by the sent mirror.
 */
export async function findExistingByHash(companyId: string, hash: string): Promise<HashMatch | null> {
  const rows = (await sql`
    SELECT cd.id AS document_id,
           cd.document_type,
           ci.id AS invoice_id
    FROM captured_documents cd
    LEFT JOIN customer_invoices ci
      ON ci.source_document_id = cd.id
     AND ci.company_id = cd.company_id
    WHERE cd.company_id = ${companyId}::uuid
      AND cd.raw_bytes_sha256 = ${hash}
    ORDER BY cd.created_at ASC
    LIMIT 1
  `) as Row[];
  const row = rows[0];
  if (!row) return null;
  return {
    documentId: String(row.document_id),
    invoiceId: row.invoice_id ? String(row.invoice_id) : null,
    documentType: row.document_type ? String(row.document_type) : null,
  };
}

/**
 * True when the tenant already holds this file: a captured_documents row with the hash that is
 * neither rejected nor failed, and not an unfinished mirror ingest.
 * - Rejected (`status = 'rejected'`) or failed to read (`read_state = 'failed'`): a re-sent copy
 *   is captured again, so the tenant gets a second go at a file that once failed.
 * - A mirror ingest leaves its row 'pending' with a capture event; it counts while that event
 *   has not failed (routing marks the event 'failed', not the document). An ingest that failed
 *   after its row was inserted leaves it 'pending' with no event at all (the runbook's orphan
 *   query lists them); the scan retries that message, so it must not count either.
 * Limit: captured_documents is app-writable (outside migration 946), so SQL injected on an app
 * pool can plant a row with a file's hash and make that file look held when it arrives.
 */
export async function isFileAlreadyCaptured(companyId: string, hash: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM captured_documents cd
    WHERE cd.company_id = ${companyId}::uuid
      AND cd.raw_bytes_sha256 = ${hash}
      AND cd.status <> 'rejected'
      AND cd.read_state <> 'failed'
      AND (cd.status <> 'pending'
           OR EXISTS (SELECT 1 FROM capture_events ce
                       WHERE ce.captured_document_id = cd.id
                         AND ce.company_id = cd.company_id
                         AND ce.status <> 'failed'))
    LIMIT 1
  `) as Row[];
  return rows.length > 0;
}
