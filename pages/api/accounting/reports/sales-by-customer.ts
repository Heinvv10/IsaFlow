/**
 * Sales by Customer Report API
 * GET: Returns sales summary grouped by customer for a date range
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  try {
    const from = (req.query.from as string) || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const to = (req.query.to as string) || new Date().toISOString().split('T')[0];
    const format = req.query.format as string;

    const { companyId } = req as CompanyApiRequest;
    const rows = await sql`
      SELECT
        ci.client_id,
        c.name AS client_name,
        COUNT(ci.id)::int AS invoice_count,
        COALESCE(SUM(ci.total_amount), 0)::numeric AS total_sales,
        COALESCE(SUM(ci.amount_paid), 0)::numeric AS payments_received,
        COALESCE(SUM(ci.total_amount - ci.amount_paid), 0)::numeric AS outstanding
      FROM customer_invoices ci
      JOIN customers c ON c.id = ci.client_id
      WHERE ci.company_id = ${companyId}
        AND ci.invoice_date >= ${from}
        AND ci.invoice_date <= ${to}
        AND ci.status != 'cancelled'
      GROUP BY ci.client_id, c.name
      ORDER BY total_sales DESC
    `;

    const data = rows.map(r => ({
      clientId: r.client_id,
      clientName: r.client_name,
      invoiceCount: Number(r.invoice_count),
      totalSales: Number(r.total_sales),
      paymentsReceived: Number(r.payments_received),
      outstanding: Number(r.outstanding),
    }));

    if (format === 'csv') {
      const header = 'Customer,Invoices,Total Sales,Received,Outstanding';
      const csvRows = data.map(r =>
        `"${r.clientName}",${r.invoiceCount},${r.totalSales.toFixed(2)},${r.paymentsReceived.toFixed(2)},${r.outstanding.toFixed(2)}`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sales-by-customer-${from}-${to}.csv"`);
      return res.send([header, ...csvRows].join('\n'));
    }

    return apiResponse.success(res, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('sales-by-customer report error', { error: message });
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, 'Failed to generate report');
  }
}

export default withCompany(withErrorHandler(handler));
