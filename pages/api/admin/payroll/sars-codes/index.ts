/**
 * GET /api/admin/payroll/sars-codes?taxYear=YYYY[&search=][&category=][&status=]
 *
 * Lists SARS source codes for a tax year. Read-only — mutation goes through
 * the dedicated import / release / deprecate endpoints. Admin auth required.
 */

import type { NextApiResponse } from 'next';
import { type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import { adminPositiveInt } from '@/modules/admin/middleware/adminRequestErrors';
import { apiResponse } from '@/lib/apiResponse';
import { listCodes, listReleases } from '@/modules/admin/services/sarsCodesAdminService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const taxYearParam = adminPositiveInt(req.query.taxYear, 'taxYear') ?? null;
  const releases = await listReleases();

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
}

export default withAdmin(handler);
