/**
 * Customer Sales Orders Action API
 * POST { action: 'confirm', id } — confirm a draft sales order
 * POST { action: 'invoice', id } — convert confirmed SO to a customer invoice
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { confirmSalesOrder, convertSalesOrderToInvoice } from '@/modules/accounting/services/ar/salesOrderService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { id, action } = req.body as { id?: string; action?: string };
  if (!id || !action) return apiResponse.badRequest(res, 'id and action are required');

  const userId = req.user.id;

  switch (action) {
    case 'confirm': {
      try {
        await confirmSalesOrder(companyId, id, userId);
        return apiResponse.success(res, { confirmed: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return apiResponse.badRequest(res, msg);
      }
    }
    case 'invoice': {
      try {
        const result = await convertSalesOrderToInvoice(companyId, id, userId);
        return apiResponse.success(res, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return apiResponse.badRequest(res, msg);
      }
    }
    default:
      return apiResponse.badRequest(res, `Unknown action: ${action}`);
  }
}

export default withCompany(withErrorHandler(withCsrf(withWriteAccess(handler))));
