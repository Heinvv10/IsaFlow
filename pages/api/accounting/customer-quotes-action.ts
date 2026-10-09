/**
 * Customer Quotes Action API
 * POST — perform actions on a quote (send, accept, decline, convert)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  updateQuoteStatus, convertToInvoice, convertToSalesOrder, QuoteConvertedError,
} from '@/modules/accounting/services/ar/quoteService';
import { QuoteNotConvertibleError, QuoteNotInvoiceableError } from '@/modules/accounting/services/ar/quoteConvertService';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);

  const { companyId } = req as CompanyAuthedRequest;
  const { id, action } = req.body;
  if (!id || !action) return apiResponse.badRequest(res, 'id and action are required');

  const userId = req.user.id;

  // R-035 PR4 round 2: a converted quote is terminal — 409, nothing written.
  const setStatus = async (status: string) => {
    try {
      const quote = await updateQuoteStatus(companyId, id, status);
      if (!quote) return apiResponse.notFound(res, 'Quote', id);
      return apiResponse.success(res, quote);
    } catch (err) {
      if (err instanceof QuoteConvertedError) return apiResponse.conflict(res, err.message, { quoteStatus: err.quoteStatus });
      throw err;
    }
  };

  switch (action) {
    case 'send':
      return setStatus('sent');
    case 'accept':
      return setStatus('accepted');
    case 'decline':
      return setStatus('declined');
    case 'convert': {
      try {
        const result = await convertToInvoice(companyId, id, userId);
        if (!result) return apiResponse.notFound(res, 'Quote', id);
        return apiResponse.success(res, result);
      } catch (err) {
        // 409, not 400: the quote exists, its status just forbids the
        // conversion — including the double-click case, where the winner's
        // invoice id is handed back so the client can open it. The refusal is
        // raised before the sequence is touched, so this 4xx (which `withAuth`
        // COMMITs) commits nothing.
        // A line account the invoice could never post to: refused before the claim, so nothing is written.
        if (err instanceof InvoiceLineCodingRefusal) return apiResponse.badRequest(res, err.message, { code: err.code });
        if (err instanceof QuoteNotInvoiceableError) {
          return apiResponse.conflict(res, err.message, {
            quoteStatus: err.quoteStatus,
            invoiceId: err.existingInvoiceId,
          });
        }
        throw err;
      }
    }
    case 'convert-to-order': {
      try {
        const result = await convertToSalesOrder(companyId, id, userId);
        if (!result) return apiResponse.notFound(res, 'Quote', id);
        return apiResponse.success(res, { salesOrderId: result.salesOrderId });
      } catch (err) {
        // 409, not 404: the quote exists, its status just forbids the
        // conversion — including the double-click case, where the winner's
        // order id is handed back so the client can open it instead of being
        // told its quote does not exist. Nothing is written before the guard
        // refuses, so answering 4xx here commits no partial work.
        if (err instanceof QuoteNotConvertibleError) {
          return apiResponse.conflict(res, err.message, {
            quoteStatus: err.quoteStatus,
            salesOrderId: err.existingOrderId,
          });
        }
        throw err;
      }
    }
    default:
      return apiResponse.badRequest(res, `Unknown action: ${action}`);
  }
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
