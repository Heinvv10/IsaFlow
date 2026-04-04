import { sql } from '@/lib/neon';
/**
 * Customer Invoices List API (cross-project)
 * GET /api/accounting/customer-invoices-list - All customer invoices across projects
 * Sage equivalent: Customers > Tax Invoices
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const { status, limit: limitParam = '50', offset = '0', q } = req.query;
    const limit = Math.min(Number(limitParam), 200);
    const searchTerm = typeof q === 'string' && q.trim() ? `%${q.trim()}%` : null;

    let invoices;
    if (status && status !== 'all') {
      invoices = await sql`
        SELECT
          ci.id, ci.invoice_number, ci.project_id,
          COALESCE(ci.client_id, ci.customer_id) as client_id,
          ci.total_amount, ci.amount_paid, ci.status,
          ci.invoice_date, ci.due_date, ci.sent_at, ci.paid_at,
          c.name as client_name
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        WHERE ci.company_id = ${companyId}
          AND ci.deleted_at IS NULL
          AND ci.status = ${status as string}
        ORDER BY ci.invoice_date DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `;
    } else if (searchTerm) {
      invoices = await sql`
        SELECT
          ci.id, ci.invoice_number, ci.project_id,
          COALESCE(ci.client_id, ci.customer_id) as client_id,
          ci.total_amount, ci.amount_paid, ci.status,
          ci.invoice_date, ci.due_date, ci.sent_at, ci.paid_at,
          c.name as client_name
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        WHERE ci.company_id = ${companyId}
          AND ci.deleted_at IS NULL
          AND (ci.invoice_number ILIKE ${searchTerm} OR c.name ILIKE ${searchTerm})
        ORDER BY ci.invoice_date DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `;
    } else {
      invoices = await sql`
        SELECT
          ci.id, ci.invoice_number, ci.project_id,
          COALESCE(ci.client_id, ci.customer_id) as client_id,
          ci.total_amount, ci.amount_paid, ci.status,
          ci.invoice_date, ci.due_date, ci.sent_at, ci.paid_at,
          c.name as client_name
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
        WHERE ci.company_id = ${companyId}
          AND ci.deleted_at IS NULL
        ORDER BY ci.invoice_date DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `;
    }

    return apiResponse.success(res, { invoices, total: invoices.length });
  } catch (err) {
    log.error('Failed to fetch customer invoices list', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to fetch customer invoices');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
