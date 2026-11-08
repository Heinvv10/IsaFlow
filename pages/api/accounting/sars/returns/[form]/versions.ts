/**
 * GET /api/accounting/sars/returns/[form]/versions?periodStart=&periodEnd=  (form = vat201 | emp201)
 * Every version of the return with its drift (re-generated now vs finalised), whether its VAT lock
 * was removed outside the lifecycle, and the vat_returns record beside it. Read-only.
 * Per-payment directive rows are withheld from roles that cannot write, as sars-emp201 does.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { canWrite } from '@/lib/auth/writeRoles';
import { isValidDate } from '@/lib/validation';
import { listVersions } from '@/modules/accounting/services/returns/returnDrift';
import { returnFormOf } from '@/modules/accounting/services/returns/returnForm';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const form = returnFormOf(req.query.form);
  if (!form) return apiResponse.notFound(res, 'Return form');
  const { periodStart, periodEnd } = req.query;
  if (typeof periodStart !== 'string' || typeof periodEnd !== 'string'
    || !isValidDate(periodStart) || !isValidDate(periodEnd) || periodEnd < periodStart) {
    return apiResponse.badRequest(res, 'periodStart and periodEnd are required (YYYY-MM-DD), end not before start');
  }
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const result = await listVersions(companyId, form, periodStart, periodEnd);
  if (!canWrite(companyRole)) {
    for (const v of result.versions) delete v.figures.directivePayments;
  }
  return apiResponse.success(res, result);
}

export default withAuth(withErrorHandler(handler));
