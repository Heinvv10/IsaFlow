/**
 * Purchases by Supplier Report API
 * GET: Returns purchase summary grouped by supplier for a date range
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);

  try {
    const from = (req.query.from as string) || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    const to = (req.query.to as string) || new Date().toISOString().split('T')[0];
    const format = req.query.format as string;

    const { companyId } = req as CompanyApiRequest;
    const rows = await sql`
      SELECT
        si.supplier_id,
        COALESCE(s.name, s.company_name) AS supplier_name,
        COUNT(si.id)::int AS invoice_count,
        COALESCE(SUM(si.total_amount), 0)::numeric AS total_purchases,
        COALESCE(SUM(si.amount_paid), 0)::numeric AS payments_made,
        COALESCE(SUM(si.total_amount - si.amount_paid), 0)::numeric AS outstanding
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.company_id = ${companyId}
        AND si.invoice_date >= ${from}
        AND si.invoice_date <= ${to}
        AND si.status != 'cancelled'
      GROUP BY si.supplier_id, s.company_name
      ORDER BY total_purchases DESC
    `;

    const data = rows.map(r => ({
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      invoiceCount: Number(r.invoice_count),
      totalPurchases: Number(r.total_purchases),
      paymentsMade: Number(r.payments_made),
      outstanding: Number(r.outstanding),
    }));

    if (format === 'csv') {
      const header = 'Supplier,Invoices,Total Purchases,Paid,Outstanding';
      const csvRows = data.map(r =>
        `${csvCell(r.supplierName)},${r.invoiceCount},${r.totalPurchases.toFixed(2)},${r.paymentsMade.toFixed(2)},${r.outstanding.toFixed(2)}`
      );
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="purchases-by-supplier-${from}-${to}.csv"`);
      return res.send([header, ...csvRows].join('\n'));
    }

    return apiResponse.success(res, data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('purchases-by-supplier report error', { error: message });
    return apiResponse.error(res, ErrorCode.INTERNAL_ERROR, 'Failed to generate report');
  }
}

export default withCompany(withErrorHandler(handler));
