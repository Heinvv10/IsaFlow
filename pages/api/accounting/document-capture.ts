/**
 * Document Capture API
 * POST /api/accounting/document-capture  — Upload PDF or image; the row is saved as 'reading' and read in the background
 * GET  /api/accounting/document-capture  — List captured documents (`?id=<uuid>` returns one, company-scoped)
 *
 * A long digital PDF takes the VLM 70-104 s and Cloudflare cuts a request at 100 s, so the upload answers at once
 * (201 `{ document }`, readState 'reading') and `runCaptureRead` fills the row after COMMIT. Clients poll `?id=`.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { runAfterCommit } from '@/lib/afterCommit';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { checkAiRateLimit } from '@/lib/rateLimit';
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

  if (status) {
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

    // Charged only for a request that will start a read, so a 400 above costs no unit. No refund of the unused
    // unit: the read runs after COMMIT, where use cannot be recorded (quotaCallerCensus).
    if (!(await checkAiRateLimit(req, companyId, 'document-capture', { companyMax: 30, dailyMax: 300 }))) {
      return apiResponse.tooManyRequests(res, 'AI request limit reached. Please slow down and try again later.');
    }

    const [inFlight] = await sql`
      SELECT COUNT(*)::int AS n FROM captured_documents
      WHERE company_id = ${companyId} AND read_state = 'reading'
        AND COALESCE(read_heartbeat_at, created_at) > NOW() - make_interval(mins => ${STALE_AFTER_MINUTES})
    ` as Record<string, unknown>[];
    if (Number(inFlight?.n ?? 0) >= MAX_READS_IN_FLIGHT) {
      return apiResponse.tooManyRequests(res, 'Too many documents are being read — wait for one to finish.');
    }

    log.info('Starting document capture extraction', {
      fileName: file.originalFilename,
      fileSize: file.size,
      mimeType,
      fileType: fileTypeKey,
    }, 'document-capture');

    const fileName = file.originalFilename || `capture_${Date.now()}.${fileTypeKey}`;

    const [row] = await sql`
      INSERT INTO captured_documents (
        company_id, file_name, file_type, file_size, document_type,
        extracted_data, status, uploaded_by, read_state
      ) VALUES (
        ${companyId},
        ${fileName},
        ${fileTypeKey},
        ${file.size},
        NULL,
        '{}'::jsonb,
        'pending',
        ${user?.id || null},
        'reading'
      )
      RETURNING *
    ` as Record<string, unknown>[];
    const documentId = String(row?.id);

    runAfterCommit('capture-read', () => runCaptureRead(companyId, documentId, buffer, mimeType));

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
