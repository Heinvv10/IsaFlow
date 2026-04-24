/** POST /api/accounting/expense-claims/[id]/post */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { postClaimToGl } from '@/modules/accounting/services/expense/expenseClaimService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PostBody {
  reimbursementAccountId?: string;
  vatInputAccountId?: string | null;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  const id = req.query.id as string;
  const { companyId } = req;
  const userId = req.user?.id ?? '';
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Expense claim', id);
  if (!userId) return apiResponse.unauthorized(res);

  const body = (req.body ?? {}) as PostBody;
  if (!body.reimbursementAccountId) {
    return apiResponse.badRequest(res, 'reimbursementAccountId is required');
  }

  try {
    const claim = await postClaimToGl(id, companyId, {
      userId,
      reimbursementAccountId: body.reimbursementAccountId,
      vatInputAccountId: body.vatInputAccountId ?? null,
    });
    if (!claim) return apiResponse.notFound(res, 'Expense claim', id);
    return apiResponse.success(res, { claim });
  } catch (err) {
    return apiResponse.badRequestFromError(res, err, 'Request failed');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
