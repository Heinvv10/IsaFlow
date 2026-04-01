/**
 * Migration AR Invoices API
 * POST /api/accounting/migration/ar-invoices
 * Body: { sessionId, invoices[] }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  importARInvoices,
  type ARInvoiceRow,
} from '@/modules/accounting/services/migrationImportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  }

  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const { sessionId, invoices } = req.body as {
    sessionId?: string;
    invoices?: ARInvoiceRow[];
  };

  if (!sessionId?.trim()) {
    return apiResponse.validationError(res, { sessionId: 'Session ID is required' });
  }
  if (!invoices || !Array.isArray(invoices) || invoices.length === 0) {
    return apiResponse.validationError(res, { invoices: 'Non-empty invoices array is required' });
  }

  const result = await importARInvoices(companyId, sessionId, invoices, userId);

  log.info('AR invoices imported', {
    companyId,
    sessionId,
    imported: result.imported,
    skipped: result.skipped,
  }, 'migration');

  return apiResponse.success(res, result);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
