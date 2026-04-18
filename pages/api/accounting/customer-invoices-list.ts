import { sql } from '@/lib/neon';
/**
 * Customer Invoices List API (cross-project)
 * GET /api/accounting/customer-invoices-list - All customer invoices across projects
 * Sage equivalent: Customers > Tax Invoices
 *
 * BL-23: Collapsed 4 duplicated SQL branches into one parameterized query.
 * Expression index idx_ci_coalesce_client (migration 330) makes the COALESCE
 * filter sargable.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const { status, limit: limitParam = '25', page: pageParam = '1', q, client_id } = req.query;

    // Cap at 100 — aligns with BL-11 / BL-24 limit policy
    const safeLimit = Math.min(Math.max(1, Number(limitParam)), 100);
    const page = Math.max(1, Number(pageParam));
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

    // Single parameterized query — each filter dimension is independently nullable.
    // statusValues uses ANY(array) guard; clientId and searchTerm use IS NULL guards.
    // searchTerm also matches c.name (requires LEFT JOIN in both main + count).
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
          ci.invoice_date,
          ci.due_date,
          ci.sent_at,
          ci.paid_at,
          ci.currency_code,
          ci.exchange_rate,
          ci.functional_total,
          c.name AS client_name
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        WHERE ci.company_id = ${companyId}::UUID
          AND ci.deleted_at IS NULL
          AND (${statusValues}::text[] IS NULL OR ci.status = ANY(${statusValues}::text[]))
          AND (${clientIdFilter}::uuid IS NULL OR COALESCE(ci.client_id, ci.customer_id) = ${clientIdFilter}::uuid)
          AND (
            ${searchTermFilter}::text IS NULL
            OR ci.invoice_number ILIKE '%' || ${searchTermFilter}::text || '%'
            OR c.name ILIKE '%' || ${searchTermFilter}::text || '%'
          )
        ORDER BY ci.invoice_date DESC
        LIMIT ${safeLimit} OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*) AS total
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        WHERE ci.company_id = ${companyId}::UUID
          AND ci.deleted_at IS NULL
          AND (${statusValues}::text[] IS NULL OR ci.status = ANY(${statusValues}::text[]))
          AND (${clientIdFilter}::uuid IS NULL OR COALESCE(ci.client_id, ci.customer_id) = ${clientIdFilter}::uuid)
          AND (
            ${searchTermFilter}::text IS NULL
            OR ci.invoice_number ILIKE '%' || ${searchTermFilter}::text || '%'
            OR c.name ILIKE '%' || ${searchTermFilter}::text || '%'
          )
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
