/**
 * Customer Allocations Export API
 * GET — export receipt allocations as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { neon } from '@neondatabase/serverless';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';

const sql = neon(process.env.DATABASE_URL!);

function csvCell(v: string): string { return `"${String(v || '').replace(/"/g, '""')}"`; }

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  try {
    const rows = await sql`
      SELECT cp.payment_number, ci.invoice_number,
        c.company_name AS client_name, cpa.amount_allocated AS amount,
        cpa.created_at AS allocated_at, cp.payment_date
      FROM customer_payment_allocations cpa
      JOIN customer_payments cp ON cp.id = cpa.payment_id
      JOIN customer_invoices ci ON ci.id = cpa.invoice_id
      JOIN clients c ON c.id = cp.client_id
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

export default withAuth(handler);
