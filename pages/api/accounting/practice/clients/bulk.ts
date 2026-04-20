/**
 * Practice Clients Bulk Actions API
 * POST /api/accounting/practice/clients/bulk
 *
 * Body shapes:
 *   { action: 'export', ids?: string[] }
 *     → text/csv response (filtered by ids if provided, otherwise all)
 *
 *   { action: 'import', csv: string }
 *     → JSON: { created, skipped, errors[] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import {
  bulkExportClients,
  bulkImportClients,
  buildClientsCsv,
  parseClientsCsv,
} from '@/modules/accounting/services/practice/practiceClientBulkService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2 MB safety cap

interface BulkBody {
  action?: 'export' | 'import';
  ids?: unknown;
  csv?: unknown;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const body = (req.body ?? {}) as BulkBody;
  const action = body.action;

  if (action !== 'export' && action !== 'import') {
    return apiResponse.badRequest(res, "action must be 'export' or 'import'");
  }

  // ─── export ─────────────────────────────────────────────────────────────────
  if (action === 'export') {
    let ids: string[] | undefined;
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids)) {
        return apiResponse.badRequest(res, 'ids must be an array');
      }
      if (!body.ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
        return apiResponse.badRequest(res, 'One or more ids are invalid UUIDs');
      }
      ids = body.ids as string[];
    }

    const rows = await bulkExportClients(companyId, ids);
    const csv = buildClientsCsv(rows);
    log.info('Practice clients bulk export', { companyId, count: rows.length }, 'practice');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="practice-clients-export.csv"');
    res.status(200).end(csv);
    return;
  }

  // ─── import ─────────────────────────────────────────────────────────────────
  const csv = typeof body.csv === 'string' ? body.csv : '';
  if (csv.trim() === '') {
    return apiResponse.badRequest(res, 'csv body is required for import');
  }
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    return apiResponse.badRequest(res, 'CSV exceeds 2 MB limit');
  }

  const parsed = parseClientsCsv(csv);
  if (parsed.errors.length > 0 && parsed.rows.length === 0) {
    return apiResponse.success(res, { created: 0, skipped: 0, errors: parsed.errors });
  }

  const result = await bulkImportClients(companyId, parsed.rows);
  return apiResponse.success(res, {
    created: result.created,
    skipped: result.skipped,
    errors: [...parsed.errors, ...result.errors],
  });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
