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
 * name) cannot be left behind.
 *
 * Order (round-3 N4): the upload is read BEFORE withAuth takes a pooled connection and opens the
 * request transaction (readJsonBody's withBodyFirst: at most BODY_LIMITS bytes, a total and an
 * idle deadline), so a slow client holds no connection idle in a transaction. Ahead of reading,
 * only a caller who passes the local CSRF check and holds a validly signed session is read at all
 * (withBodyFirst), and that user's preview bucket is charged (withPreviewRate: PREVIEW_RATE per 15
 * minutes across all their companies, 429). Nothing is parsed until the handler runs, after every
 * withAuth / CSRF / write-access check.
 */
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import formidable from 'formidable';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { verifyCsrf } from '@/lib/auth/csrf';
import { ACCESS_COOKIE, parseCookies } from '@/lib/auth/cookies';
import { verifyTokenSignature } from '@/lib/auth/gotrue';
import { JsonBodyError, respondBodyError, takeRawBody, withBodyFirst, type BodyLimits } from '@/lib/readJsonBody';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import { isUuidParam } from '@/lib/validation';
import { SpreadsheetRefusedError } from '@/lib/xlsxToCsv';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { buildImportPreview } from '@/modules/accounting/services/budgets/budgetImportDiff';

export const config = { api: { bodyParser: false } };

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** The file plus its multipart framing and one small field; a slow client gets 60 s, and 10 s between chunks. */
const BODY_LIMITS: BodyLimits = { maxBytes: MAX_UPLOAD_BYTES + 64 * 1024, totalMs: 60_000, idleMs: 10_000 };
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

/**
 * Charges the user's preview bucket before any of the upload is read, for a POST that passes the
 * same local gates withBodyFirst reads for (CSRF, a validly signed session); anyone else is left to
 * withAuth and withCsrf to refuse. A limiter error throws (never admits).
 */
function withPreviewRate(inner: NextApiHandler): NextApiHandler {
  return async (req, res) => {
    if (req.method === 'POST' && verifyCsrf(req)) {
      const token = parseCookies(req)[ACCESS_COOKIE];
      const userId = token ? await verifyTokenSignature(token).then((c) => c.sub, () => null) : null;
      if (userId && !(await checkRateLimit(`budget-import:${userId}`, { max: PREVIEW_RATE, windowSecs: 900 }))) {
        return apiResponse.tooManyRequests(res, 'Too many import previews — wait a few minutes and try again.');
      }
    }
    return inner(req, res);
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const context = { companyId, userId: (req as AuthenticatedNextApiRequest).user.id };
  let raw: Buffer;
  try {
    raw = await takeRawBody(req, BODY_LIMITS);
  } catch (err) {
    if (!(err instanceof JsonBodyError)) throw err;
    log.warn('Budget import upload refused', { ...context, error: err.message }, 'accounting');
    return respondBodyError(res, err);
  }

  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-import-'));
  const form = formidable({
    uploadDir, maxFileSize: MAX_UPLOAD_BYTES, maxFiles: 1, maxFields: 1, maxFieldsSize: 4096, keepExtensions: true,
    filter: (part) => !!part.mimetype && ALLOWED_MIME_TYPES.includes(part.mimetype),
  });

  try {
    let fields: formidable.Fields, files: formidable.Files;
    try {
      // The bytes withBodyFirst read, as the request formidable expects (its headers, then the body).
      [fields, files] = await form.parse(Object.assign(Readable.from([raw]), { headers: req.headers }) as unknown as NextApiRequest);
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

export default withPreviewRate(withBodyFirst(BODY_LIMITS, withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))));
