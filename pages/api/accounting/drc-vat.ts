/**
 * DRC (Domestic Reverse Charge) VAT API
 * GET  — list eligible invoices and DRC history
 * POST — apply DRC VAT to a supplier invoice
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getDRCEligibleInvoices, getDRCHistory, applyDRCVat,
} from '@/modules/accounting/services/drcVatService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    const tab = req.query.tab as string;
    if (tab === 'history') {
      const items = await getDRCHistory(companyId);
      return apiResponse.success(res, { items });
    }
    const items = await getDRCEligibleInvoices(companyId);
    return apiResponse.success(res, { items });
  }

  if (req.method === 'POST') {
    const { supplierInvoiceId } = req.body;
    if (!supplierInvoiceId) return apiResponse.badRequest(res, 'supplierInvoiceId required');
    try {
      const result = await applyDRCVat(companyId, supplierInvoiceId, userId);
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('Failed to apply DRC VAT', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, err instanceof Error ? err.message : 'Failed');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
