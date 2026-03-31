/**
 * Accounting Documents API
 * GET  /api/accounting/documents?entity_type=...&entity_id=...  — List documents (direct + cross-linked)
 * POST /api/accounting/documents  (multipart form-data)          — Upload document
 * DELETE /api/accounting/documents?id=...                        — Soft-delete document
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import path from 'path';
import { sql } from '@/lib/neon';
import formidable from 'formidable';
import fs from 'fs';
import { vfStorage } from '@/services/vfStorageAdapter';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import type {
  ProcurementDocument,
  LinkedDocument,
  AccountingEntityType,
  AccountingDocumentType,
} from '@/types/procurement/document.types';
import { extractFromPdf, extractFromImage } from '@/modules/accounting/services/ocrService';
import { isVlmAvailable } from '@/modules/accounting/services/vlmService';

export const config = {
  api: { bodyParser: false },
};

const VALID_ENTITY_TYPES: AccountingEntityType[] = [
  'supplier_invoice',
  'supplier_payment',
  'customer_invoice',
  'customer_payment',
  'credit_note',
];

const VALID_DOCUMENT_TYPES: AccountingDocumentType[] = [
  'proof_of_payment',
  'bank_statement',
  'remittance_advice',
  'credit_note_doc',
  'invoice',
  'receipt',
  'other',
];

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

function validateMagicBytes(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const hex = buffer.subarray(0, 8).toString('hex').toUpperCase();
  if (hex.startsWith('FFD8FF')) return true;   // JPEG
  if (hex.startsWith('89504E47')) return true;  // PNG
  if (hex.startsWith('25504446')) return true;  // PDF
  if (hex.startsWith('504B0304')) return true;  // ZIP (docx/xlsx)
  return false;
}

function parseForm(req: NextApiRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({ maxFileSize: MAX_FILE_SIZE, keepExtensions: true });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function mapRow(row: Record<string, unknown>, source: 'direct' | 'linked' = 'direct', linkReason?: string): LinkedDocument {
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

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = (req as NextApiRequest & { user: { id: string; name: string; email: string } }).user;

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res, user);
  if (req.method === 'DELETE') return handleDelete(req, res);

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

/** GET — List direct + cross-linked documents for an accounting entity */
async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const entityType = req.query.entity_type as string;
  const entityId = req.query.entity_id as string;

  if (!entityType || !entityId) {
    return apiResponse.badRequest(res, 'Missing required query params: entity_type, entity_id');
  }

  if (!VALID_ENTITY_TYPES.includes(entityType as AccountingEntityType)) {
    return apiResponse.badRequest(res, `Invalid entity_type. Allowed: ${VALID_ENTITY_TYPES.join(', ')}`);
  }

  // Direct documents
  const directRows = await sql`
    SELECT * FROM procurement_documents
    WHERE entity_type = ${entityType}
      AND entity_id = ${entityId}::uuid
      AND is_active = true
    ORDER BY uploaded_at DESC
  `;

  // Cross-linked documents (via document_links)
  const linkedRows = await sql`
    SELECT pd.*, dl.link_reason
    FROM document_links dl
    JOIN procurement_documents pd ON pd.id = dl.document_id
    WHERE dl.linked_entity_type = ${entityType}
      AND dl.linked_entity_id = ${entityId}::uuid
      AND pd.is_active = true
    ORDER BY pd.uploaded_at DESC
  `;

  const results: LinkedDocument[] = [
    ...directRows.map(r => mapRow(r as Record<string, unknown>, 'direct')),
    ...linkedRows.map(r => mapRow(r as Record<string, unknown>, 'linked', (r as Record<string, unknown>).link_reason as string)),
  ];

  return apiResponse.success(res, results);
}

/** POST — Upload a document to an accounting entity */
async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  user: { id: string; name: string; email: string }
) {
  let tempFilePath: string | null = null;

  try {
    const { fields, files } = await parseForm(req);

    const entityType = (Array.isArray(fields.entity_type) ? fields.entity_type[0] : fields.entity_type) as string;
    const entityId = (Array.isArray(fields.entity_id) ? fields.entity_id[0] : fields.entity_id) as string;
    const documentType = ((Array.isArray(fields.document_type) ? fields.document_type[0] : fields.document_type) || 'other') as string;
    const notes = (Array.isArray(fields.notes) ? fields.notes[0] : fields.notes) as string | undefined;

    if (!entityType || !entityId) {
      return apiResponse.badRequest(res, 'Missing required fields: entity_type, entity_id');
    }
    if (!VALID_ENTITY_TYPES.includes(entityType as AccountingEntityType)) {
      return apiResponse.badRequest(res, `Invalid entity_type. Allowed: ${VALID_ENTITY_TYPES.join(', ')}`);
    }
    if (!VALID_DOCUMENT_TYPES.includes(documentType as AccountingDocumentType)) {
      return apiResponse.badRequest(res, `Invalid document_type. Allowed: ${VALID_DOCUMENT_TYPES.join(', ')}`);
    }

    const fileField = files.file;
    const file = Array.isArray(fileField) ? fileField[0] : fileField;
    if (!file) {
      return apiResponse.badRequest(res, 'No file uploaded');
    }

    tempFilePath = file.filepath;

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype || '')) {
      return apiResponse.badRequest(res, `File type not allowed: ${file.mimetype}. Allowed: PDF, JPEG, PNG, DOCX, XLSX`);
    }
    if (file.size > MAX_FILE_SIZE) {
      return apiResponse.badRequest(res, 'File too large. Maximum size: 20MB');
    }

    const buffer = await fs.promises.readFile(file.filepath);
    if (!validateMagicBytes(buffer)) {
      return apiResponse.badRequest(res, 'File content does not match declared type');
    }

    // Upload to VF Storage: accounting/{entity_type}/{entityId}_{filename}
    const rawName = file.originalFilename || `document_${Date.now()}`;
    const fileName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storageName = `${entityId}_${fileName}`;
    const result = await vfStorage.uploadFile(buffer, 'accounting', entityType, storageName);

    // Insert DB record
    const [row] = await sql`
      INSERT INTO procurement_documents (
        entity_type, entity_id, document_type, document_name,
        file_url, file_path, file_size, mime_type,
        uploaded_by, uploaded_by_name, notes
      ) VALUES (
        ${entityType}, ${entityId}::uuid, ${documentType}, ${fileName},
        ${result.url}, ${result.path}, ${file.size}, ${file.mimetype || ''},
        ${user.email}, ${user.name}, ${notes || null}
      )
      RETURNING *
    `;

    const docId = (row as Record<string, unknown>).id as string;

    // Auto-link: if supplier_invoice, create cross-links to PO/GRN
    if (entityType === 'supplier_invoice') {
      await autoLinkSupplierInvoice(docId, entityId);
    }

    // Fire-and-forget VLM extraction (non-blocking)
    if (isVlmAvailable()) {
      extractAndStoreDocMetadata(buffer, file.mimetype || '', docId).catch(err =>
        log.warn('Background VLM extraction failed', { error: err instanceof Error ? err.message : String(err) }, 'accounting-docs')
      );
    }

    log.info('Accounting document uploaded', {
      data: { entityType, entityId, documentType, fileName },
    }, 'accounting-docs');

    return apiResponse.created(res, mapRow(row as Record<string, unknown>, 'direct'));
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error('Accounting document upload error', { error }, 'accounting-docs');
    return apiResponse.internalError(res, error, `Failed to upload document: ${errMsg}`);
  } finally {
    if (tempFilePath) {
      await fs.promises.unlink(tempFilePath).catch((e) =>
        log.debug('Temp file cleanup failed', { error: e instanceof Error ? e.message : 'unknown' }, 'accounting')
      );
    }
  }
}

/**
 * Auto-link a newly uploaded supplier_invoice doc to related PO/GRN,
 * and create reverse links so existing PO/GRN docs appear on the invoice.
 */
async function autoLinkSupplierInvoice(docId: string, invoiceId: string) {
  try {
    // Look up FK references on the invoice
    const [invoice] = await sql`
      SELECT purchase_order_id, grn_id
      FROM sage_supplier_invoices
      WHERE id = ${invoiceId}::uuid
    `;

    if (!invoice) return;

    const poId = invoice.purchase_order_id as string | null;
    const grnId = invoice.grn_id as string | null;

    // Forward links: this doc -> PO/GRN
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

    // Reverse links: existing PO/GRN docs -> this invoice
    if (poId) {
      const poDocs = await sql`
        SELECT id FROM procurement_documents
        WHERE entity_type = 'purchase_order' AND entity_id = ${poId}::uuid AND is_active = true
      `;
      for (const doc of poDocs) {
        await sql`
          INSERT INTO document_links (document_id, linked_entity_type, linked_entity_id, link_reason)
          VALUES (${(doc as Record<string, unknown>).id as string}::uuid, 'supplier_invoice', ${invoiceId}::uuid, 'po_invoice_link')
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
          VALUES (${(doc as Record<string, unknown>).id as string}::uuid, 'supplier_invoice', ${invoiceId}::uuid, 'grn_invoice_link')
          ON CONFLICT (document_id, linked_entity_type, linked_entity_id) DO NOTHING
        `;
      }
    }
  } catch (err) {
    log.warn('Auto-link supplier invoice docs failed (non-fatal)', { error: err }, 'accounting-docs');
  }
}

/** Background VLM extraction — stores result in extracted_data JSONB column */
async function extractAndStoreDocMetadata(buffer: Buffer, mimeType: string, docId: string) {
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

/** DELETE — Soft-delete a document */
async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  const id = req.query.id as string;
  if (!id) {
    return apiResponse.badRequest(res, 'Missing required query param: id');
  }

  const [row] = await sql`
    UPDATE procurement_documents
    SET is_active = false
    WHERE id = ${id}::uuid AND is_active = true
    RETURNING id
  `;

  if (!row) {
    return apiResponse.notFound(res, 'Document', id);
  }

  log.info('Accounting document soft-deleted', { data: { id } }, 'accounting-docs');
  return apiResponse.success(res, { id: row.id, deleted: true });
}

export default withCompany(withErrorHandler(handler as any));
