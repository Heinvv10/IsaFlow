/**
 * Migration Parse API
 * POST /api/accounting/migration-parse
 * Accepts multipart/form-data: file, source, fileType
 * Returns parsed accounts/customers/suppliers array.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import formidable from 'formidable';
import fs from 'fs';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  parseAccountsFile,
  parseCustomersFile,
  parseSuppliersFile,
  autoMapAccounts,
  type MigrationSource,
} from '@/modules/accounting/services/migrationParserService';

export const config = { api: { bodyParser: false } };

const VALID_SOURCES: MigrationSource[] = ['xero', 'quickbooks', 'pastel'];
const VALID_FILE_TYPES = ['accounts', 'customers', 'suppliers'] as const;
type FileType = typeof VALID_FILE_TYPES[number];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  }

  const form = formidable({ maxFileSize: 10 * 1024 * 1024, keepExtensions: true });

  const [fields, files] = await form.parse(req);
  const source = (Array.isArray(fields.source) ? fields.source[0] : fields.source) as string;
  const fileType = (Array.isArray(fields.fileType) ? fields.fileType[0] : fields.fileType) as string;

  if (!VALID_SOURCES.includes(source as MigrationSource)) {
    return apiResponse.badRequest(res, `Invalid source. Must be one of: ${VALID_SOURCES.join(', ')}`);
  }
  if (!VALID_FILE_TYPES.includes(fileType as FileType)) {
    return apiResponse.badRequest(res, `Invalid fileType. Must be one of: ${VALID_FILE_TYPES.join(', ')}`);
  }

  const uploadedFile = Array.isArray(files.file) ? files.file[0] : files.file;
  if (!uploadedFile) {
    return apiResponse.badRequest(res, 'No file uploaded');
  }

  let fileContent: string;
  try {
    fileContent = fs.readFileSync(uploadedFile.filepath, 'utf-8');
  } catch (err) {
    log.error('Failed to read uploaded file', { error: err }, 'migration');
    return apiResponse.badRequest(res, 'Could not read uploaded file');
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
