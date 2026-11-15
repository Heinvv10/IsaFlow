/**
 * POST /api/admin/payroll/sars-codes/import
 *
 * multipart/form-data:
 *   file:        XLSX (curated SARS PAYE-AE-06-G06 master)
 *   taxYear:     YYYY
 *   brsVersion:  e.g. v25.2.0
 *   setCurrent:  '1' to mark this release as current, anything else to leave alone
 *   dryRun:      '1' to parse + diff only, no DB writes
 *
 * Returns { upserted, diff, setCurrent, effectiveYear, brsVersion }.
 */

import type { NextApiResponse } from 'next';
import formidable from 'formidable';
import fs from 'node:fs';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { assertNoNulInAdminBody } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { magicBytesMatchMime } from '@/lib/fileMagic';
import { parseSarsCodesXlsxBuffer, SarsWorkbookUnreadableError } from '@/modules/admin/services/sarsCodesParser';
import {
  importRows,
  diffAgainstYear,
} from '@/modules/admin/services/sarsCodesAdminService';

export const config = { api: { bodyParser: false } };

// application/octet-stream is deliberately excluded — it's the wildcard many
// clients send for any binary and would neutralize this allowlist. The
// magic-byte check below is the real gate against non-XLSX payloads.
//
// application/vnd.ms-excel (legacy CFBF .xls) is also excluded: the magic-byte
// gate has no CFBF branch and parseSarsCodesXlsxBuffer (ExcelJS xlsx.load) can't
// read .xls anyway, so a real .xls upload would always 400 at the gate below —
// keeping it in the allowlist was dead code.
const ALLOWED_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const form = formidable({
    maxFileSize: 5 * 1024 * 1024,
    keepExtensions: true,
    filter: (part) => !!part.mimetype && ALLOWED_MIME.includes(part.mimetype),
  });

  let fields: formidable.Fields, files: formidable.Files;
  try {
    [fields, files] = await form.parse(req);
  } catch (err) {
    // formidable refusing the upload (size, type, a malformed body) carries a 4xx httpCode: the caller's request.
    const httpCode = (err as { httpCode?: unknown } | null)?.httpCode;
    if (typeof httpCode === 'number' && httpCode >= 400 && httpCode < 500) {
      log.warn('SARS codes upload refused', { httpCode }, 'admin-api');
      return apiResponse.badRequest(res, 'Failed to parse upload');
    }
    throw err;
  }

  const pickField = (name: string): string | undefined => {
    const v = fields[name];
    if (!v) return undefined;
    return Array.isArray(v) ? v[0] : (v as unknown as string);
  };

  const taxYearStr = pickField('taxYear');
  const brsVersion = pickField('brsVersion')?.trim();
  const setCurrent = pickField('setCurrent') === '1';
  const dryRun = pickField('dryRun') === '1';

  const taxYear = taxYearStr ? Number(taxYearStr) : NaN;
  if (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > 2100) {
    return apiResponse.badRequest(res, 'taxYear must be a valid year (2000–2100)');
  }
  if (!brsVersion) {
    return apiResponse.badRequest(res, 'brsVersion is required');
  }

  const uploaded = Array.isArray(files.file) ? files.file[0] : files.file;
  if (!uploaded) {
    return apiResponse.badRequest(res, 'No file uploaded');
  }

  let buffer: Buffer;
  try {
    // Our own temp file: failing to read it is a server fault (500), not the caller's.
    buffer = fs.readFileSync(uploaded.filepath);
  } finally {
    try {
      fs.unlinkSync(uploaded.filepath);
    } catch (err) {
      // The upload is already read (or failed to be): a temp file left behind is not the request's failure.
      log.warn('SARS import: could not remove the uploaded temp file', { error: err instanceof Error ? err.message : String(err) }, 'admin-sars-import');
    }
  }

  // Multipart fields never reach withAdmin's JSON-body walk (bodyParser is off): a NUL or lone surrogate in
  // brsVersion was a 500 from Postgres (breaker #1405 round 3). After the temp file is gone, so a refusal leaks none.
  assertNoNulInAdminBody(fields, 'fields');

  // Cross-validate actual file bytes against the declared MIME — XLSX is a ZIP/OOXML
  // container (PK\x03\x04 signature), so this rejects any non-ZIP payload that slipped
  // past the client-controlled mimetype allowlist.
  const mimeType = uploaded.mimetype ?? '';
  if (!magicBytesMatchMime(buffer, mimeType)) {
    return apiResponse.badRequest(res, 'File content does not match declared type');
  }

  let parsed: Awaited<ReturnType<typeof parseSarsCodesXlsxBuffer>>;
  try {
    parsed = await parseSarsCodesXlsxBuffer(buffer);
  } catch (err) {
    // A PK-signed file that is not a readable zip: the caller's file (400). Any other failure is a 500.
    if (err instanceof SarsWorkbookUnreadableError) return apiResponse.badRequest(res, err.message);
    throw err;
  }
  if (parsed.errors.length > 0) {
    return apiResponse.badRequest(res, `Parse errors: ${parsed.errors.slice(0, 5).join('; ')}`);
  }
  if (parsed.rows.length === 0) {
    return apiResponse.badRequest(res, 'No rows found in Master_Codes sheet');
  }
  // The sheet's cells are the caller's text too.
  assertNoNulInAdminBody(parsed.rows, 'rows');

  if (dryRun) {
    const diff = await diffAgainstYear(parsed.rows, taxYear - 1);
    return apiResponse.success(res, {
      effectiveYear: taxYear,
      brsVersion,
      upserted: 0,
      diff,
      setCurrent: false,
      dryRun: true,
      rowCount: parsed.rows.length,
    });
  }

  const result = await importRows({
    rows: parsed.rows,
    effectiveYear: taxYear,
    brsVersion,
    setCurrent,
    importedBy: req.user.id,
  });

  await logAdminAction(
    req.user.id,
    'sars_codes.import',
    'sars_code_release',
    String(taxYear),
    {
      brs_version: brsVersion,
      rows: result.upserted,
      added: result.diff.added.length,
      removed: result.diff.removed.length,
      changed: result.diff.changed.length,
      set_current: setCurrent,
    },
    getIp(req)
  );

  log.info('SARS codes imported', {
    adminUserId: req.user.id,
    taxYear,
    brsVersion,
    rows: result.upserted,
  }, 'admin-api');

  return apiResponse.success(res, result);
}

export default withAdmin(withCsrf(handler));
