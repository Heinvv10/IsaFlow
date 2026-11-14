/**
 * Accounting Documents API
 * GET  /api/accounting/documents?entity_type=...&entity_id=...  — List documents
 *
 * entity_type is a bill, invoice, credit note, payment — or a BANK LINE (`bank_transaction`, entity_id = the line's id),
 * routed internally to the bank-tx attachment storage, so one endpoint serves every entity type. The old
 * /api/accounting/bank-tx-attachments keeps working on the same rows.
 * POST /api/accounting/documents  (multipart form-data)          — Upload document
 * DELETE /api/accounting/documents?id=...                        — Soft-delete document
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import formidable from 'formidable';
import fs from 'fs';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { listEntityDocuments } from '@/modules/accounting/services/core/documentQueryService';
import {
  VALID_DOCUMENT_TYPES,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE,
  verifyEntityOwnership,
  uploadDocument,
} from '@/modules/accounting/services/core/documentStorageService';
import {
  DOCUMENT_ENTITY_TYPES,
  bankTxBelongsToCompany,
  fromStoredAttachment,
  isBankEntityType,
  listBankLineDocuments,
} from '@/modules/accounting/services/core/bankLineDocumentRouting';
import { ATTACHMENT_MIME_TYPES, addBankTxAttachment, type AttachmentMime } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { scheduleAttachmentExtraction } from '@/modules/accounting/services/bank/bankTxAttachmentExtraction';
import { magicBytesMatchMime } from '@/lib/fileMagic';
import { parsePagination } from '@/lib/pagination';
import { isValidUUID } from '@/lib/validation';

/** A bank line's file cap — the same 2 MB as /api/accounting/bank-tx-attachments. */
const MAX_BANK_FILE_BYTES = 2 * 1024 * 1024;
/** The same cap as attach_entity_document; the stored name gains at most the 7-character upload_ prefix. */
const MAX_BANK_FILE_NAME = 200;

export const config = {
  api: { bodyParser: false },
};

/**
 * `bank` is known from the QUERY (?entity_type=bank_transaction): a bank line's limits (2 MB, PDF/JPEG/PNG) then apply
 * BEFORE anything is buffered. When the type arrives only in the form body the post-parse checks in handlePost apply.
 */
function parseForm(req: NextApiRequest, bank: boolean): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  const allowed: readonly string[] = bank ? ATTACHMENT_MIME_TYPES : ALLOWED_MIME_TYPES;
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: bank ? MAX_BANK_FILE_BYTES : MAX_FILE_SIZE,
      keepExtensions: true,
      // Reject parts with no MIME or an unrecognised MIME before buffering to disk — H13.
      filter: (part) => {
        const mime = part.mimetype || '';
        return !!mime && allowed.includes(mime);
      },
    });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
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

  if (isBankEntityType(entityType) && !isValidUUID(entityId)) {
    return apiResponse.badRequest(res, 'entity_id must be the bank transaction id');
  }

  // P3.4: entity-scoped, so normally small — the cap is insurance against a
  // single entity accumulating unbounded attachments. Applied per query; the
  // merged response is at most 2xlimit.
  const { limit, offset } = parsePagination(req.query, 200, 500);

  // The query itself lives in documentQueryService so audit_trail's companion
  // MCP tools read the same rows through the same ownership fence.
  const result = isBankEntityType(entityType)
    ? await listBankLineDocuments(companyId, entityId, limit, offset)
    : await listEntityDocuments(companyId, entityType, entityId, limit, offset);
  if (!result.ok) {
    return result.reason === 'invalid_entity_type'
      ? apiResponse.badRequest(res, `Invalid entity_type. Allowed: ${DOCUMENT_ENTITY_TYPES.join(', ')}`)
      : apiResponse.forbidden(res, 'Entity does not belong to your company');
  }

  return apiResponse.success(res, result.documents, undefined, 200, {
    limit, offset, hasMore: result.hasMore,
  });
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
    const { fields, files } = await parseForm(req, isBankEntityType(req.query.entity_type));

    const entityType = (Array.isArray(fields.entity_type) ? fields.entity_type[0] : fields.entity_type) as string;
    const entityId = (Array.isArray(fields.entity_id) ? fields.entity_id[0] : fields.entity_id) as string;
    const documentType = ((Array.isArray(fields.document_type) ? fields.document_type[0] : fields.document_type) || 'other') as string;
    const notes = (Array.isArray(fields.notes) ? fields.notes[0] : fields.notes) as string | undefined;

    if (!entityType || !entityId) {
      return apiResponse.badRequest(res, 'Missing required fields: entity_type, entity_id');
    }
    if (!(DOCUMENT_ENTITY_TYPES as readonly string[]).includes(entityType)) {
      return apiResponse.badRequest(res, `Invalid entity_type. Allowed: ${DOCUMENT_ENTITY_TYPES.join(', ')}`);
    }
    if (!VALID_DOCUMENT_TYPES.includes(documentType as typeof VALID_DOCUMENT_TYPES[number])) {
      return apiResponse.badRequest(res, `Invalid document_type. Allowed: ${VALID_DOCUMENT_TYPES.join(', ')}`);
    }

    if (isBankEntityType(entityType) && !isValidUUID(entityId)) {
      return apiResponse.badRequest(res, 'entity_id must be the bank transaction id');
    }
    const owned = isBankEntityType(entityType)
      ? await bankTxBelongsToCompany(companyId, entityId)
      : await verifyEntityOwnership(entityId, companyId);
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
    // Cross-validate actual bytes against the claimed MIME — prevents a ZIP/OOXML
    // from masquerading as image/jpeg by passing the allowlist check alone.
    if (!magicBytesMatchMime(buffer, file.mimetype || '')) {
      return apiResponse.badRequest(res, 'File content does not match declared type');
    }

    // A bank line's files live in their own store; document_type and notes have no column there and are not kept.
    if (isBankEntityType(entityType)) {
      const mime = file.mimetype || '';
      if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime)) {
        return apiResponse.badRequest(res, `A bank transaction takes ${ATTACHMENT_MIME_TYPES.join(', ')}; got ${mime}`);
      }
      const fileName = file.originalFilename || `document_${Date.now()}`;
      if (fileName.length > MAX_BANK_FILE_NAME) {
        return apiResponse.badRequest(res, `File name exceeds ${MAX_BANK_FILE_NAME} characters`);
      }
      const stored = await addBankTxAttachment(companyId, {
        bankTransactionId: entityId,
        fileName,
        mimeType: mime as AttachmentMime,
        bytes: buffer,
        maxBytes: MAX_BANK_FILE_BYTES,
        uploadedBy: user.id,
      });
      if (!stored.ok) {
        return stored.reason === 'bank_tx_not_found'
          ? apiResponse.forbidden(res, 'Entity does not belong to your company')
          : apiResponse.badRequest(res, `Attachment refused: ${stored.reason}`);
      }
      // The old /bank-tx-attachments POST extracts after commit; so does this one.
      scheduleAttachmentExtraction(buffer, mime, stored.attachment.id, companyId);
      log.info('Bank line document uploaded', { data: { entityId } }, 'accounting-docs');
      return apiResponse.created(res, fromStoredAttachment(stored.attachment));
    }

    const doc = await uploadDocument({
      companyId, entityType, entityId, documentType, notes,
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
    log.error('Accounting document upload error', { error }, 'accounting-docs');
    // A file over the size limit is the caller's, not a server fault; nothing else of the error (a Postgres message,
    // a path) goes to the client — it is in the log above.
    if (error instanceof Error && 'httpCode' in error && error.httpCode === 413) {
      return apiResponse.badRequest(res, 'File too large');
    }
    return apiResponse.internalError(res, error, 'Failed to upload document');
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

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
