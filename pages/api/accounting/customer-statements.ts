import { sql } from '@/lib/neon';
/**
 * Customer Statements API
 * GET /api/accounting/customer-statements - Customer balances summary
 * Sage equivalent: Customers > Reports > Statements
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { parsePagination } from '@/lib/pagination';
import { asAtTodayStr, documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;
  // P3.4: was the audit's worst unbounded endpoint (GROUP BY over the full
  // invoice history, no LIMIT). One row per customer, so a generous cap
  // keeps every realistic tenant intact while ending the pathological case.
  const { limit, offset } = parsePagination(req.query, 1000, 2000);
  // A balances summary with no as-at parameter is a summary as at today.
  const asAtStr = asAtTodayStr();

  try {
    // COALESCE(client_id, customer_id): both columns exist and either may
    // hold the customer reference (project rule) — grouping on client_id
    // alone lumped customer_id-only invoices into a NULL row.
    const customers = await sql`
      SELECT
        COALESCE(ci.client_id, ci.customer_id) as client_id,
        c.name as client_name,
        SUM(ci.total_amount::numeric) as total_invoiced,
        COALESCE(paid.total_paid, 0) as total_paid,
        SUM(ci.total_amount::numeric) - COALESCE(paid.total_paid, 0) as balance,
        paid.last_payment_date,
        COUNT(*)::int as invoice_count
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
      LEFT JOIN (
        SELECT client_id,
          SUM(total_amount::numeric) as total_paid,
          MAX(payment_date) as last_payment_date
        FROM customer_payments
        WHERE company_id = ${companyId} AND status IN ('confirmed', 'reconciled')
        GROUP BY client_id
      ) paid ON paid.client_id = COALESCE(ci.client_id, ci.customer_id)
      WHERE ci.company_id = ${companyId} AND ci.status != 'cancelled'
      -- As at TODAY, not undated: a document soft-deleted BEFORE the delete
      -- began reversing its journal has a standing entry the control account
      -- still carries, and a bare deleted_at IS NULL would drop it from this
      -- figure while the GL keeps it. See shared/softDeleteLedgerPresence.
        AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}
      GROUP BY COALESCE(ci.client_id, ci.customer_id), c.name, paid.total_paid, paid.last_payment_date
      HAVING SUM(ci.total_amount::numeric) > 0
      ORDER BY SUM(ci.total_amount::numeric) - COALESCE(paid.total_paid, 0) DESC, COALESCE(ci.client_id, ci.customer_id)
      LIMIT ${limit + 1} OFFSET ${offset}
    `;

    const hasMore = customers.length > limit;
    const page = hasMore ? customers.slice(0, limit) : customers;

    return apiResponse.success(res, {
      customers: page.map(c => ({
        ...c,
        total_invoiced: Number(c.total_invoiced),
        total_paid: Number(c.total_paid),
        balance: Number(c.balance),
        invoice_count: Number(c.invoice_count),
      })),
    }, undefined, 200, { limit, offset, hasMore });
  } catch (err) {
    log.error('Failed to fetch customer statements', { error: err, module: 'accounting' });
    return apiResponse.databaseError(res, err, 'Failed to fetch customer statements');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
