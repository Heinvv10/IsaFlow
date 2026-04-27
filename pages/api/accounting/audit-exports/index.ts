/**
 * /api/accounting/audit-exports
 *   GET  — list exports for this company
 *   POST — create + immediately build a new export
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listExports,
  createExport,
  buildExport,
} from '@/modules/accounting/services/capture/auditTrailExportService';

interface CreateBody {
  periodStart?: string;
  periodEnd?: string;
  includeSourceDocs?: boolean;
  expiresAt?: string | null;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const exports = await listExports(companyId);
    return apiResponse.success(res, { exports, total: exports.length });
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as CreateBody;
    if (!body.periodStart || !body.periodEnd) {
      return apiResponse.badRequest(res, 'periodStart and periodEnd are required (YYYY-MM-DD)');
    }

    const draft = await createExport({
      companyId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      includeSourceDocs: body.includeSourceDocs,
      requestedBy: req.user?.id ?? null,
      expiresAt: body.expiresAt ?? null,
    });

    // Build synchronously so the UI sees ready|failed immediately — typical
    // period has <1000 JEs so PDF build is <5s.
    try {
      const built = await buildExport(draft.id, companyId);
      return apiResponse.created(res, { export: built });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return apiResponse.badRequest(res, `Build failed: ${msg}`);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
