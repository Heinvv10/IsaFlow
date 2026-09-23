/**
 * Customer Invoices List API (cross-project)
 * GET /api/accounting/customer-invoices-list - All customer invoices across projects
 * Sage equivalent: Customers > Tax Invoices
 *
 * BL-23: Collapsed 4 duplicated SQL branches into one parameterized query.
 * Expression index idx_ci_coalesce_client (migration 330) makes the COALESCE
 * filter sargable.
 *
 * 2026-04-27: Added days_overdue and aging_bucket computed columns (server-side
 * CASE WHEN) for the AR aging column on the invoice list. Added ?aging filter.
 *
 * 2026-09-23: Added ?from_date / ?to_date (inclusive invoice_date). Query
 * parsing lives in customerInvoiceListParams, shared with the CSV export.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { listCustomerInvoices } from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { parseCustomerInvoiceListParams } from '@/modules/accounting/services/ar/customerInvoiceListParams';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const parsed = parseCustomerInvoiceListParams(req.query);
    if (!parsed.ok) return apiResponse.badRequest(res, parsed.error);

    const { invoices, total } = await listCustomerInvoices(companyId, parsed.filters);

    return apiResponse.success(res, { invoices, total });
  } catch (err) {
    log.error('Failed to fetch customer invoices list', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to fetch customer invoices');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
