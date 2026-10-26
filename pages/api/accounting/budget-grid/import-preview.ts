/**
 * Budget grid Excel import preview (budgets P2, spec §9.2)
 * POST JSON { versionId, fileName?, fileData } — fileData is the budget template (.xlsx, at most
 *   MAX_FILE_BYTES once decoded) as base64; no other keys
 *   → { updatedAt, changes: [{key, before, after}], cells, counts: {added, changed, cleared, unchanged},
 *       (each change: possibleRevert, currentChangedAt), conflicts: [{key, downloaded, current, after}],
 *       errors: [{row, column, message}], warnings,
 *       errorCount, warningCount, truncated, totals: {before, after} }
 * WRITES NOTHING. The commit sends `cells` and `updatedAt` (as expectedUpdatedAt) to POST
 * budget-grid/save, the one write path, in chunks of at most MAX_SAVE_CELLS, each with the token
 * the save before it returned. 400 for a body that is not this shape (or not base64, or a file
 * over MAX_FILE_BYTES), and for a file that is not this version's template (another version or
 * year, altered _meta or _base, wrong month headers, damaged, too large once opened); 404 for
 * another tenant's version or a version whose financial year is gone; writers only (a viewer is
 * 403), since the preview exists to commit.
 *
 * Order (round 9, R2/R5): Next's body parser reads the JSON (at most 14 MB, `config`) before
 * withAuth, holding no pool connection. The spreadsheet work takes a slot of
 * BUDGET_SPREADSHEET_SLOT OUTSIDE withAuth (503 + Retry-After when none is free), so a queued
 * preview holds no connection either. Inside: CSRF, write access, then the user's preview bucket
 * (PREVIEW_RATE per 15 minutes across all their companies, 429), then the version is confirmed
 * before the file is decoded or parsed. The file is never written to disk. `fileData` is the key
 * the request log's body scrubber omits (sanitizeRequestBody), so a logged body never holds it.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import { UUID } from '@/lib/schemas/common';
import { SpreadsheetRefusedError } from '@/lib/xlsxToCsv';
import { BUDGET_SPREADSHEET_SLOT, withCpuSlot } from '@/lib/withCpuSlot';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { buildImportPreview } from '@/modules/accounting/services/budgets/budgetImportDiff';

/** A 10 MB file is ~13.4 MB of base64; the rest of the body is two short strings. */
export const config = { api: { bodyParser: { sizeLimit: '14mb' } } };

/** The decoded file: a 10 MB template, and room for a re-save's growth. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024 + 64 * 1024;
const PREVIEW_RATE = 60;
/** Standard base64, padded (what FileReader / btoa give); checked in one linear pass. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const PreviewSchema = z.object({
  // Ids compare lower-case everywhere (Postgres answers them so); an upper-case one is the same id.
  versionId: UUID.transform((id) => id.toLowerCase()),
  fileName: z.string().max(255).optional(),
  fileData: z.string().min(1).max(Math.ceil(MAX_FILE_BYTES / 3) * 4),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || '', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const context = { companyId, userId: (req as AuthenticatedNextApiRequest).user.id };
  if (!(await checkRateLimit(`budget-import:${context.userId}`, { max: PREVIEW_RATE, windowSecs: 900 }))) {
    res.setHeader('Retry-After', '900');
    return apiResponse.tooManyRequests(res, 'Too many import previews — wait a few minutes and try again.');
  }
  const refuse = (why: string, message: string) => {
    log.warn('Budget import upload refused', { ...context, reason: why }, 'accounting');
    return apiResponse.badRequest(res, message);
  };
  const parsed = PreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return refuse('body shape', `Send { versionId, fileName?, fileData } with the budget template (.xlsx, at most ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB) as base64, and nothing else.`);
  }
  const { versionId, fileName, fileData } = parsed.data;
  if (fileData.length % 4 !== 0 || !BASE64.test(fileData)) return refuse('not base64', 'fileData must be the file as standard base64.');
  const bytes = Buffer.from(fileData, 'base64');
  if (bytes.length > MAX_FILE_BYTES) return refuse('file too large', `The file is larger than ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB. Split it and import each part.`);
  if ((fileName ?? '').toLowerCase().endsWith('.xls') || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    return apiResponse.badRequest(res, 'Old-style Excel .xls files are not supported. Save the template as .xlsx and upload again.');
  }
  try {
    return apiResponse.success(res, await buildImportPreview(companyId, versionId, bytes));
  } catch (err) {
    if (err instanceof SpreadsheetRefusedError) {
      log.warn('Budget import workbook refused', { ...context, versionId, reason: err.message }, 'accounting');
      return apiResponse.badRequest(res, err.message);
    }
    if (err instanceof FiscalYearLabelUnknownError) return apiResponse.notFound(res, 'Financial year', String(err.fiscalYear));
    if (respondBudgetVersionError(res, err)) return;
    throw err;
  }
}

export default withCpuSlot(BUDGET_SPREADSHEET_SLOT, withAuth(withErrorHandler(withCsrf(withWriteAccess(handler)))));
