/**
 * Budget grid Excel import preview (budgets P2, spec §9.2)
 * POST multipart/form-data: file (the budget template, .xlsx, ≤ 10 MB), versionId
 *   → { updatedAt, changes: [{key, before, after}], cells, counts: {added, changed, cleared, unchanged},
 *       errors: [{row, column, message}], warnings, totals: {before, after} }
 * WRITES NOTHING. The commit sends `cells` and `updatedAt` (as expectedUpdatedAt) to POST
 * budget-grid/save, the one write path. 400 for a file that is not this version's template (another
 * version or year, altered _meta, wrong month headers, too large once opened); 404 for another
 * tenant's version; writers only (a viewer is 403), since the preview exists to commit.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import formidable from 'formidable';
import fs from 'fs';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { isUuidParam } from '@/lib/validation';
import { SpreadsheetRefusedError } from '@/lib/xlsxToCsv';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { buildImportPreview } from '@/modules/accounting/services/budgets/budgetImportDiff';

export const config = { api: { bodyParser: false } };

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream', // some browsers send this for .xlsx
];

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;

  const form = formidable({
    maxFileSize: MAX_UPLOAD_BYTES, maxFiles: 1, keepExtensions: true,
    filter: (part) => !!part.mimetype && ALLOWED_MIME_TYPES.includes(part.mimetype),
  });
  let fields: formidable.Fields, files: formidable.Files;
  try {
    [fields, files] = await form.parse(req);
  } catch (err) {
    log.warn('Budget import upload refused', { error: err instanceof Error ? err.message : String(err) }, 'accounting');
    return apiResponse.badRequest(res, 'Upload one budget template (.xlsx) of at most 10 MB.');
  }
  const uploaded = files.file?.[0];
  const tempFilePath = uploaded?.filepath ?? null;

  try {
    const versionId = fields.versionId?.[0];
    if (!isUuidParam(versionId)) return apiResponse.badRequest(res, 'versionId must be a version id');
    if (!uploaded) return apiResponse.badRequest(res, 'No file uploaded: upload the budget template as .xlsx');
    const bytes = fs.readFileSync(uploaded.filepath);
    if ((uploaded.originalFilename ?? '').toLowerCase().endsWith('.xls') || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
      return apiResponse.badRequest(res, 'Old-style Excel .xls files are not supported. Save the template as .xlsx and upload again.');
    }
    try {
      return apiResponse.success(res, await buildImportPreview(companyId, versionId, bytes));
    } catch (err) {
      if (err instanceof SpreadsheetRefusedError) {
        log.warn('Budget import workbook refused', { reason: err.message }, 'accounting');
        return apiResponse.badRequest(res, err.message);
      }
      if (respondBudgetVersionError(res, err)) return;
      throw err;
    }
  } finally {
    if (tempFilePath) {
      try { fs.unlinkSync(tempFilePath); } catch (err) {
        log.warn('Could not remove budget import temp file', { error: err }, 'accounting');
      }
    }
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
