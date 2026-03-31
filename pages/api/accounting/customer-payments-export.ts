/**
 * Customer Payments Export API
 * GET — export customer payments as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';

function csvCell(v: string): string { return `"${String(v || '').replace(/"/g, '""')}"`; }

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyApiRequest;

  try {
    const { status } = req.query;

    let rows;
    if (status && status !== '') {
      rows = await sql`
        SELECT cp.payment_number, c.name AS client_name,
          cp.payment_date, cp.total_amount,
          COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id), 0) AS allocated_amount,
          cp.payment_method, cp.bank_reference, cp.status
        FROM customer_payments cp
        LEFT JOIN customers c ON c.id = cp.client_id
        WHERE cp.status = ${status as string}
          AND cp.company_id = ${companyId}
        ORDER BY cp.payment_date DESC
      `;
    } else {
      rows = await sql`
        SELECT cp.payment_number, c.name AS client_name,
          cp.payment_date, cp.total_amount,
          COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id), 0) AS allocated_amount,
          cp.payment_method, cp.bank_reference, cp.status
        FROM customer_payments cp
        LEFT JOIN customers c ON c.id = cp.client_id
        WHERE cp.company_id = ${companyId}
        ORDER BY cp.payment_date DESC
      `;
    }

    const csvLines = [
      'Payment #,Client,Date,Amount,Allocated,Unallocated,Method,Bank Ref,Status',
      ...rows.map((r: Record<string, unknown>) => {
        const total = Number(r.total_amount || 0);
        const allocated = Number(r.allocated_amount || 0);
        return [
          csvCell(String(r.payment_number)),
          csvCell(String(r.client_name || '')),
          csvCell(String(r.payment_date)),
          total.toFixed(2),
          allocated.toFixed(2),
          (total - allocated).toFixed(2),
          csvCell(String(r.payment_method || '')),
          csvCell(String(r.bank_reference || '')),
          csvCell(String(r.status)),
        ].join(',');
      }),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="customer-payments-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvLines.join('\n'));
  } catch (err) {
    log.error('Customer payments export failed', { error: err });
    return apiResponse.badRequest(res, 'Failed to export customer payments');
  }
}

export default withCompany(withErrorHandler(handler as any));
