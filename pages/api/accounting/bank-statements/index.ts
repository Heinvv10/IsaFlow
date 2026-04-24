/**
 * GET  /api/accounting/bank-statements       — list imports
 * POST /api/accounting/bank-statements       — upload PDF + trigger extraction
 *
 * POST body: multipart/form-data
 *   file         — PDF (or image) of the bank statement
 *   bankAccountId — UUID of the GL bank account
 */

import type { NextApiResponse } from 'next';
import { Writable } from 'stream';
import formidable from 'formidable';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { sha256, storeCapturedBytes } from '@/lib/documentStorage';
import {
  createImportFromDocument,
  listImports,
} from '@/modules/accounting/services/bank/bankStatementOcrService';

export const config = { api: { bodyParser: false } };

const MAX_FILE_SIZE = 10 * 1024 * 1024;

const ALLOWED_MIME_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
};

const fileBuffers = new WeakMap<formidable.File, Buffer>();

type DbRow = Record<string, unknown>;

function parseForm(req: import('next').NextApiRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      keepExtensions: true,
      filter: (part) => {
        // Reject parts without a declared MIME — pentest H13.
        const mime = part.mimetype ?? '';
        return !!mime && mime in ALLOWED_MIME_TYPES;
      },
      fileWriteStreamHandler: (file) => {
        const chunks: Buffer[] = [];
        const writable = new Writable({
          write(chunk, _enc, cb) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            cb();
          },
          final(cb) {
            fileBuffers.set(file as unknown as formidable.File, Buffer.concat(chunks));
            cb();
          },
        });
        return writable;
      },
    });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function firstField(fields: formidable.Fields, key: string): string | null {
  const v = fields[key];
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v ?? null;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user.id;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const imports = await listImports(companyId);
    return apiResponse.success(res, imports);
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);

  let fields: formidable.Fields;
  let files: formidable.Files;
  try {
    ({ fields, files } = await parseForm(req));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('maxFileSize')) return apiResponse.badRequest(res, `File too large. Max ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    return apiResponse.badRequest(res, `Upload parse error: ${msg}`);
  }

  const bankAccountId = firstField(fields, 'bankAccountId');
  if (!bankAccountId) return apiResponse.badRequest(res, 'bankAccountId is required');

  // Verify bank account belongs to company
  const acctRows = (await sql`
    SELECT id FROM gl_accounts
    WHERE id = ${bankAccountId}::uuid AND company_id = ${companyId}
    LIMIT 1
  `) as DbRow[];
  if (acctRows.length === 0) return apiResponse.notFound(res, 'Bank account not found');

  const fileField = files.file ?? files.files;
  const fileList = Array.isArray(fileField) ? fileField : fileField ? [fileField] : [];
  if (fileList.length === 0) return apiResponse.badRequest(res, 'No file uploaded');

  const file = fileList[0]!;
  const mimeType = file.mimetype ?? '';
  const fileTypeKey = ALLOWED_MIME_TYPES[mimeType];
  if (!fileTypeKey) return apiResponse.badRequest(res, `Unsupported file type: ${mimeType}`);

  const buffer = fileBuffers.get(file);
  if (!buffer || buffer.length === 0) return apiResponse.badRequest(res, 'Empty file');

  const fileName = file.originalFilename || `bank_statement_${Date.now()}.${fileTypeKey}`;
  const hash = sha256(buffer);

  // Create captured_documents row
  const docRows = (await sql`
    INSERT INTO captured_documents (
      company_id, file_name, file_type, file_size,
      document_type, status, uploaded_by,
      raw_bytes_sha256, raw_bytes_size
    ) VALUES (
      ${companyId}, ${fileName}, ${fileTypeKey}, ${file.size},
      'statement', 'pending', ${userId}::uuid,
      ${hash}, ${buffer.length}
    )
    RETURNING id
  `) as DbRow[];

  const documentId = docRows[0]!.id as string;
  const stored = await storeCapturedBytes(companyId, documentId, buffer, mimeType);

  await sql`
    UPDATE captured_documents
    SET storage_bucket = ${stored.bucket},
        storage_path   = ${stored.path}
    WHERE id = ${documentId}::uuid AND company_id = ${companyId}
  `;

  log.info('bank-statements/index: document stored, starting extraction', { companyId, documentId, bankAccountId }, 'bank-stmt-api');

  const imp = await createImportFromDocument(companyId, bankAccountId, documentId, userId);

  return apiResponse.created(res, imp);
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
