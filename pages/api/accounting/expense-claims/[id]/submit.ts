/** POST /api/accounting/expense-claims/[id]/submit */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { submitClaim } from '@/modules/accounting/services/expense/expenseClaimService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id as string;
  const { companyId } = req;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Expense claim', id);
  try {
    const claim = await submitClaim(id, companyId);
    if (!claim) return apiResponse.notFound(res, 'Expense claim', id);
    return apiResponse.success(res, { claim });
  } catch (err) {
    return apiResponse.badRequestFromError(res, err, 'Request failed');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
