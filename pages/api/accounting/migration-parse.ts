/**
 * Migration Parse API
 * POST /api/accounting/migration-parse
 * Accepts multipart/form-data: file, source, fileType
 * Returns parsed accounts/customers/suppliers array.
 * CSV / text, or .xlsx (first worksheet, converted to CSV). It used to read an
 * .xlsx as UTF-8 text, so a workbook parsed as nothing. Legacy .xls is refused
 * with a message rather than parsed as garbage.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import formidable from 'formidable';
import fs from 'fs';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { looksLikeXlsx, SpreadsheetRefusedError, xlsxBufferToCsv } from '@/lib/xlsxToCsv';
import {
  parseAccountsFile,
  parseCustomersFile,
  parseSuppliersFile,
  autoMapAccounts,
  type MigrationSource,
} from '@/modules/accounting/services/core/migrationParserService';

export const config = { api: { bodyParser: false } };

const VALID_SOURCES: MigrationSource[] = ['xero', 'quickbooks', 'pastel'];
const VALID_FILE_TYPES = ['accounts', 'customers', 'suppliers'] as const;
type FileType = typeof VALID_FILE_TYPES[number];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  }

  const ALLOWED_MIME_TYPES = [
    'text/csv', 'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream', // some browsers send this for .csv
  ];
  const form = formidable({
    maxFileSize: 10 * 1024 * 1024,
    keepExtensions: true,
    filter: (part) => !!part.mimetype && ALLOWED_MIME_TYPES.includes(part.mimetype),
  });

  const [fields, files] = await form.parse(req);

  // Resolve temp file path early so cleanup runs regardless of which validation fails.
  const uploadedFile = Array.isArray(files.file) ? files.file[0] : files.file;
  const tempFilePath = uploadedFile?.filepath ?? null;

  try {
    const source = (Array.isArray(fields.source) ? fields.source[0] : fields.source) as string;
    const fileType = (Array.isArray(fields.fileType) ? fields.fileType[0] : fields.fileType) as string;

    if (!VALID_SOURCES.includes(source as MigrationSource)) {
      return apiResponse.badRequest(res, `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}`);
    }
    if (!VALID_FILE_TYPES.includes(fileType as FileType)) {
      return apiResponse.badRequest(res, `Invalid fileType. Must be one of: ${VALID_FILE_TYPES.join(', ')}`);
    }

    if (!uploadedFile) {
      return apiResponse.badRequest(res, 'No file uploaded');
    }

    let fileContent: string;
    try {
      const bytes = fs.readFileSync(uploadedFile.filepath);
      const name = (uploadedFile.originalFilename ?? '').toLowerCase();
      if (name.endsWith('.xls') || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
        return apiResponse.badRequest(res, 'Old-style Excel .xls files are not supported. Save the sheet as .xlsx or CSV and upload again.');
      }
      fileContent = looksLikeXlsx(bytes) ? await xlsxBufferToCsv(bytes) : bytes.toString('utf-8');
    } catch (err) {
      if (err instanceof SpreadsheetRefusedError) {
        log.warn('Uploaded workbook refused', { reason: err.message }, 'migration');
        return apiResponse.badRequest(res, err.message);
      }
      log.error('Failed to read uploaded file', { error: err }, 'migration');
      return apiResponse.badRequest(res, 'Could not read the uploaded file - check it is a CSV or .xlsx file and try again');
    }

    const src = source as MigrationSource;

    if (fileType === 'accounts') {
      const parsed = parseAccountsFile(src, fileContent);
      const mapped = autoMapAccounts(src, parsed);
      log.info('Parsed accounts file', { source: src, count: mapped.length }, 'migration');
      return apiResponse.success(res, { parsed: mapped, count: mapped.length });
    }

    if (fileType === 'customers') {
      const parsed = parseCustomersFile(src, fileContent);
      log.info('Parsed customers file', { source: src, count: parsed.length }, 'migration');
      return apiResponse.success(res, { parsed, count: parsed.length });
    }

    const parsed = parseSuppliersFile(src, fileContent);
    log.info('Parsed suppliers file', { source: src, count: parsed.length }, 'migration');
    return apiResponse.success(res, { parsed, count: parsed.length });
  } finally {
    // Always clean up the temp file — including on early validation failures.
    if (tempFilePath) {
      try { fs.unlinkSync(tempFilePath); } catch (err) {
        log.warn('Could not remove migration upload temp file', { error: err }, 'migration');
      }
    }
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
