/**
 * Customer Quotes Action API
 * POST — perform actions on a quote (send, accept, decline, convert)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { updateQuoteStatus, convertToInvoice, convertToSalesOrder } from '@/modules/accounting/services/ar/quoteService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const { id, action } = req.body;
  if (!id || !action) return apiResponse.badRequest(res, 'id and action are required');

  const userId = req.user.id;

  switch (action) {
    case 'send': {
      const quote = await updateQuoteStatus(companyId, id, 'sent');
      if (!quote) return apiResponse.notFound(res, 'Quote', id);
      return apiResponse.success(res, quote);
    }
    case 'accept': {
      const quote = await updateQuoteStatus(companyId, id, 'accepted');
      if (!quote) return apiResponse.notFound(res, 'Quote', id);
      return apiResponse.success(res, quote);
    }
    case 'decline': {
      const quote = await updateQuoteStatus(companyId, id, 'declined');
      if (!quote) return apiResponse.notFound(res, 'Quote', id);
      return apiResponse.success(res, quote);
    }
    case 'convert': {
      const result = await convertToInvoice(companyId, id, userId);
      if (!result) return apiResponse.badRequest(res, 'Quote must be accepted to convert');
      return apiResponse.success(res, result);
    }
    case 'convert-to-order': {
      const result = await convertToSalesOrder(companyId, id, userId);
      if (!result) return apiResponse.notFound(res, 'Quote', id);
      return apiResponse.success(res, { salesOrderId: result.salesOrderId });
    }
    default:
      return apiResponse.badRequest(res, `Unknown action: ${action}`);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
