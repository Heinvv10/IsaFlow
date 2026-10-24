/**
 * Document Capture API
 * POST /api/accounting/document-capture  — Upload PDF or image; the row is saved as 'reading' and read in the background
 * GET  /api/accounting/document-capture  — List captured documents (`?id=<uuid>` returns one, company-scoped;
 *      `?attachable=1` lists only those the provisional evidence attach accepts)
 *
 * A long digital PDF takes the VLM 70-104 s and Cloudflare cuts a request at 100 s, so the upload answers at once
 * (201 `{ document }`, readState 'reading') and `runCaptureRead` fills the row after COMMIT. Clients poll `?id=`.
 *
 * The upload is STORED before the answer (as /capture/upload does: insert with the hash and size, store the bytes,
 * write the pointer), so the job reads it back from Storage and a failed read can be retried (action 'retry').
 * If Storage fails the request fails 500 and the withAuth transaction rolls the row back. The reverse leaves an
 * orphan: the object is uploaded before COMMIT, so a failure after it (the pointer write, or COMMIT itself) leaves
 * an object in the bucket under `<companyId>/<documentId>` that no row points to. Harmless, and the same as the
 * existing upload route; nothing sweeps them.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { runAfterCommit } from '@/lib/afterCommit';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { sha256, storeCapturedBytes } from '@/lib/documentStorage';
import { checkAiRateLimit, checkRateLimit } from '@/lib/rateLimit';
import { magicBytesMatchMime } from '@/lib/fileMagic';
import { mapCapturedDocumentRow as mapRow } from '@/modules/accounting/services/capture/capturedDocumentMapper';
import { runCaptureRead } from '@/modules/accounting/services/capture/captureReadJob';
import { STALE_AFTER_MINUTES } from '@/modules/accounting/services/capture/captureReadState';
import {
  ALLOWED_MIME_TYPES, MAX_FILE_SIZE, parseUploadForm, uploadedBuffer,
} from '@/modules/accounting/services/capture/captureUploadForm';

export const config = {
  api: { bodyParser: false },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads in flight per company. SOFT: the count and the insert are not serialised, so uploads racing the count can
 * exceed it (a handful at most; the rate limit bounds a burst).
 */
const MAX_READS_IN_FLIGHT = 5;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

/** GET — List captured documents */
async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const status = req.query.status as string | undefined;
  const id = req.query.id;

  if (id !== undefined) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return apiResponse.badRequest(res, 'id must be a UUID');
    const [row] = await sql`
      SELECT * FROM captured_documents WHERE id = ${id}::UUID AND company_id = ${companyId}
    ` as Record<string, unknown>[];
    if (!row) return apiResponse.notFound(res, 'Document', id);
    return apiResponse.success(res, mapRow(row));
  }

  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || '25'), 10)));
  const offset = (page - 1) * pageSize;

  let rows: Record<string, unknown>[];
  let countResult: Record<string, unknown>[];

  if (req.query.attachable === '1') {
    // What the provisional evidence attach accepts (claimCapturedDocumentForPosting): not
    // posted, not rejected, read finished. And only supplier evidence: not our own sent
    // invoices, sent emails or dunning letters, and not a bank or supplier statement (a
    // supplier statement has no document_type; its reconciliation points at it).
    rows = await sql`
      SELECT cd.* FROM captured_documents cd
      WHERE cd.company_id = ${companyId} AND cd.posted_at IS NULL AND cd.status <> 'rejected' AND cd.read_state = 'done'
        AND cd.document_type IS DISTINCT FROM 'sent_invoice' AND cd.document_type IS DISTINCT FROM 'outbound_email'
        AND cd.document_type IS DISTINCT FROM 'dunning' AND cd.document_type IS DISTINCT FROM 'statement'
        AND NOT EXISTS (SELECT 1 FROM bank_statement_imports b WHERE b.source_document_id = cd.id AND b.company_id = cd.company_id)
        AND NOT EXISTS (SELECT 1 FROM supplier_statement_reconciliations r
                        WHERE r.source_document_id = cd.id AND r.company_id = cd.company_id)
      ORDER BY cd.created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    ` as Record<string, unknown>[];

    countResult = await sql`
      SELECT COUNT(*)::int AS total FROM captured_documents cd
      WHERE cd.company_id = ${companyId} AND cd.posted_at IS NULL AND cd.status <> 'rejected' AND cd.read_state = 'done'
        AND cd.document_type IS DISTINCT FROM 'sent_invoice' AND cd.document_type IS DISTINCT FROM 'outbound_email'
        AND cd.document_type IS DISTINCT FROM 'dunning' AND cd.document_type IS DISTINCT FROM 'statement'
        AND NOT EXISTS (SELECT 1 FROM bank_statement_imports b WHERE b.source_document_id = cd.id AND b.company_id = cd.company_id)
        AND NOT EXISTS (SELECT 1 FROM supplier_statement_reconciliations r
                        WHERE r.source_document_id = cd.id AND r.company_id = cd.company_id)
    ` as Record<string, unknown>[];
  } else if (status) {
    rows = await sql`
      SELECT * FROM captured_documents
      WHERE status = ${status} AND company_id = ${companyId}
      ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    ` as Record<string, unknown>[];

    countResult = await sql`
      SELECT COUNT(*)::int AS total FROM captured_documents WHERE status = ${status} AND company_id = ${companyId}
    ` as Record<string, unknown>[];
  } else {
    rows = await sql`
      SELECT * FROM captured_documents
      WHERE company_id = ${companyId}
      ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${offset}
    ` as Record<string, unknown>[];

    countResult = await sql`
      SELECT COUNT(*)::int AS total FROM captured_documents WHERE company_id = ${companyId}
    ` as Record<string, unknown>[];
  }

  const total = (countResult[0]?.total as number) || 0;
  const documents = rows.map(r => mapRow(r));

  return apiResponse.paginated(res, documents, { page, pageSize, total });
}

/** POST — Upload a PDF or image, save it as a 'reading' row and read it after COMMIT */
async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const user = (req as NextApiRequest & { user: { id: string } }).user;

  // Bounds EVERY upload request, including one that ends in a 400 below: buffering a 10 MB body costs memory whether or
  // not it is valid, and the AI limiter further down is charged only for a request that gets as far as a read.
  if (!(await checkRateLimit(`upload:document-capture:co:${companyId}`, { max: 60, windowSecs: 900 }))) {
    return apiResponse.tooManyRequests(res, 'Too many uploads — wait a few minutes and try again.');
  }

  try {
    const { files } = await parseUploadForm(req);

    const fileField = files.file;
    const file = Array.isArray(fileField) ? fileField[0] : fileField;

    if (!file) {
      return apiResponse.badRequest(res, 'No file uploaded. Please select a PDF or image file.');
    }

    const mimeType = file.mimetype || '';
    const fileTypeKey = ALLOWED_MIME_TYPES[mimeType];

    if (!fileTypeKey) {
      const supported = Object.keys(ALLOWED_MIME_TYPES).join(', ');
      return apiResponse.badRequest(res, `Unsupported file type: ${mimeType}. Supported: ${supported}`);
    }

    if (file.size > MAX_FILE_SIZE) {
      return apiResponse.badRequest(res, `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }

    const buffer = uploadedBuffer(file);
    if (!buffer || buffer.length === 0) {
      return apiResponse.badRequest(res, 'Failed to read uploaded file');
    }

    // Cross-validate actual file bytes against the declared MIME — prevents polyglot
    // files from reaching the OCR pipeline.
    if (!magicBytesMatchMime(buffer, mimeType)) {
      return apiResponse.badRequest(res, 'File content does not match declared type');
    }

    const [inFlight] = await sql`
      SELECT COUNT(*)::int AS n FROM captured_documents
      WHERE company_id = ${companyId} AND read_state = 'reading'
        AND COALESCE(read_heartbeat_at, created_at) > NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})
    ` as Record<string, unknown>[];
    if (Number(inFlight?.n ?? 0) >= MAX_READS_IN_FLIGHT) {
      return apiResponse.tooManyRequests(res, 'Too many documents are being read — wait for one to finish.');
    }

    // Charged last, only for a request that is valid AND has room, so no refusal above burns a unit. No refund of the
    // unused unit: the read runs after COMMIT, where use cannot be recorded (quotaCallerCensus).
    if (!(await checkAiRateLimit(req, companyId, 'document-capture', { companyMax: 30, dailyMax: 300 }))) {
      return apiResponse.tooManyRequests(res, 'AI request limit reached. Please slow down and try again later.');
    }

    log.info('Starting document capture extraction', {
      fileName: file.originalFilename,
      fileSize: file.size,
      mimeType,
      fileType: fileTypeKey,
    }, 'document-capture');

    const fileName = file.originalFilename || `capture_${Date.now()}.${fileTypeKey}`;

    const [inserted] = await sql`
      INSERT INTO captured_documents (
        company_id, file_name, file_type, file_size, document_type,
        extracted_data, status, uploaded_by, read_state, raw_bytes_sha256, raw_bytes_size
      ) VALUES (
        ${companyId},
        ${fileName},
        ${fileTypeKey},
        ${file.size},
        NULL,
        '{}'::jsonb,
        'pending',
        ${user?.id || null},
        'reading',
        ${sha256(buffer)},
        ${buffer.length}
      )
      RETURNING id
    ` as Record<string, unknown>[];
    const documentId = String(inserted?.id);

    // The AI unit above is spent even if Storage fails here (500, row rolled back): accepted, nothing refunds it.
    const stored = await storeCapturedBytes(companyId, documentId, buffer, mimeType);
    const [row] = await sql`
      UPDATE captured_documents
      SET storage_bucket = ${stored.bucket}, storage_path = ${stored.path}
      WHERE id = ${documentId}::uuid AND company_id = ${companyId}
      RETURNING *
    ` as Record<string, unknown>[];

    // The first read is attempt 0; the job loads the bytes from Storage, so the closure holds ids only.
    runAfterCommit('capture-read', () => runCaptureRead(companyId, documentId, 0));

    log.info('Document captured, read queued', { id: documentId }, 'document-capture');

    return apiResponse.created(res, { document: mapRow(row as Record<string, unknown>) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Document capture failed', { error: msg }, 'document-capture');

    if (msg.includes('maxFileSize')) {
      return apiResponse.badRequest(res, `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }

    return apiResponse.internalError(res, err, `Document capture failed: ${msg}`);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
