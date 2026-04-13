/**
 * Supplier Invoice Actions API
 * POST /api/accounting/supplier-invoices-action
 *   action: approve | cancel | match
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  approveSupplierInvoice,
  cancelSupplierInvoice,
  performThreeWayMatch,
} from '@/modules/accounting/services/ap/supplierInvoiceService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  try {
    const { action, invoiceId } = req.body;
    const userId = req.user.id;

    if (!action || !invoiceId) {
      return apiResponse.badRequest(res, 'action and invoiceId are required');
    }

    switch (action) {
      case 'approve': {
        const invoice = await approveSupplierInvoice(companyId, invoiceId, userId);
        return apiResponse.success(res, invoice);
      }
      case 'cancel': {
        const invoice = await cancelSupplierInvoice(companyId, invoiceId);
        return apiResponse.success(res, invoice);
      }
      case 'match': {
        const result = await performThreeWayMatch(companyId, invoiceId);
        return apiResponse.success(res, result);
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Action failed';
    log.error('Supplier invoice action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

 
export default withCompany(withErrorHandler(withWriteAccess(handler)));
