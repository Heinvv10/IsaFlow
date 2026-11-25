/**
 * Intercompany inbox (P2): the invoice / credit-note messages other companies sent THIS company.
 * GET ?filter=open|handled&limit&offset — the page (items, total, openCount). The Bills tab badge reads inbox-count.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listInbox } from '@/modules/accounting/services/intercompany/inboxRead';
import { parseInboxQuery } from '@/modules/accounting/services/intercompany/inboxValidation';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const parsed = parseInboxQuery(req.query);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  const { filter, limit, offset } = parsed.value;
  return apiResponse.success(res, await listInbox(req.companyId, filter, limit, offset));
}

export default withAuth(withErrorHandler(handler));
