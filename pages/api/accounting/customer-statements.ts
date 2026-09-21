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
import { documentInPopulationExpr } from '@/modules/accounting/services/shared/documentPopulation';
import {
  CREDIT_NOTE_STATEMENT_VALUE, LIVE_CREDIT_NOTE_STATUSES, SETTLING_RECEIPT_STATUSES,
} from '@/modules/accounting/services/ar/customerStatementRules';


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
    // Each row states the balance of the statement it opens — the emailed
    // statement as at today (R-115): invoices less settled receipts at their
    // full amount, less every live credit note at the statement valuation,
    // nothing dated after today, and no row for a soft-deleted customer (who
    // has no statement). The rules are customerStatementRules'; the list used
    // to ignore credit notes entirely.
    //
    // COALESCE(client_id, customer_id): both columns exist and either may
    // hold the customer reference (project rule).
    const customers = await sql`
      SELECT
        inv.client_id,
        c.name AS client_name,
        inv.total_invoiced,
        COALESCE(paid.total_paid, 0) AS total_paid,
        COALESCE(cr.total_credits, 0) AS total_credits,
        inv.total_invoiced - COALESCE(paid.total_paid, 0) - COALESCE(cr.total_credits, 0) AS balance,
        paid.last_payment_date,
        inv.invoice_count
      FROM (
        SELECT COALESCE(ci.client_id, ci.customer_id) AS client_id,
          SUM(ci.total_amount::numeric) AS total_invoiced,
          COUNT(*)::int AS invoice_count
        FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}
          -- Hein decided 2026-09-11 (R-082): statements must not show draft
          -- invoices, and must agree with the ageing on a null status.
          AND ${sql.unsafe(documentInPopulationExpr('ci'))}
          -- As at TODAY, not undated: a document soft-deleted BEFORE the delete
          -- began reversing its journal has a standing entry the control account
          -- still carries. See shared/softDeleteLedgerPresence.
          AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}
          AND ci.invoice_date <= ${asAtStr}::DATE
        GROUP BY COALESCE(ci.client_id, ci.customer_id)
        HAVING SUM(ci.total_amount::numeric) > 0
      ) inv
      JOIN customers c ON c.id = inv.client_id AND c.company_id = ${companyId} AND c.deleted_at IS NULL
      LEFT JOIN (
        SELECT client_id,
          SUM(total_amount::numeric) AS total_paid,
          MAX(payment_date) AS last_payment_date
        FROM customer_payments
        WHERE company_id = ${companyId} AND status = ANY(${SETTLING_RECEIPT_STATUSES})
          AND payment_date <= ${asAtStr}::DATE
        GROUP BY client_id
      ) paid ON paid.client_id = inv.client_id
      LEFT JOIN (
        SELECT client_id, SUM(${sql.unsafe(CREDIT_NOTE_STATEMENT_VALUE)}::numeric) AS total_credits
        FROM credit_notes
        WHERE company_id = ${companyId} AND type = 'customer'
          AND status = ANY(${LIVE_CREDIT_NOTE_STATUSES})
          AND credit_date <= ${asAtStr}::DATE
        GROUP BY client_id
      ) cr ON cr.client_id = inv.client_id
      ORDER BY balance DESC, inv.client_id
      LIMIT ${limit + 1} OFFSET ${offset}
    `;

    const hasMore = customers.length > limit;
    const page = hasMore ? customers.slice(0, limit) : customers;

    return apiResponse.success(res, {
      customers: page.map(c => ({
        ...c,
        total_invoiced: Number(c.total_invoiced),
        total_paid: Number(c.total_paid),
        total_credits: Number(c.total_credits),
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
