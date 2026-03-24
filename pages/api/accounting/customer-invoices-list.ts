import { sql } from '@/lib/neon';
/**
 * Customer Invoices List API (cross-project)
 * GET /api/accounting/customer-invoices-list - All customer invoices across projects
 * Sage equivalent: Customers > Tax Invoices
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  try {
    const { status, limit = '50', offset = '0' } = req.query;

    let invoices;
    if (status && status !== 'all') {
      invoices = await sql`
        SELECT
          ci.id, ci.invoice_number, ci.project_id, ci.client_id,
          ci.total_amount, ci.amount_paid, ci.status, ci.reference,
          ci.invoice_date, ci.due_date, ci.sent_at, ci.paid_at,
          c.company_name as client_name,
          p.project_name as project_name
        FROM customer_invoices ci
        LEFT JOIN clients c ON c.id = ci.client_id
        LEFT JOIN projects p ON p.id = ci.project_id
        WHERE ci.status = ${status as string}
        ORDER BY ci.invoice_date DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `;
    } else {
      invoices = await sql`
        SELECT
          ci.id, ci.invoice_number, ci.project_id, ci.client_id,
          ci.total_amount, ci.amount_paid, ci.status, ci.reference,
          ci.invoice_date, ci.due_date, ci.sent_at, ci.paid_at,
          c.company_name as client_name,
          p.project_name as project_name
        FROM customer_invoices ci
        LEFT JOIN clients c ON c.id = ci.client_id
        LEFT JOIN projects p ON p.id = ci.project_id
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
export default withAuth(withErrorHandler(handler as any));
