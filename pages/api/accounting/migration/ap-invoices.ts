/**
 * Migration AP Invoices API
 * POST /api/accounting/migration/ap-invoices
 * Body: { sessionId, invoices[] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  importAPInvoices,
  type APInvoiceRow,
} from '@/modules/accounting/services/migrationApService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { sessionId, invoices } = req.body as {
    sessionId?: string;
    invoices?: APInvoiceRow[];
  };

  if (!sessionId?.trim()) {
    return apiResponse.validationError(res, { sessionId: 'Session ID is required' });
  }
  if (!invoices || !Array.isArray(invoices) || invoices.length === 0) {
    return apiResponse.validationError(res, { invoices: 'Non-empty invoices array is required' });
  }

  const result = await importAPInvoices(companyId, sessionId, invoices, userId);

  log.info('AP invoices imported', {
    companyId,
    sessionId,
    imported: result.imported,
    skipped: result.skipped,
  }, 'migration');

  return apiResponse.success(res, result);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
