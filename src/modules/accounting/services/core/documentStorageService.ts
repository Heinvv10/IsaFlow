/**
 * Document Storage Service
 * File upload, magic-byte validation, auto-linking, VLM extraction, and entity ownership checks.
 * Used by pages/api/accounting/documents.ts
 */

import path from 'path';
import fs from 'fs';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { vfStorage } from '@/services/vfStorageAdapter';
import { extractFromPdf, extractFromImage } from '@/modules/accounting/services/core/ocrService';
import { isVlmAvailable } from '@/modules/accounting/services/bank/vlmService';
import { runAfterCommit } from '@/lib/afterCommit';
import type {
  LinkedDocument,
  AccountingDocumentType,
} from '@/types/procurement/document.types';

export const VALID_ENTITY_TYPES = [
  'supplier_invoice',
  'supplier_payment',
  'customer_invoice',
  'customer_payment',
  'credit_note',
] as const;

export const VALID_DOCUMENT_TYPES = [
  'proof_of_payment',
  'bank_statement',
  'remittance_advice',
  'credit_note_doc',
  'invoice',
  'receipt',
  'other',
] as const;

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

export const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export function validateMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const hex = buffer.subarray(0, 8).toString('hex').toUpperCase();
  if (hex.startsWith('FFD8FF')) return true;    // JPEG
  if (hex.startsWith('89504E47')) return true;  // PNG
  if (hex.startsWith('25504446')) return true;  // PDF
  if (hex.startsWith('504B0304')) return true;  // ZIP (docx/xlsx)
  return false;
}

export function mapRow(
  row: Record<string, unknown>,
  source: 'direct' | 'linked' = 'direct',
  linkReason?: string,
): LinkedDocument {
  return {
    id: row.id as string,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    documentType: row.document_type as AccountingDocumentType,
    documentName: row.document_name as string,
    fileUrl: row.file_url as string,
    filePath: (row.file_path as string) || undefined,
    fileSize: (row.file_size as number) || undefined,
    mimeType: (row.mime_type as string) || undefined,
    uploadedBy: row.uploaded_by as string,
    uploadedByName: (row.uploaded_by_name as string) || undefined,
    uploadedAt: new Date(row.uploaded_at as string).toISOString(),
    notes: (row.notes as string) || undefined,
    isActive: row.is_active as boolean,
    source,
    linkReason,
  };
}

/** Verify an entity belongs to the given company by checking all parent tables */
export async function verifyEntityOwnership(entityId: string, companyId: string): Promise<boolean> {
  const [owner] = await sql`
    SELECT 1 AS ok FROM sage_supplier_invoices WHERE id = ${entityId}::uuid AND company_id = ${companyId}
    UNION ALL SELECT 1 FROM customer_invoices WHERE id = ${entityId}::uuid AND company_id = ${companyId}
    UNION ALL SELECT 1 FROM supplier_payments WHERE id = ${entityId}::uuid AND company_id = ${companyId}
    UNION ALL SELECT 1 FROM customer_payments WHERE id = ${entityId}::uuid AND company_id = ${companyId}
    UNION ALL SELECT 1 FROM credit_notes WHERE id = ${entityId}::uuid AND company_id = ${companyId}
    LIMIT 1
  `;
  return !!owner;
}

export interface UploadDocumentInput {
  entityType: string;
  entityId: string;
  documentType: string;
  notes?: string;
  filePath: string;
  mimeType: string;
  size: number;
  originalFilename: string;
  uploadedBy: string;
  uploadedByName: string;
}

/** Upload file to VF Storage, insert DB record, and fire background VLM extraction */
export async function uploadDocument(input: UploadDocumentInput): Promise<LinkedDocument> {
  const {
    entityType, entityId, documentType, notes,
    filePath: tempFilePath, mimeType, size, originalFilename,
    uploadedBy, uploadedByName,
  } = input;

  const buffer = await fs.promises.readFile(tempFilePath);

  const rawName = originalFilename || `document_${Date.now()}`;
  const fileName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storageName = `${entityId}_${fileName}`;
  const result = await vfStorage.uploadFile(buffer, 'accounting', entityType, storageName);

  const [row] = await sql`
    INSERT INTO procurement_documents (
      entity_type, entity_id, document_type, document_name,
      file_url, file_path, file_size, mime_type,
      uploaded_by, uploaded_by_name, notes
    ) VALUES (
      ${entityType}, ${entityId}::uuid, ${documentType}, ${fileName},
      ${result.url}, ${result.path}, ${size}, ${mimeType},
      ${uploadedBy}, ${uploadedByName}, ${notes || null}
    )
    RETURNING *
  `;

  const docId = (row as Record<string, unknown>).id as string;

  if (entityType === 'supplier_invoice') {
    await autoLinkSupplierInvoice(docId, entityId);
  }

  if (isVlmAvailable()) {
    runAfterCommit('procurement document extraction', () => extractAndStoreDocMetadata(buffer, mimeType, docId).catch(err =>
      log.warn('Background VLM extraction failed', {
        error: err instanceof Error ? err.message : String(err),
      }, 'accounting-docs'),
    ));
  }

  return mapRow(row as Record<string, unknown>, 'direct');
}

/**
 * Auto-link a newly uploaded supplier_invoice doc to related PO/GRN,
 * and create reverse links so existing PO/GRN docs appear on the invoice.
 */
export async function autoLinkSupplierInvoice(docId: string, invoiceId: string) {
  try {
    const [invoice] = await sql`
      SELECT purchase_order_id, grn_id FROM sage_supplier_invoices WHERE id = ${invoiceId}::uuid
    `;
    if (!invoice) return;

    const poId = invoice.purchase_order_id as string | null;
    const grnId = invoice.grn_id as string | null;

    if (poId) {
      await sql`
        INSERT INTO document_links (document_id, linked_entity_type, linked_entity_id, link_reason)
        VALUES (${docId}::uuid, 'purchase_order', ${poId}::uuid, 'po_invoice_link')
        ON CONFLICT (document_id, linked_entity_type, linked_entity_id) DO NOTHING
      `;
    }
    if (grnId) {
      await sql`
        INSERT INTO document_links (document_id, linked_entity_type, linked_entity_id, link_reason)
        VALUES (${docId}::uuid, 'goods_receipt_note', ${grnId}::uuid, 'grn_invoice_link')
        ON CONFLICT (document_id, linked_entity_type, linked_entity_id) DO NOTHING
      `;
    }

    if (poId) {
      const poDocs = await sql`
        SELECT id FROM procurement_documents
        WHERE entity_type = 'purchase_order' AND entity_id = ${poId}::uuid AND is_active = true
      `;
      for (const doc of poDocs) {
        await sql`
          INSERT INTO document_links (document_id, linked_entity_type, linked_entity_id, link_reason)
          VALUES (
            ${(doc as Record<string, unknown>).id as string}::uuid,
            'supplier_invoice', ${invoiceId}::uuid, 'po_invoice_link'
          )
          ON CONFLICT (document_id, linked_entity_type, linked_entity_id) DO NOTHING
        `;
      }
    }
    if (grnId) {
      const grnDocs = await sql`
        SELECT id FROM procurement_documents
        WHERE entity_type = 'goods_receipt_note' AND entity_id = ${grnId}::uuid AND is_active = true
      `;
      for (const doc of grnDocs) {
        await sql`
          INSERT INTO document_links (document_id, linked_entity_type, linked_entity_id, link_reason)
          VALUES (
            ${(doc as Record<string, unknown>).id as string}::uuid,
            'supplier_invoice', ${invoiceId}::uuid, 'grn_invoice_link'
          )
          ON CONFLICT (document_id, linked_entity_type, linked_entity_id) DO NOTHING
        `;
      }
    }
  } catch (err) {
    log.warn('Auto-link supplier invoice docs failed (non-fatal)', { error: err }, 'accounting-docs');
  }
}

/** Background VLM extraction — stores result in extracted_data JSONB column */
export async function extractAndStoreDocMetadata(buffer: Buffer, mimeType: string, docId: string) {
  const isPdf = mimeType === 'application/pdf';
  const isImage = mimeType.startsWith('image/');

  if (!isPdf && !isImage) return;

  const extracted = isPdf
    ? await extractFromPdf(buffer)
    : await extractFromImage(buffer, mimeType);

  if (extracted && extracted.confidence > 0) {
    await sql`
      UPDATE procurement_documents
      SET extracted_data = ${JSON.stringify(extracted)}::jsonb
      WHERE id = ${docId}::uuid
    `;
    log.info('VLM extraction stored for document', { docId, confidence: extracted.confidence }, 'accounting-docs');
  }
}
