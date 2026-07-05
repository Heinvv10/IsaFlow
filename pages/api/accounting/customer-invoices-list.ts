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
import { sql } from '@/lib/neon';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';

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
    const offset = (page - 1) * safeLimit;

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
    const filterDueSoon    = agingFilters.includes('due-soon');
    const filterOverdue90  = agingFilters.includes('overdue-90');
    const filterViewedUnpaid = agingFilters.includes('viewed-unpaid');

    /*
     * Aging bucket SQL (server-authoritative):
     *   - Paid invoices:  NULL
     *   - Not yet due:    'Current'
     *   - 1–30 d overdue: '1-30'
     *   - 31–60:          '31-60'
     *   - 61–90:          '61-90'
     *   - 90+:            '90+'
     * days_overdue is GREATEST(0, CURRENT_DATE - due_date). NULL when no due_date.
     */
    const [invoices, countResult] = await Promise.all([
      sql`
        SELECT
          ci.id,
          ci.invoice_number,
          ci.project_id,
          COALESCE(ci.client_id, ci.customer_id) AS client_id,
          ci.total_amount,
          ci.amount_paid,
          ci.status,
          to_char(ci.invoice_date, 'YYYY-MM-DD') AS invoice_date,
          to_char(ci.due_date, 'YYYY-MM-DD') AS due_date,
          ci.sent_at,
          ci.paid_at,
          ci.currency_code,
          ci.exchange_rate,
          ci.functional_total,
          c.name AS client_name,
          vs.last_viewed_at,
          COALESCE(vs.view_count, 0) AS view_count,
          CASE
            WHEN ci.due_date IS NOT NULL AND ci.status != 'paid'
              THEN GREATEST(0, (CURRENT_DATE - ci.due_date::date))
            ELSE NULL
          END AS days_overdue,
          CASE
            WHEN ci.status = 'paid' THEN NULL
            WHEN ci.due_date IS NULL THEN 'Current'
            WHEN (CURRENT_DATE - ci.due_date::date) <= 0 THEN 'Current'
            WHEN (CURRENT_DATE - ci.due_date::date) <= 30 THEN '1-30'
            WHEN (CURRENT_DATE - ci.due_date::date) <= 60 THEN '31-60'
            WHEN (CURRENT_DATE - ci.due_date::date) <= 90 THEN '61-90'
            ELSE '90+'
          END AS aging_bucket
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        LEFT JOIN customer_invoice_view_summary vs
          ON vs.customer_invoice_id = ci.id AND vs.company_id = ci.company_id
        WHERE ci.company_id = ${companyId}::UUID
          AND ci.deleted_at IS NULL
          AND (${statusValues}::text[] IS NULL OR ci.status = ANY(${statusValues}::text[]))
          AND (${clientIdFilter}::uuid IS NULL OR COALESCE(ci.client_id, ci.customer_id) = ${clientIdFilter}::uuid)
          AND (
            ${searchTermFilter}::text IS NULL
            OR ci.invoice_number ILIKE '%' || ${searchTermFilter}::text || '%'
            OR c.name ILIKE '%' || ${searchTermFilter}::text || '%'
          )
          AND (NOT ${filterDueSoon} OR (
            ci.status != 'paid'
            AND ci.due_date IS NOT NULL
            AND ci.due_date::date >= CURRENT_DATE
            AND ci.due_date::date <= CURRENT_DATE + INTERVAL '7 days'
          ))
          AND (NOT ${filterOverdue90} OR (
            ci.status != 'paid'
            AND ci.due_date IS NOT NULL
            AND (CURRENT_DATE - ci.due_date::date) > 90
          ))
          AND (NOT ${filterViewedUnpaid} OR (
            ci.status = 'sent'
            AND vs.last_viewed_at IS NOT NULL
          ))
        ORDER BY ci.invoice_date DESC
        LIMIT ${safeLimit} OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*) AS total
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        LEFT JOIN customer_invoice_view_summary vs
          ON vs.customer_invoice_id = ci.id AND vs.company_id = ci.company_id
        WHERE ci.company_id = ${companyId}::UUID
          AND ci.deleted_at IS NULL
          AND (${statusValues}::text[] IS NULL OR ci.status = ANY(${statusValues}::text[]))
          AND (${clientIdFilter}::uuid IS NULL OR COALESCE(ci.client_id, ci.customer_id) = ${clientIdFilter}::uuid)
          AND (
            ${searchTermFilter}::text IS NULL
            OR ci.invoice_number ILIKE '%' || ${searchTermFilter}::text || '%'
            OR c.name ILIKE '%' || ${searchTermFilter}::text || '%'
          )
          AND (NOT ${filterDueSoon} OR (
            ci.status != 'paid'
            AND ci.due_date IS NOT NULL
            AND ci.due_date::date >= CURRENT_DATE
            AND ci.due_date::date <= CURRENT_DATE + INTERVAL '7 days'
          ))
          AND (NOT ${filterOverdue90} OR (
            ci.status != 'paid'
            AND ci.due_date IS NOT NULL
            AND (CURRENT_DATE - ci.due_date::date) > 90
          ))
          AND (NOT ${filterViewedUnpaid} OR (
            ci.status = 'sent'
            AND vs.last_viewed_at IS NOT NULL
          ))
      `,
    ]);

    const total = Number(countResult[0]?.total ?? 0);
    return apiResponse.success(res, { invoices, total });
  } catch (err) {
    log.error('Failed to fetch customer invoices list', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to fetch customer invoices');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
