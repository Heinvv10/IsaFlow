/**
 * The receiver's Payments inbox (intercompany F, cash mode): the payments a payer in the group applied to bills linked to THIS company's invoices.
 * GET ?filter=open|handled&limit&offset — { items, total, openCount, enabled }. Read only; each item carries the database's state word.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { listPaymentInbox } from '@/modules/accounting/services/intercompany/paymentInbox';
import { parseInboxQuery } from '@/modules/accounting/services/intercompany/inboxValidation';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET']);
  const parsed = parseInboxQuery(req.query);
  if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);
  const { filter, limit, offset } = parsed.value;
  return apiResponse.success(res, await listPaymentInbox(req.companyId, filter, limit, offset));
}

export default withAuth(withErrorHandler(handler));
