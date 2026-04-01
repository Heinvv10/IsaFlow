import { sql } from '@/lib/neon';
/**
 * Customer Statements API
 * GET /api/accounting/customer-statements - Customer balances summary
 * Sage equivalent: Customers > Reports > Statements
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const customers = await sql`
      SELECT
        ci.client_id,
        c.name as client_name,
        SUM(ci.total_amount::numeric) as total_invoiced,
        COALESCE(paid.total_paid, 0) as total_paid,
        SUM(ci.total_amount::numeric) - COALESCE(paid.total_paid, 0) as balance,
        paid.last_payment_date,
        COUNT(*)::int as invoice_count
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = ci.client_id
      LEFT JOIN (
        SELECT client_id,
          SUM(total_amount::numeric) as total_paid,
          MAX(payment_date) as last_payment_date
        FROM customer_payments
        WHERE status IN ('confirmed', 'reconciled')
        GROUP BY client_id
      ) paid ON paid.client_id = ci.client_id
      WHERE ci.company_id = ${companyId} AND ci.status != 'cancelled'
      GROUP BY ci.client_id, c.name, paid.total_paid, paid.last_payment_date
      HAVING SUM(ci.total_amount::numeric) > 0
      ORDER BY SUM(ci.total_amount::numeric) - COALESCE(paid.total_paid, 0) DESC
    `;

    return apiResponse.success(res, {
      customers: customers.map(c => ({
        ...c,
        total_invoiced: Number(c.total_invoiced),
        total_paid: Number(c.total_paid),
        balance: Number(c.balance),
        invoice_count: Number(c.invoice_count),
      })),
    });
  } catch (err) {
    log.error('Failed to fetch customer statements', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to fetch customer statements');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
