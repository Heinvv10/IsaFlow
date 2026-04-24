/**
 * GET  /api/accounting/supplier-statements          — list reconciliations
 * GET  /api/accounting/supplier-statements?supplierId=... — filter by supplier
 * POST /api/accounting/supplier-statements          — upload statement PDF + run VLM
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import formidable from 'formidable';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth/withWriteAccess';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { storeCapturedBytes } from '@/lib/documentStorage';
import { sql } from '@/lib/neon';
import {
  createReconciliation,
  listReconciliations,
} from '@/modules/accounting/services/capture/supplierStatementReconService';

export const config = { api: { bodyParser: false } };

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
];

function parseForm(req: NextApiRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    // Pentest H14: formidable was configured without a MIME filter, so disguised
    // binaries were written to temp files before the post-parse check rejected.
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      keepExtensions: true,
      filter: (part) => {
        const mime = part.mimetype ?? '';
        return !!mime && ALLOWED_MIME_TYPES.includes(mime);
      },
    });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

type DbRow = Record<string, unknown>;

async function handleGet(req: NextApiRequest, res: NextApiResponse, companyId: string) {
  const supplierId = req.query.supplierId as string | undefined;
  const reconciliations = await listReconciliations(companyId, supplierId);
  return apiResponse.success(res, reconciliations);
}

async function handlePost(req: NextApiRequest, res: NextApiResponse, companyId: string, userId: string) {
  let tempFilePath: string | null = null;

  try {
    const { fields, files } = await parseForm(req);

    const supplierId = (Array.isArray(fields.supplierId) ? fields.supplierId[0] : fields.supplierId) as string;
    if (!supplierId) return apiResponse.badRequest(res, 'Missing required field: supplierId');

    // Verify supplier belongs to this company
    const [supplier] = (await sql`
      SELECT id FROM suppliers
      WHERE id = ${supplierId}::uuid
        AND company_id = ${companyId}
        AND deleted_at IS NULL
    `) as DbRow[];
    if (!supplier) return apiResponse.notFound(res, 'Supplier', supplierId);

    const fileField = files.file;
    const file = Array.isArray(fileField) ? fileField[0] : fileField;
    if (!file) return apiResponse.badRequest(res, 'No file uploaded');

    tempFilePath = file.filepath;
    const mimeType = file.mimetype ?? 'application/octet-stream';

    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      return apiResponse.badRequest(
        res,
        `File type not allowed: ${mimeType}. Allowed: PDF, JPEG, PNG, WEBP, TIFF`,
      );
    }
    if ((file.size ?? 0) > MAX_FILE_SIZE) {
      return apiResponse.badRequest(res, 'File too large. Maximum size: 10 MB');
    }

    const buffer = await fs.promises.readFile(file.filepath);

    // Create a captured_documents row first, then store bytes
    const [docRow] = (await sql`
      INSERT INTO captured_documents
        (company_id, file_name, file_type, mime_type, source, status, created_by)
      VALUES (
        ${companyId},
        ${file.originalFilename ?? `supplier-statement-${Date.now()}`},
        ${mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1]},
        ${mimeType},
        'manual_upload',
        'pending',
        ${userId}::uuid
      )
      RETURNING id
    `) as DbRow[];

    if (!docRow) throw new Error('Failed to create captured_documents row');
    const documentId = docRow.id as string;

    const stored = await storeCapturedBytes(companyId, documentId, buffer, mimeType);

    await sql`
      UPDATE captured_documents
      SET storage_bucket   = ${stored.bucket},
          storage_path     = ${stored.path},
          raw_bytes_sha256 = ${stored.hash},
          raw_bytes_size   = ${stored.size},
          status           = 'ready'
      WHERE id = ${documentId}::uuid
    `;

    log.info('Supplier statement uploaded, starting reconciliation', {
      documentId,
      supplierId,
    }, 'supplier-stmt-api');

    const reconciliation = await createReconciliation(companyId, supplierId, documentId, userId);

    return apiResponse.created(res, reconciliation);
  } catch (error) {
    log.error('Supplier statement upload/recon error', {
      error: error instanceof Error ? error.message : String(error),
    }, 'supplier-stmt-api');
    return apiResponse.internalError(res, error, 'Failed to process supplier statement');
  } finally {
    if (tempFilePath) {
      await fs.promises
        .unlink(tempFilePath)
        .catch((e) =>
          log.debug('Temp file cleanup failed', { error: e instanceof Error ? e.message : 'unknown' }, 'supplier-stmt-api'),
        );
    }
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authed = req as CompanyAuthedRequest;
  const { companyId } = authed;
  const userId = authed.user?.id ?? '';

  if (req.method === 'GET') return handleGet(req, res, companyId);
  if (req.method === 'POST') return handlePost(req, res, companyId, userId);

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
