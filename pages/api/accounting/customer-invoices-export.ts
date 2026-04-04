/**
 * Customer Invoices Export API
 * GET — export customer invoices as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  try {
    const { status } = req.query;

    let rows;
    if (status && status !== 'all') {
      rows = await sql`
        SELECT ci.invoice_number, c.name AS client_name,
          ci.total_amount, ci.amount_paid, ci.status,
          ci.invoice_date, ci.due_date, NULL as project_name
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = ci.client_id
        WHERE ci.company_id = ${companyId}
          AND ci.status = ${status as string}
        ORDER BY ci.invoice_date DESC
      `;
    } else {
      rows = await sql`
        SELECT ci.invoice_number, c.name AS client_name,
          ci.total_amount, ci.amount_paid, ci.status,
          ci.invoice_date, ci.due_date, NULL as project_name
        FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = ci.client_id
        WHERE ci.company_id = ${companyId}
        ORDER BY ci.invoice_date DESC
      `;
    }

    const csvLines = [
      'Invoice #,Client,Project,Date,Due Date,Amount,Paid,Outstanding,Status',
      ...rows.map((r: Record<string, unknown>) => {
        const total = Number(r.total_amount || 0);
        const paid = Number(r.amount_paid || 0);
        return [
          csvCell(String(r.invoice_number)),
          csvCell(String(r.client_name || '')),
          csvCell(String(r.project_name || '')),
          csvCell(String(r.invoice_date)),
          csvCell(String(r.due_date || '')),
          total.toFixed(2),
          paid.toFixed(2),
          (total - paid).toFixed(2),
          csvCell(String(r.status)),
        ].join(',');
      }),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="customer-invoices-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvLines.join('\n'));
  } catch (err) {
    log.error('Customer invoices export failed', { error: err });
    return apiResponse.internalError(res, err, 'Failed to export customer invoices');
  }
}

export default withCompany(withErrorHandler(handler));
