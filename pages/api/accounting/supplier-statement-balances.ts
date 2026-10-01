import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { fmtDate } from '@/lib/fmtDate';
import { isRealCalendarDate } from '@/lib/validation';
import { getSupplierStatementBalances } from '@/modules/accounting/services/ap/supplierStatementBalancesService';

export default withAuth(withErrorHandler(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || '', ['GET']);
  const asAtDate = req.query.as_at_date ?? fmtDate(new Date());
  if (typeof asAtDate !== 'string' || !isRealCalendarDate(asAtDate)) {
    return apiResponse.badRequest(res, 'as_at_date must be a valid calendar date');
  }
  const { companyId } = req as CompanyAuthedRequest;
  return apiResponse.success(res, await getSupplierStatementBalances(companyId, asAtDate));
}));
