/**
 * Supplier Invoice Actions API
 * POST /api/accounting/supplier-invoices-action
 *   action: approve | cancel | match
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  approveSupplierInvoice,
  cancelSupplierInvoice,
  performThreeWayMatch,
} from '@/modules/accounting/services/supplierInvoiceService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
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
        const invoice = await approveSupplierInvoice(invoiceId, userId);
        return apiResponse.success(res, invoice);
      }
      case 'cancel': {
        const invoice = await cancelSupplierInvoice(invoiceId);
        return apiResponse.success(res, invoice);
      }
      case 'match': {
        const result = await performThreeWayMatch(invoiceId);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
