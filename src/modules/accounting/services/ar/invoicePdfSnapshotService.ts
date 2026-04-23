/**
 * Invoice PDF Snapshot Service — PRD-06 Phase 1
 *
 * Seals the rendered PDF at approve/send so the document an auditor sees in
 * three years is byte-identical to what the customer received. The snapshot is
 * a captured_documents row (document_type='sent_invoice') whose id is stamped
 * back onto customer_invoices.source_document_id.
 *
 * Idempotent: a second call on an already-snapshotted invoice returns the
 * cached metadata without re-rendering or re-uploading.
 */
import crypto from 'node:crypto';

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  CUSTOMER_INVOICES_BUCKET,
  uploadCustomerInvoicePdf,
} from '@/lib/supabaseStorage';

import { generateInvoicePdf } from './invoicePdfBuilder';

export interface InvoiceSnapshot {
  invoiceId: string;
  documentId: string;
  bucket: string;
  path: string;
  sha256: string;
  renderedAt: Date;
  bytesLength: number;
  wasExisting: boolean;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Snapshot (or fetch existing) the sealed PDF for a customer invoice.
 *
 * Write ordering:
 *   1. SELECT the invoice + any existing snapshot pointers (company-scoped).
 *   2. If already snapshotted, return.
 *   3. Render PDF. Hash.
 *   4. INSERT captured_documents row → documentId.
 *   5. Upload bytes to storage at `${companyId}/${documentId}.pdf`.
 *   6. UPDATE captured_documents with storage pointer.
 *   7. UPDATE customer_invoices with source_document_id + pdf metadata.
 */
export async function snapshotInvoicePdf(
  companyId: string,
  invoiceId: string,
): Promise<InvoiceSnapshot> {
  const rows = (await sql`
    SELECT id, company_id, invoice_number,
           source_document_id,
           rendered_pdf_storage_path,
           rendered_pdf_sha256,
           rendered_pdf_rendered_at
    FROM customer_invoices
    WHERE id = ${invoiceId}::uuid
      AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as DbRow[];

  const row = rows[0];
  if (!row) {
    throw new Error(`Invoice not found: ${invoiceId}`);
  }

  if (row.source_document_id && row.rendered_pdf_storage_path && row.rendered_pdf_sha256) {
    const renderedAt =
      row.rendered_pdf_rendered_at instanceof Date
        ? row.rendered_pdf_rendered_at
        : new Date(String(row.rendered_pdf_rendered_at));

    return {
      invoiceId,
      documentId: String(row.source_document_id),
      bucket: CUSTOMER_INVOICES_BUCKET,
      path: String(row.rendered_pdf_storage_path),
      sha256: String(row.rendered_pdf_sha256),
      renderedAt,
      bytesLength: 0,
      wasExisting: true,
    };
  }

  const buffer = await generateInvoicePdf(companyId, invoiceId);
  const hash = sha256(buffer);
  const size = buffer.length;
  const invoiceNumber = String(row.invoice_number ?? invoiceId);
  const fileName = `${invoiceNumber}.pdf`;

  const inserted = (await sql`
    INSERT INTO captured_documents (
      company_id, file_name, file_type, file_size,
      document_type, status, notes, uploaded_by,
      raw_bytes_sha256, raw_bytes_size
    ) VALUES (
      ${companyId}::uuid,
      ${fileName},
      'pdf',
      ${size},
      'sent_invoice',
      'matched',
      ${`AR snapshot for invoice ${invoiceNumber}`},
      null,
      ${hash},
      ${size}
    )
    RETURNING id
  `) as DbRow[];

  const documentId = String(inserted[0]!.id);

  const { path } = await uploadCustomerInvoicePdf(companyId, documentId, buffer);

  await sql`
    UPDATE captured_documents
    SET storage_bucket = ${CUSTOMER_INVOICES_BUCKET},
        storage_path   = ${path}
    WHERE id = ${documentId}::uuid
      AND company_id = ${companyId}::uuid
  `;

  const renderedAt = new Date();
  await sql`
    UPDATE customer_invoices
    SET source_document_id        = ${documentId}::uuid,
        rendered_pdf_storage_path = ${path},
        rendered_pdf_sha256       = ${hash},
        rendered_pdf_rendered_at  = ${renderedAt.toISOString()}
    WHERE id = ${invoiceId}::uuid
      AND company_id = ${companyId}::uuid
  `;

  log.info(
    'Invoice PDF snapshot sealed',
    { companyId, invoiceId, documentId, bytes: size, sha256: hash },
    'invoicePdfSnapshot',
  );

  return {
    invoiceId,
    documentId,
    bucket: CUSTOMER_INVOICES_BUCKET,
    path,
    sha256: hash,
    renderedAt,
    bytesLength: size,
    wasExisting: false,
  };
}

/**
 * Fetch the sealed PDF bytes + metadata for an invoice. If no snapshot exists,
 * returns null so the caller can decide whether to fall back to on-demand
 * render.
 */
export async function getSealedInvoicePdf(
  companyId: string,
  invoiceId: string,
): Promise<{ bucket: string; path: string; sha256: string; renderedAt: Date } | null> {
  const rows = (await sql`
    SELECT rendered_pdf_storage_path,
           rendered_pdf_sha256,
           rendered_pdf_rendered_at
    FROM customer_invoices
    WHERE id = ${invoiceId}::uuid
      AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as DbRow[];

  const row = rows[0];
  if (!row || !row.rendered_pdf_storage_path) return null;

  const renderedAt =
    row.rendered_pdf_rendered_at instanceof Date
      ? row.rendered_pdf_rendered_at
      : new Date(String(row.rendered_pdf_rendered_at));

  return {
    bucket: CUSTOMER_INVOICES_BUCKET,
    path: String(row.rendered_pdf_storage_path),
    sha256: String(row.rendered_pdf_sha256),
    renderedAt,
  };
}
