/**
 * Customer Receipt Allocations API
 * GET  — List existing allocations (audit trail)
 * POST — Allocate receipts against outstanding invoices
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import {
  applyReceiptPlan,
  planReceiptApplication,
} from '@/modules/accounting/services/ar/receiptApplicationService';
import { isReceiptRefusal } from '@/modules/accounting/services/ar/receiptRefusal';

interface AllocationItem {
  invoiceId: string;
  amount: number;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      const paymentId = req.query.payment_id as string | undefined;
      const clientId = req.query.client_id as string | undefined;

      let rows;
      if (paymentId) {
        rows = await sql`
          SELECT cpa.id, cpa.payment_id, cpa.invoice_id, cpa.amount_allocated AS amount,
            cpa.created_at AS allocated_at, cp.payment_number, ci.invoice_number,
            c.name AS client_name
          FROM customer_payment_allocations cpa
          JOIN customer_payments cp ON cp.id = cpa.payment_id
          JOIN customer_invoices ci ON ci.id = cpa.invoice_id
          JOIN customers c ON c.id = cp.client_id
          WHERE cpa.payment_id = ${paymentId}
            AND cp.company_id = ${companyId}
          ORDER BY cpa.created_at DESC
        `;
      } else if (clientId) {
        rows = await sql`
          SELECT cpa.id, cpa.payment_id, cpa.invoice_id, cpa.amount_allocated AS amount,
            cpa.created_at AS allocated_at, cp.payment_number, ci.invoice_number,
            c.name AS client_name
          FROM customer_payment_allocations cpa
          JOIN customer_payments cp ON cp.id = cpa.payment_id
          JOIN customer_invoices ci ON ci.id = cpa.invoice_id
          JOIN customers c ON c.id = cp.client_id
          WHERE cp.client_id = ${clientId}
            AND cp.company_id = ${companyId}
          ORDER BY cpa.created_at DESC
          LIMIT 200
        `;
      } else {
        rows = await sql`
          SELECT cpa.id, cpa.payment_id, cpa.invoice_id, cpa.amount_allocated AS amount,
            cpa.created_at AS allocated_at, cp.payment_number, ci.invoice_number,
            c.name AS client_name
          FROM customer_payment_allocations cpa
          JOIN customer_payments cp ON cp.id = cpa.payment_id
          JOIN customer_invoices ci ON ci.id = cpa.invoice_id
          JOIN customers c ON c.id = cp.client_id
          WHERE cp.company_id = ${companyId}
          ORDER BY cpa.created_at DESC
          LIMIT 200
        `;
      }

      return apiResponse.success(res, rows);
    } catch (err) {
      log.error('Failed to get customer allocations', { error: err });
      return apiResponse.badRequest(res, 'Failed to get allocations');
    }
  }

  if (req.method === 'POST') {
    const { paymentId, allocations } = req.body as {
      paymentId?: string;
      allocations?: AllocationItem[];
    };

    if (!paymentId) return apiResponse.badRequest(res, 'paymentId is required');
    if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
      return apiResponse.badRequest(res, 'allocations array is required');
    }

    // PLAN then APPLY. The inline SQL this replaces validated each invoice
    // inside the write loop and returned `badRequest` from within it — and
    // withAuth COMMITs on anything under 500, so a three-line request failing
    // on line three committed lines one and two and reported failure. Every
    // refusal now happens in planReceiptApplication, before the first write.
    let plan;
    try {
      plan = await planReceiptApplication(companyId, paymentId, allocations);
    } catch (err) {
      // Only a typed refusal may be answered with a 400. Catching everything
      // put a driver error's raw text (schema names included) in front of the
      // user on a status `withAuth` COMMITs, and monitored a genuine fault as
      // the user's mistake.
      if (!isReceiptRefusal(err)) {
        log.error('Customer allocation failed', { paymentId, error: err });
        throw err;
      }
      log.error('Customer allocation refused', { paymentId, error: err });
      return apiResponse.badRequest(res, err.message);
    }

    // Past this point nothing is caught: a failure must reach withAuth as a 5xx
    // so the transaction rolls back rather than committing a partial apply.
    await applyReceiptPlan(companyId, plan, user.id);

    log.info('Customer allocations created', {
      paymentId,
      count: plan.lines.length,
      total: plan.allocatedAfter - plan.allocatedBefore,
    });

    return apiResponse.success(res, {
      paymentId,
      allocations: plan.lines.map(l => ({
        invoiceId: l.invoiceId,
        amount: l.amount,
        newStatus: l.statusAfter,
      })),
      newAllocatedAmount: plan.allocatedAfter,
      paymentStatus: plan.paymentStatusAfter,
    });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
