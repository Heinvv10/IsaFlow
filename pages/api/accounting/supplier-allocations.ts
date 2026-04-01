/**
 * Supplier Payment Allocations API
 * GET  — List existing allocations (audit trail)
 * POST — Allocate payments against outstanding supplier invoices
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
      const supplierId = req.query.supplier_id as string | undefined;

      let rows;
      if (paymentId) {
        rows = await sql`
          SELECT spa.id, spa.payment_id, spa.invoice_id, spa.amount_allocated AS amount,
            spa.created_at AS allocated_at, sp.payment_number, si.invoice_number,
            s.company_name AS supplier_name
          FROM supplier_payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
          JOIN supplier_invoices si ON si.id = spa.invoice_id
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE spa.payment_id = ${paymentId}
            AND sp.company_id = ${companyId}
          ORDER BY spa.created_at DESC
        `;
      } else if (supplierId) {
        rows = await sql`
          SELECT spa.id, spa.payment_id, spa.invoice_id, spa.amount_allocated AS amount,
            spa.created_at AS allocated_at, sp.payment_number, si.invoice_number,
            s.company_name AS supplier_name
          FROM supplier_payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
          JOIN supplier_invoices si ON si.id = spa.invoice_id
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.supplier_id = ${supplierId}
            AND sp.company_id = ${companyId}
          ORDER BY spa.created_at DESC
          LIMIT 200
        `;
      } else {
        rows = await sql`
          SELECT spa.id, spa.payment_id, spa.invoice_id, spa.amount_allocated AS amount,
            spa.created_at AS allocated_at, sp.payment_number, si.invoice_number,
            s.company_name AS supplier_name
          FROM supplier_payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
          JOIN supplier_invoices si ON si.id = spa.invoice_id
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.company_id = ${companyId}
          ORDER BY spa.created_at DESC
          LIMIT 200
        `;
      }

      return apiResponse.success(res, rows);
    } catch (err) {
      log.error('Failed to get supplier allocations', { error: err });
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

      for (const alloc of allocations) {
        if (!alloc.invoiceId || !alloc.amount || alloc.amount <= 0) {
          return apiResponse.badRequest(res, 'Each allocation needs invoiceId and positive amount');
        }
      }

      const paymentRows = await sql`
        SELECT sp.id, sp.supplier_id, sp.total_amount, sp.status,
          COALESCE((SELECT SUM(amount_allocated) FROM supplier_payment_allocations WHERE payment_id = sp.id), 0) AS allocated_amount
        FROM supplier_payments sp WHERE sp.id = ${paymentId} AND sp.company_id = ${companyId}
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

      const results: { invoiceId: string; amount: number; newStatus: string }[] = [];

      for (const alloc of allocations) {
        const invoiceRows = await sql`
          SELECT id, supplier_id, total_amount, amount_paid, status
          FROM supplier_invoices WHERE id = ${alloc.invoiceId} AND company_id = ${companyId}
        `;
        const invoice = invoiceRows[0];
        if (!invoice) {
          return apiResponse.badRequest(res, `Invoice ${alloc.invoiceId} not found`);
        }
        if (invoice.supplier_id !== payment.supplier_id) {
          return apiResponse.badRequest(res, `Invoice ${alloc.invoiceId} belongs to a different supplier`);
        }

        const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid || 0);
        if (alloc.amount > outstanding + 0.01) {
          return apiResponse.badRequest(res, `Allocation ${alloc.amount} exceeds outstanding ${outstanding.toFixed(2)} for invoice ${alloc.invoiceId}`);
        }

        await sql`
          INSERT INTO supplier_payment_allocations (payment_id, invoice_id, amount_allocated)
          VALUES (${paymentId}, ${alloc.invoiceId}, ${alloc.amount})
        `;

        const newPaid = Number(invoice.amount_paid || 0) + alloc.amount;
        const invoiceTotal = Number(invoice.total_amount);
        const newStatus = newPaid >= invoiceTotal - 0.01 ? 'paid' : 'partially_paid';

        await sql`
          UPDATE supplier_invoices
          SET amount_paid = ${newPaid}, status = ${newStatus}
          WHERE id = ${alloc.invoiceId}
        `;

        results.push({ invoiceId: alloc.invoiceId, amount: alloc.amount, newStatus });
      }

      const newAllocated = currentAllocated + allocTotal;
      const paymentStatus = newAllocated >= totalPayment - 0.01 ? 'reconciled' : 'approved';

      await sql`
        UPDATE supplier_payments
        SET status = ${paymentStatus}
        WHERE id = ${paymentId}
      `;

      log.info('Supplier allocations created', {
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
      log.error('Supplier allocation failed', { error: err });
      return apiResponse.badRequest(res, message);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler));
