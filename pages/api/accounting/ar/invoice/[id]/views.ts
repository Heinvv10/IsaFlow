/**
 * GET /api/accounting/ar/invoice/[id]/views
 *
 * Internal, company-scoped. Returns the customer_invoice_views history
 * for an invoice — powers the AR-side "who opened this invoice and when"
 * drawer.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import {
  getLastViewedSummary,
  listInvoiceViews,
} from '@/modules/accounting/services/ar/readReceiptService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
    return;
  }

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    apiResponse.badRequest(res, 'Invoice id is required');
    return;
  }

  const [views, summaryMap] = await Promise.all([
    listInvoiceViews(id, companyId, 200),
    getLastViewedSummary(companyId, [id]),
  ]);

  const summary = summaryMap.get(id) ?? {
    invoiceId: id,
    lastViewedAt: null,
    viewCount: views.length,
    distinctSessions: 0,
  };

  apiResponse.success(res, { views, summary });
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
