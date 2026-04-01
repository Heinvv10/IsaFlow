/**
 * Customer Invoice GL Posting API
 * POST /api/accounting/customer-invoices-gl
 *   Posts an existing customer invoice to the General Ledger
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/customerPaymentService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  try {
    const { invoiceId } = req.body;
    const userId = req.user.id;

    if (!invoiceId) return apiResponse.badRequest(res, 'invoiceId is required');

    const journalEntryId = await postCustomerInvoiceToGL(companyId, invoiceId, userId);
    return apiResponse.success(res, { journalEntryId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to post invoice to GL';
    log.error('Failed to post customer invoice to GL', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
