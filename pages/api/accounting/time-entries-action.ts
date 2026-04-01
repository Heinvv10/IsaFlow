/**
 * Time Entries Action API
 * POST — submit, approve, invoice
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  submitEntries,
  approveEntries,
  markAsInvoiced,
} from '@/modules/accounting/services/timeTrackingService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const { action, ids, invoiceId } = req.body;
    if (!action || !ids || !Array.isArray(ids) || !ids.length) {
      return apiResponse.badRequest(res, 'action and ids[] are required');
    }

    switch (action) {
      case 'submit': {
        const count = await submitEntries(companyId, ids);
        return apiResponse.success(res, { action: 'submit', count });
      }
      case 'approve': {
        const count = await approveEntries(companyId, ids);
        return apiResponse.success(res, { action: 'approve', count });
      }
      case 'invoice': {
        if (!invoiceId) return apiResponse.badRequest(res, 'invoiceId is required for invoice action');
        const count = await markAsInvoiced(companyId, ids, invoiceId);
        return apiResponse.success(res, { action: 'invoice', count });
      }
      default:
        return apiResponse.badRequest(res, `Unknown action: ${action}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Action failed';
    log.error('Time entry action failed', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, msg);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
