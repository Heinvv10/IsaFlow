/**
 * The receiver's allocation inbox (intercompany P4-C): the payments a payer in the group applied to bills linked to THIS company's invoices.
 * GET ?filter=open|handled&limit&offset — { items, total, allocationCount }. Read only; each item says whether the payer's books still say
 * what the message says (live / liveReason) and what does not fit this company's invoice (mismatch). Not in the Bills badge (inbox-count).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listAllocationInbox } from '@/modules/accounting/services/intercompany/allocationInbox';
import { parseInboxQuery } from '@/modules/accounting/services/intercompany/inboxValidation';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const parsed = parseInboxQuery(req.query);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  const { filter, limit, offset } = parsed.value;
  return apiResponse.success(res, await listAllocationInbox(req.companyId, filter, limit, offset));
}

export default withAuth(withErrorHandler(handler));
