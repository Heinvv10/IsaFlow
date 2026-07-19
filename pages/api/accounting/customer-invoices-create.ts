/**
 * Customer Invoice Create API (standalone, not project-linked)
 * POST — create invoice with line items
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withFlowMeter } from '@/lib/billing/withFlowMeter';
import { getFlowCost } from '@/modules/billing/services/flowOperationCatalog';
import { log } from '@/lib/logger';
import {
  createDraftCustomerInvoice,
  InvoiceLineValidationError,
} from '@/modules/accounting/services/ar/customerInvoiceCreateService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);

  const {
    clientId, invoiceDate, dueDate, billingPeriodStart, billingPeriodEnd,
    taxRate, notes, items, currencyCode, exchangeRate,
  } = req.body;
  if (!clientId) return apiResponse.badRequest(res, 'clientId is required');
  if (!items || !Array.isArray(items) || items.length === 0) return apiResponse.badRequest(res, 'items required');

  try {
    const userId = String(req.user?.id || 'system');
    const { id: invoiceId, invoiceNumber } = await createDraftCustomerInvoice(companyId, userId, {
      clientId, invoiceDate, dueDate, billingPeriodStart, billingPeriodEnd,
      taxRate, notes, items, currencyCode, exchangeRate,
    });
    return apiResponse.created(res, { id: invoiceId, invoiceNumber });
  } catch (err) {
    if (err instanceof InvoiceLineValidationError) return apiResponse.badRequest(res, err.message);
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Invoice create failed', { error: msg });
    const clientMessage = process.env.NODE_ENV === 'development' ? msg : 'Failed to create invoice';
    return res.status(500).json({ success: false, error: { code: 'CREATE_FAILED', message: clientMessage } });
  }
}


export default withAuth(
  withErrorHandler(
    withCsrf(
      withWriteAccess(
        withFlowMeter('invoice.create', getFlowCost('invoice.create'))(handler),
      ),
    ),
  ),
);
