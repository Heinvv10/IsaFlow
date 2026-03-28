/**
 * Document Capture API
 * POST /api/accounting/document-capture  — Upload PDF, extract data, save
 * GET  /api/accounting/document-capture  — List captured documents
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import formidable from 'formidable';
import fs from 'fs';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { extractFromPdf } from '@/modules/accounting/services/ocrService';
import type { CapturedDocument } from '@/modules/accounting/types/documentCapture.types';

export const config = {
  api: { bodyParser: false },
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function parseForm(req: NextApiRequest): Promise<{ fields: formidable.Fields; files: formidable.Files }> {
  return new Promise((resolve, reject) => {
    const form = formidable({
      maxFileSize: MAX_FILE_SIZE,
      keepExtensions: true,
      filter: (part) => {
        // Only accept PDF files
        return part.mimetype === 'application/pdf' || part.mimetype === null || part.mimetype === undefined;
      },
    });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function mapRow(row: Record<string, unknown>): CapturedDocument {
  return {
    id: row.id as string,
    fileName: row.file_name as string,
    fileType: row.file_type as string,
    fileSize: row.file_size as number | null,
    documentType: row.document_type as string | null,
    extractedData: row.extracted_data ? (typeof row.extracted_data === 'string' ? JSON.parse(row.extracted_data as string) : row.extracted_data) : null,
    vendorName: row.vendor_name as string | null,
    documentDate: row.document_date ? new Date(row.document_date as string).toISOString().split('T')[0]! : null,
    referenceNumber: row.reference_number as string | null,
    totalAmount: row.total_amount !== null && row.total_amount !== undefined ? parseFloat(String(row.total_amount)) : null,
    vatAmount: row.vat_amount !== null && row.vat_amount !== undefined ? parseFloat(String(row.vat_amount)) : null,
    status: (row.status as CapturedDocument['status']) || 'pending',
    matchedInvoiceId: row.matched_invoice_id as string | null,
    matchedBankTxId: row.matched_bank_tx_id as string | null,
    notes: row.notes as string | null,
    uploadedBy: row.uploaded_by as string | null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

/** GET — List captured documents */
async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const status = req.query.status as string | undefined;
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

/** POST — Upload a PDF, extract data, save to captured_documents */
async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const user = (req as NextApiRequest & { user: { id: string } }).user;
  let tempFilePath: string | null = null;

  try {
    const { files } = await parseForm(req);

    const fileField = files.file;
    const file = Array.isArray(fileField) ? fileField[0] : fileField;

    if (!file) {
      return apiResponse.badRequest(res, 'No file uploaded. Please select a PDF file.');
    }

    tempFilePath = file.filepath;
    const mimeType = file.mimetype || '';

    if (mimeType !== 'application/pdf') {
      return apiResponse.badRequest(res, `Only PDF files are supported. Received: ${mimeType}`);
    }

    if (file.size > MAX_FILE_SIZE) {
      return apiResponse.badRequest(res, `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }

    // Validate PDF magic bytes
    const buffer = await fs.promises.readFile(file.filepath);
    const hex = buffer.subarray(0, 4).toString('hex').toUpperCase();
    if (!hex.startsWith('25504446')) {
      return apiResponse.badRequest(res, 'File does not appear to be a valid PDF');
    }

    log.info('Starting document capture extraction', {
      fileName: file.originalFilename,
      fileSize: file.size,
    }, 'document-capture');

    // Extract data from PDF
    const extracted = await extractFromPdf(buffer);

    // Save to database
    const fileName = file.originalFilename || `capture_${Date.now()}.pdf`;

    const [row] = await sql`
      INSERT INTO captured_documents (
        company_id, file_name, file_type, file_size, document_type,
        extracted_data, vendor_name, document_date, reference_number,
        total_amount, vat_amount, status, uploaded_by
      ) VALUES (
        ${companyId},
        ${fileName},
        'pdf',
        ${file.size},
        ${extracted.documentType},
        ${JSON.stringify(extracted)}::jsonb,
        ${extracted.vendorName},
        ${extracted.date ? extracted.date : null}::date,
        ${extracted.referenceNumber},
        ${extracted.totalAmount},
        ${extracted.vatAmount},
        'pending',
        ${user?.id || null}::uuid
      )
      RETURNING *
    ` as Record<string, unknown>[];

    log.info('Document captured successfully', {
      id: row?.id,
      confidence: extracted.confidence,
      documentType: extracted.documentType,
    }, 'document-capture');

    return apiResponse.created(res, {
      document: mapRow(row as Record<string, unknown>),
      extracted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Document capture failed', { error: msg }, 'document-capture');

    if (msg.includes('maxFileSize')) {
      return apiResponse.badRequest(res, `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }

    return apiResponse.internalError(res, err, `Document capture failed: ${msg}`);
  } finally {
    if (tempFilePath) {
      await fs.promises.unlink(tempFilePath).catch((e) =>
        log.debug('Temp file cleanup failed', { error: e instanceof Error ? e.message : 'unknown' }, 'document-capture')
      );
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
