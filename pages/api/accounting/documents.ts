/**
 * Accounting Documents API
 * GET  /api/accounting/documents?entity_type=...&entity_id=...  — List documents
 * POST /api/accounting/documents  (multipart form-data)          — Upload document
 * DELETE /api/accounting/documents?id=...                        — Soft-delete document
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import formidable from 'formidable';
import fs from 'fs';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import type { AccountingEntityType } from '@/types/procurement/document.types';
import {
  VALID_ENTITY_TYPES,
  VALID_DOCUMENT_TYPES,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  validateMagicBytes,
  mapRow,
  verifyEntityOwnership,
  uploadDocument,
} from '@/modules/accounting/services/core/documentStorageService';

export const config = {
  api: { bodyParser: false },
};

function parseForm(req: NextApiRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({ maxFileSize: MAX_FILE_SIZE, keepExtensions: true });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const user = (req as NextApiRequest & { user: { id: string; name: string; email: string } }).user;

  if (req.method === 'GET') return handleGet(req, res, companyId);
  if (req.method === 'POST') return handlePost(req, res, user, companyId);
  if (req.method === 'DELETE') return handleDelete(req, res, companyId);

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

/** GET — List direct + cross-linked documents for an accounting entity */
async function handleGet(req: NextApiRequest, res: NextApiResponse, companyId: string) {
  const entityType = req.query.entity_type as string;
  const entityId = req.query.entity_id as string;

  if (!entityType || !entityId) {
    return apiResponse.badRequest(res, 'Missing required query params: entity_type, entity_id');
  }
  if (!VALID_ENTITY_TYPES.includes(entityType as AccountingEntityType)) {
    return apiResponse.badRequest(res, `Invalid entity_type. Allowed: ${VALID_ENTITY_TYPES.join(', ')}`);
  }

  const owned = await verifyEntityOwnership(entityId, companyId);
  if (!owned) return apiResponse.forbidden(res, 'Entity does not belong to your company');

  const directRows = await sql`
    SELECT * FROM procurement_documents
    WHERE entity_type = ${entityType}
      AND entity_id = ${entityId}::uuid
      AND is_active = true
    ORDER BY uploaded_at DESC
  `;

  const linkedRows = await sql`
    SELECT pd.*, dl.link_reason
    FROM document_links dl
    JOIN procurement_documents pd ON pd.id = dl.document_id
    WHERE dl.linked_entity_type = ${entityType}
      AND dl.linked_entity_id = ${entityId}::uuid
      AND pd.is_active = true
    ORDER BY pd.uploaded_at DESC
  `;

  const results = [
    ...directRows.map(r => mapRow(r as Record<string, unknown>, 'direct')),
    ...linkedRows.map(r => mapRow(r as Record<string, unknown>, 'linked', (r as Record<string, unknown>).link_reason as string)),
  ];

  return apiResponse.success(res, results);
}

/** POST — Upload a document to an accounting entity */
async function handlePost(
  req: NextApiRequest,
  res: NextApiResponse,
  user: { id: string; name: string; email: string },
  companyId: string,
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
    if (!VALID_DOCUMENT_TYPES.includes(documentType as typeof VALID_DOCUMENT_TYPES[number])) {
      return apiResponse.badRequest(res, `Invalid document_type. Allowed: ${VALID_DOCUMENT_TYPES.join(', ')}`);
    }

    const owned = await verifyEntityOwnership(entityId, companyId);
    if (!owned) return apiResponse.forbidden(res, 'Entity does not belong to your company');

    const fileField = files.file;
    const file = Array.isArray(fileField) ? fileField[0] : fileField;
    if (!file) return apiResponse.badRequest(res, 'No file uploaded');

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

    const doc = await uploadDocument({
      entityType, entityId, documentType, notes,
      filePath: file.filepath,
      mimeType: file.mimetype || '',
      size: file.size,
      originalFilename: file.originalFilename || `document_${Date.now()}`,
      uploadedBy: user.email,
      uploadedByName: user.name,
    });

    log.info('Accounting document uploaded', {
      data: { entityType, entityId, documentType },
    }, 'accounting-docs');

    return apiResponse.created(res, doc);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error('Accounting document upload error', { error }, 'accounting-docs');
    return apiResponse.internalError(res, error, `Failed to upload document: ${errMsg}`);
  } finally {
    if (tempFilePath) {
      await fs.promises.unlink(tempFilePath).catch((e) =>
        log.debug('Temp file cleanup failed', { error: e instanceof Error ? e.message : 'unknown' }, 'accounting'),
      );
    }
  }
}

/** DELETE — Soft-delete a document */
async function handleDelete(req: NextApiRequest, res: NextApiResponse, companyId: string) {
  const id = req.query.id as string;
  if (!id) return apiResponse.badRequest(res, 'Missing required query param: id');

  const [doc] = await sql`
    SELECT entity_id FROM procurement_documents WHERE id = ${id}::uuid AND is_active = true
  `;
  if (!doc) return apiResponse.notFound(res, 'Document', id);

  const owned = await verifyEntityOwnership(doc.entity_id as string, companyId);
  if (!owned) return apiResponse.forbidden(res, 'Document does not belong to your company');

  const [row] = await sql`
    UPDATE procurement_documents
    SET is_active = false
    WHERE id = ${id}::uuid AND is_active = true
    RETURNING id
  `;

  if (!row) return apiResponse.notFound(res, 'Document', id);

  log.info('Accounting document soft-deleted', { data: { id } }, 'accounting-docs');
  return apiResponse.success(res, { id: row.id, deleted: true });
}

export default withCompany(withErrorHandler(withCsrf(withWriteAccess(handler))));
