/**
 * GET /api/admin/payroll/sars-codes?taxYear=YYYY[&search=][&category=][&status=]
 *
 * Lists SARS source codes for a tax year. Read-only — mutation goes through
 * the dedicated import / release / deprecate endpoints. Admin auth required.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { listCodes, listReleases } from '@/modules/admin/services/sarsCodesAdminService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const releases = await listReleases();

    const taxYearParam = req.query.taxYear ? Number(req.query.taxYear) : null;
    const taxYear =
      taxYearParam ??
      releases.find((r) => r.is_current)?.effective_year ??
      releases[0]?.effective_year;

    if (!taxYear) {
      return apiResponse.success(res, { releases: [], codes: [], taxYear: null });
    }

    const codes = await listCodes(taxYear, {
      search: req.query.search as string | undefined,
      category: req.query.category as string | undefined,
      status: req.query.status as string | undefined,
    });

    return apiResponse.success(res, { releases, codes, taxYear });
  } catch (err) {
    log.error('Failed to list SARS codes', { error: err }, 'admin-api');
    return apiResponse.badRequest(res, 'Failed to list SARS codes');
  }
}

export default withAdmin(handler);
