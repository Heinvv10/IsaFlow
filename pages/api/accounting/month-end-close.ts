import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { generateCloseChecklist, checkCompleteness, buildCloseProgressSummary } from '@/modules/accounting/services/monthEndCloseService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const checklist = generateCloseChecklist('with_payroll');
    const completeness = checkCompleteness({ hasPayrollPosted: false, hasDepreciationRun: false, hasBankRecon: false, hasVATRecon: false, hasAccruals: false });
    const progress = buildCloseProgressSummary(0, checklist.length, new Date().toISOString().slice(0, 7));
    return apiResponse.success(res, { checklist, completeness, progress });
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
}
export default withCompany(withErrorHandler(handler as any));
