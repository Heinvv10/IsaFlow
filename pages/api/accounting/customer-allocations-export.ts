/**
 * Customer Allocations Export API
 * GET — export receipt allocations as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyApiRequest;

  try {
    const rows = await sql`
      SELECT cp.payment_number, ci.invoice_number,
        c.name AS client_name, cpa.amount_allocated AS amount,
        cpa.created_at AS allocated_at, cp.payment_date
      FROM customer_payment_allocations cpa
      JOIN customer_payments cp ON cp.id = cpa.payment_id
      JOIN customer_invoices ci ON ci.id = cpa.invoice_id
      JOIN customers c ON c.id = cp.client_id
      WHERE cp.company_id = ${companyId}
      ORDER BY cpa.created_at DESC
    `;

    const csvLines = [
      'Payment #,Invoice #,Client,Amount,Payment Date,Allocated At',
      ...rows.map((r: Record<string, unknown>) => [
        csvCell(String(r.payment_number)),
        csvCell(String(r.invoice_number)),
        csvCell(String(r.client_name || '')),
        Number(r.amount || 0).toFixed(2),
        csvCell(String(r.payment_date)),
        csvCell(String(r.allocated_at)),
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="customer-allocations-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvLines.join('\n'));
  } catch (err) {
    log.error('Customer allocations export failed', { error: err });
    return apiResponse.badRequest(res, 'Failed to export customer allocations');
  }
}

export default withCompany(withErrorHandler(handler));
