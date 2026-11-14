/**
 * Seeds for the document-presence suites: rows in the entity store (procurement_documents, document_links), the
 * captured-document store and the bank-line store, plus the cleanup that has to run BEFORE dropFixture (the entity
 * store has no company_id, so it is deleted through the parents).
 */
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import type { Fixture } from './l1FifoFixture';

type Row = Record<string, unknown>;

export async function procDoc(
  entityType: string, entityId: string, opts: { active?: boolean; name?: string } = {},
): Promise<string> {
  return String(((await sql`
    INSERT INTO procurement_documents (entity_type, entity_id, document_type, document_name, file_url, file_path, file_size,
      mime_type, uploaded_by, is_active)
    VALUES (${entityType}, ${entityId}::UUID, 'invoice', ${opts.name ?? 'bill.pdf'}, 'https://files.test/x', 'x/x.pdf', 10,
      'application/pdf', 'fixture', ${opts.active ?? true})
    RETURNING id`) as Row[])[0]!.id);
}

export async function crossLink(documentId: string, entityType: string, entityId: string, reason = 'fixture'): Promise<void> {
  await sql`
    INSERT INTO document_links (document_id, linked_entity_type, linked_entity_id, link_reason)
    VALUES (${documentId}::UUID, ${entityType}, ${entityId}::UUID, ${reason})`;
}

/** A captured document of `companyId`; `stored: false` leaves storage_path empty, `status` defaults to reviewed (null = a NULL status). */
export async function capturedDoc(
  companyId: string, opts: { stored?: boolean; status?: string | null; matchedBankTx?: string | null } = {},
): Promise<string> {
  const stored = opts.stored ?? true;
  return String(((await sql`
    INSERT INTO captured_documents (company_id, file_name, file_type, status, document_type, storage_bucket, storage_path,
      matched_bank_tx_id)
    VALUES (${companyId}::UUID, 'scan.pdf', 'application/pdf', ${opts.status === undefined ? 'reviewed' : opts.status}, 'supplier_invoice',
      ${stored ? 'captured-documents' : null}, ${stored ? `${companyId}/scan-${randomUUID()}.pdf` : null},
      ${opts.matchedBankTx ?? null}::UUID)
    RETURNING id`) as Row[])[0]!.id);
}

export async function bankUpload(bankTxId: string, name = 'slip.png'): Promise<string> {
  return String(((await sql`
    INSERT INTO bank_transaction_attachments (bank_transaction_id, file_url, file_name, file_size)
    VALUES (${bankTxId}::UUID, 'data:image/png;base64,iVBORw0KGgo=', ${name}, 8) RETURNING id`) as Row[])[0]!.id);
}

/** Everything the seeds above create for the fixture's company, in FK-safe order. Call before dropFixture. */
export async function dropDocuments(fx: Fixture): Promise<void> {
  const c = fx.companyId;
  const parents = `SELECT id FROM supplier_invoices WHERE company_id = $1
    UNION SELECT id FROM customer_invoices WHERE company_id = $1 UNION SELECT id FROM credit_notes WHERE company_id = $1`;
  // A PO's document linked to one of our bills lives under the PO's id, so it is found through the link.
  await fx.pool.query(`WITH gone AS (
      DELETE FROM document_links WHERE linked_entity_id IN (${parents})
        OR document_id IN (SELECT id FROM procurement_documents WHERE entity_id IN (${parents}))
      RETURNING document_id)
    DELETE FROM procurement_documents WHERE id IN (SELECT document_id FROM gone) OR entity_id IN (${parents})`, [c]);
  await fx.pool.query(
    `DELETE FROM bank_transaction_attachments WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE company_id = $1)`, [c]);
  await fx.pool.query(`UPDATE captured_documents SET matched_bank_tx_id = NULL WHERE company_id = $1`, [c]);
  await fx.pool.query(`UPDATE supplier_invoices SET source_document_id = NULL WHERE company_id = $1`, [c]);
  await fx.pool.query(`UPDATE customer_invoices SET source_document_id = NULL WHERE company_id = $1`, [c]);
  await fx.pool.query(`UPDATE gl_journal_entries SET source_document_id = NULL WHERE company_id = $1`, [c]);
  await fx.pool.query(`DELETE FROM gl_journal_document_links WHERE company_id = $1`, [c]);
}
