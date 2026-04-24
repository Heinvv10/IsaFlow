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
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { logAdminAction } from '@/modules/admin/services/auditService';
import { getIp } from '@/utils/getIp';
import { parseSarsCodesXlsxBuffer } from '@/modules/admin/services/sarsCodesParser';
import {
  importRows,
  diffAgainstYear,
} from '@/modules/admin/services/sarsCodesAdminService';

export const config = { api: { bodyParser: false } };

const ALLOWED_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
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
    log.error('SARS codes upload parse failed', { error: err }, 'admin-api');
    return apiResponse.badRequest(res, 'Failed to parse upload');
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
    buffer = fs.readFileSync(uploaded.filepath);
  } catch (err) {
    log.error('Failed to read uploaded SARS file', { error: err }, 'admin-api');
    return apiResponse.badRequest(res, 'Could not read uploaded file');
  } finally {
    try { fs.unlinkSync(uploaded.filepath); } catch { /* ignore */ }
  }

  const parsed = await parseSarsCodesXlsxBuffer(buffer);
  if (parsed.errors.length > 0) {
    return apiResponse.badRequest(res, `Parse errors: ${parsed.errors.slice(0, 5).join('; ')}`);
  }
  if (parsed.rows.length === 0) {
    return apiResponse.badRequest(res, 'No rows found in Master_Codes sheet');
  }

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

  try {
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
  } catch (err) {
    log.error('SARS codes import failed', { error: err, taxYear, brsVersion }, 'admin-api');
    return apiResponse.badRequestFromError(res, err, 'Import failed');
  }
}

export default withAdmin(handler);
