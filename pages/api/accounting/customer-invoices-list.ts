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
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { listCustomerInvoices } from '@/modules/accounting/services/ar/customerInvoiceReadService';

/**
 * Valid aging filter values accepted via ?aging= query param.
 * 'due-soon'   — due_date between today and today+7 (unpaid)
 * 'overdue-90' — days_overdue > 90
 * 'viewed-unpaid' — sent + last_viewed_at IS NOT NULL
 */
type AgingFilter = 'due-soon' | 'overdue-90' | 'viewed-unpaid';
const VALID_AGING_FILTERS = new Set<AgingFilter>(['due-soon', 'overdue-90', 'viewed-unpaid']);

function parseAgingFilters(raw: string | string[] | undefined): AgingFilter[] {
  const arr = Array.isArray(raw) ? raw : raw ? raw.split(',') : [];
  return arr.filter((v): v is AgingFilter => VALID_AGING_FILTERS.has(v as AgingFilter));
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const {
      status,
      limit: limitParam = '25',
      page: pageParam = '1',
      q,
      client_id,
      aging,
    } = req.query;

    // Cap at 100 — aligns with BL-11 / BL-24 limit policy
    // Sanitise: NaN / negative values from query-string coercion become safe defaults.
    const limitNum = Number(limitParam);
    const pageNum = Number(pageParam);
    const safeLimit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(Math.floor(limitNum), 100) : 25;
    const page = Number.isFinite(pageNum) && pageNum >= 1 ? Math.floor(pageNum) : 1;

    // Normalize status: single value or array; null means "no filter"
    const statusValues: string[] | null =
      Array.isArray(status)
        ? status
        : status && status !== 'all'
          ? [status]
          : null;

    // Null means "no filter" — typed guards in SQL use ::text / ::uuid IS NULL checks
    const clientIdFilter: string | null =
      typeof client_id === 'string' && client_id.trim() ? client_id.trim() : null;

    const rawSearch = typeof q === 'string' ? q.trim() : '';
    const searchTermFilter: string | null = rawSearch || null;

    const agingFilters = parseAgingFilters(aging);

    const { invoices, total } = await listCustomerInvoices(companyId, {
      status: statusValues,
      clientId: clientIdFilter,
      search: searchTermFilter,
      agingFilters,
      limit: safeLimit,
      page,
    });

    return apiResponse.success(res, { invoices, total });
  } catch (err) {
    log.error('Failed to fetch customer invoices list', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to fetch customer invoices');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
