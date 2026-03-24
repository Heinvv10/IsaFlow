/**
 * Customer Quotes Action API
 * POST — perform actions on a quote (send, accept, decline, convert)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { updateQuoteStatus, convertToInvoice } from '@/modules/accounting/services/quoteService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);

  const { id, action } = req.body;
  if (!id || !action) return apiResponse.badRequest(res, 'id and action are required');

  const userId = req.user.id;

  switch (action) {
    case 'send': {
      const quote = await updateQuoteStatus(id, 'sent');
      if (!quote) return apiResponse.notFound(res, 'Quote', id);
      return apiResponse.success(res, quote);
    }
    case 'accept': {
      const quote = await updateQuoteStatus(id, 'accepted');
      if (!quote) return apiResponse.notFound(res, 'Quote', id);
      return apiResponse.success(res, quote);
    }
    case 'decline': {
      const quote = await updateQuoteStatus(id, 'declined');
      if (!quote) return apiResponse.notFound(res, 'Quote', id);
      return apiResponse.success(res, quote);
    }
    case 'convert': {
      const result = await convertToInvoice(id, userId);
      if (!result) return apiResponse.badRequest(res, 'Quote must be accepted to convert');
      return apiResponse.success(res, result);
    }
    default:
      return apiResponse.badRequest(res, `Unknown action: ${action}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
