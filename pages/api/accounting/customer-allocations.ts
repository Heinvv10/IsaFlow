/**
 * Customer Receipt Allocations API
 * GET  — List existing allocations (audit trail)
 * POST — Allocate receipts against outstanding invoices
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';

interface AllocationItem {
  invoiceId: string;
  amount: number;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

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
    try {
      const { paymentId, allocations } = req.body as {
        paymentId?: string;
        allocations?: AllocationItem[];
      };

      if (!paymentId) return apiResponse.badRequest(res, 'paymentId is required');
      if (!allocations || !Array.isArray(allocations) || allocations.length === 0) {
        return apiResponse.badRequest(res, 'allocations array is required');
      }

      // Validate allocation items
      for (const alloc of allocations) {
        if (!alloc.invoiceId || !alloc.amount || alloc.amount <= 0) {
          return apiResponse.badRequest(res, 'Each allocation needs invoiceId and positive amount');
        }
      }

      // Fetch payment
      const paymentRows = await sql`
        SELECT cp.id, cp.client_id, cp.total_amount, cp.status,
          COALESCE((SELECT SUM(amount_allocated) FROM customer_payment_allocations WHERE payment_id = cp.id), 0) AS allocated_amount
        FROM customer_payments cp WHERE cp.id = ${paymentId} AND cp.company_id = ${companyId}
      `;
      const payment = paymentRows[0];
      if (!payment) return apiResponse.notFound(res, 'Payment', paymentId);
      if (payment.status === 'cancelled') {
        return apiResponse.badRequest(res, 'Cannot allocate a cancelled payment');
      }

      const currentAllocated = Number(payment.allocated_amount || 0);
      const totalPayment = Number(payment.total_amount);
      const allocTotal = allocations.reduce((s, a) => s + a.amount, 0);

      if (currentAllocated + allocTotal > totalPayment + 0.01) {
        return apiResponse.badRequest(res, `Allocation total (${allocTotal}) exceeds available balance (${(totalPayment - currentAllocated).toFixed(2)})`);
      }

      // Process each allocation
      const results: { invoiceId: string; amount: number; newStatus: string }[] = [];

      for (const alloc of allocations) {
        // Validate invoice belongs to same client
        const invoiceRows = await sql`
          SELECT id, client_id, total_amount, amount_paid, status
          FROM customer_invoices WHERE id = ${alloc.invoiceId} AND company_id = ${companyId}
        `;
        const invoice = invoiceRows[0];
        if (!invoice) {
          return apiResponse.badRequest(res, `Invoice ${alloc.invoiceId} not found`);
        }
        if (invoice.client_id !== payment.client_id) {
          return apiResponse.badRequest(res, `Invoice ${alloc.invoiceId} belongs to a different client`);
        }

        const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid || 0);
        if (alloc.amount > outstanding + 0.01) {
          return apiResponse.badRequest(res, `Allocation ${alloc.amount} exceeds outstanding ${outstanding.toFixed(2)} for invoice ${alloc.invoiceId}`);
        }

        // Insert allocation record
        await sql`
          INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
          VALUES (${paymentId}, ${alloc.invoiceId}, ${alloc.amount})
        `;

        // Update invoice amount_paid
        const newPaid = Number(invoice.amount_paid || 0) + alloc.amount;
        const invoiceTotal = Number(invoice.total_amount);
        const newStatus = newPaid >= invoiceTotal - 0.01 ? 'paid' : 'partially_paid';

        await sql`
          UPDATE customer_invoices
          SET amount_paid = ${newPaid}, status = ${newStatus}
          WHERE id = ${alloc.invoiceId}
        `;

        results.push({ invoiceId: alloc.invoiceId, amount: alloc.amount, newStatus });
      }

      // Update payment allocated_amount
      const newAllocated = currentAllocated + allocTotal;
      const paymentStatus = newAllocated >= totalPayment - 0.01 ? 'reconciled' : 'confirmed';

      await sql`
        UPDATE customer_payments
        SET status = ${paymentStatus}
        WHERE id = ${paymentId}
      `;

      log.info('Customer allocations created', {
        paymentId,
        count: results.length,
        total: allocTotal,
      });

      return apiResponse.success(res, {
        paymentId,
        allocations: results,
        newAllocatedAmount: newAllocated,
        paymentStatus,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Allocation failed';
      log.error('Customer allocation failed', { error: err });
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as any));
