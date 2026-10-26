/**
 * Budget grid Excel import preview (budgets P2, spec §9.2)
 * POST multipart/form-data: file (the budget template, .xlsx, ≤ 10 MB), versionId (no other fields)
 *   → { updatedAt, changes: [{key, before, after}], cells, counts: {added, changed, cleared, unchanged},
 *       (each change: possibleRevert, currentChangedAt), conflicts: [{key, downloaded, current, after}],
 *       errors: [{row, column, message}], warnings,
 *       errorCount, warningCount, truncated, totals: {before, after} }
 * WRITES NOTHING. The commit sends `cells` and `updatedAt` (as expectedUpdatedAt) to POST
 * budget-grid/save, the one write path. 400 for a file that is not this version's template (another
 * version or year, altered _meta or _base, wrong month headers, damaged, too large once opened);
 * 404 for another tenant's version; writers only (a viewer is 403), since the preview exists to
 * commit. Uploads are written to a directory of this request's own, removed with everything in it
 * however the request ends: a file formidable opens after a refusal (a second file, another field
 * name) cannot be left behind. Each member may preview at most PREVIEW_RATE files per 15 minutes
 * (429), counted before the upload is read.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import formidable from 'formidable';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import { isUuidParam } from '@/lib/validation';
import { SpreadsheetRefusedError } from '@/lib/xlsxToCsv';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { buildImportPreview } from '@/modules/accounting/services/budgets/budgetImportDiff';

export const config = { api: { bodyParser: false } };

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PREVIEW_RATE = 60;
const ALLOWED_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream', // some browsers send this for .xlsx
];

/** Remove the request's upload directory; a file still opening after this fails to create. */
function removeUploads(dir: string, context: Record<string, string>): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn('Could not remove budget import upload directory', { ...context, dir, error: err }, 'accounting');
  }
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const context = { companyId, userId: (req as AuthenticatedNextApiRequest).user.id };
  if (!(await checkRateLimit(`budget-import:${companyId}:${context.userId}`, { max: PREVIEW_RATE, windowSecs: 900 }))) {
    return apiResponse.tooManyRequests(res, 'Too many import previews — wait a few minutes and try again.');
  }

  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-import-'));
  const form = formidable({
    uploadDir, maxFileSize: MAX_UPLOAD_BYTES, maxFiles: 1, maxFields: 1, maxFieldsSize: 4096, keepExtensions: true,
    filter: (part) => !!part.mimetype && ALLOWED_MIME_TYPES.includes(part.mimetype),
  });

  try {
    let fields: formidable.Fields, files: formidable.Files;
    try {
      [fields, files] = await form.parse(req);
    } catch (err) {
      log.warn('Budget import upload refused', { ...context, error: err instanceof Error ? err.message : String(err) }, 'accounting');
      return apiResponse.badRequest(res, 'Upload one budget template (.xlsx) of at most 10 MB, with its versionId and nothing else.');
    }
    const uploaded = files.file?.[0];
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
        log.warn('Budget import workbook refused', { ...context, versionId, reason: err.message }, 'accounting');
        return apiResponse.badRequest(res, err.message);
      }
      if (respondBudgetVersionError(res, err)) return;
      throw err;
    }
  } finally {
    removeUploads(uploadDir, context);
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
