/** POST /api/accounting/expense-claims/[id]/approve */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { claimInputVatWarnings } from '@/modules/accounting/services/expense/claimVatAdvice';
import { approveClaim, rejectClaim } from '@/modules/accounting/services/expense/expenseClaimService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id as string;
  const { companyId } = req;
  const userId = req.user?.id ?? '';
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Expense claim', id);
  if (!userId) return apiResponse.unauthorized(res);

  const body = (req.body ?? {}) as { decision?: 'approve' | 'reject'; reason?: string };

  try {
    const claim = body.decision === 'reject'
      ? await rejectClaim(id, companyId, userId, body.reason ?? 'Rejected')
      : await approveClaim(id, companyId, userId);
    if (!claim) return apiResponse.notFound(res, 'Expense claim', id);
    // The approver is the last person who sees the claim before `postClaim`
    // debits VAT Input with the sum of the line vatAmounts. Read the advice
    // BEFORE the decision is acted on rather than after: on a rejection it is
    // moot, and on an approval it is what the approver needed to have seen.
    const warnings = body.decision === 'reject' ? [] : await claimInputVatWarnings(id, companyId);
    return apiResponse.success(res, { claim, warnings });
  } catch (err) {
    return apiResponse.badRequestFromError(res, err, 'Request failed');
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
