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
 * not an unfinished mirror ingest. An ingest that failed after its row was inserted leaves the
 * row 'pending' with no capture event (the runbook's orphan query lists them); the scan retries
 * that message, so such a row must not count, or the retry would drop the file for good.
 */
export async function isFileAlreadyCaptured(companyId: string, hash: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1
    FROM captured_documents cd
    WHERE cd.company_id = ${companyId}::uuid
      AND cd.raw_bytes_sha256 = ${hash}
      AND (cd.status <> 'pending'
           OR EXISTS (SELECT 1 FROM capture_events ce
                       WHERE ce.captured_document_id = cd.id
                         AND ce.company_id = cd.company_id))
    LIMIT 1
  `) as Row[];
  return rows.length > 0;
}
