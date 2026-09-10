/**
 * Customer Sales Orders Action API
 * POST { action: 'confirm', id } — confirm a draft sales order
 * POST { action: 'invoice', id } — convert confirmed SO to a customer invoice
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { confirmSalesOrder, convertSalesOrderToInvoice } from '@/modules/accounting/services/ar/salesOrderService';
import { SalesOrderNotInvoiceableError } from '@/modules/accounting/services/ar/salesOrderWorkflowService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  const { id, action } = req.body as { id?: string; action?: string };
  if (!id || !action) return apiResponse.badRequest(res, 'id and action are required');

  const userId = req.user.id;

  switch (action) {
    case 'confirm': {
      try {
        await confirmSalesOrder(companyId, id, userId);
        return apiResponse.success(res, { confirmed: true });
      } catch (err) {
        return apiResponse.badRequestFromError(res, err, 'Action failed');
      }
    }
    case 'invoice': {
      try {
        const result = await convertSalesOrderToInvoice(companyId, id, userId);
        return apiResponse.success(res, result);
      } catch (err) {
        // ONLY the pre-write refusals may be answered with a 4xx: `withAuth`
        // COMMITs the request transaction on a 4xx and ROLLBACKs only on a 5xx,
        // so the old blanket `badRequestFromError` committed whatever a
        // half-finished conversion had already written. 409 rather than 400 for
        // the status refusal, handing back the winner's invoice id.
        if (err instanceof SalesOrderNotInvoiceableError) {
          return apiResponse.conflict(res, err.message, {
            orderStatus: err.orderStatus,
            invoiceId: err.existingInvoiceId,
          });
        }
        if (err instanceof Error && err.message === 'Sales order not found') {
          return apiResponse.notFound(res, 'Sales order', id);
        }
        throw err;
      }
    }
    default:
      return apiResponse.badRequest(res, `Unknown action: ${action}`);
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
