/**
 * DRC VAT Export API
 * GET — export DRC VAT history as CSV
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
    // Load VAT rate from settings (default 15%)
    let vatRate = 0.15;
    try {
      const settingRows = await sql`SELECT value FROM app_settings WHERE key = 'vat_rate'`;
      if (settingRows[0]?.value) {
        const rate = Number(settingRows[0].value);
        if (rate > 0 && rate < 1) vatRate = rate;
      }
    } catch { /* use default */ }

    const rows = await sql`
      SELECT si.invoice_number, s.company_name AS supplier_name,
        si.total_amount, si.invoice_date,
        COALESCE(si.total_amount * ${vatRate}, 0) AS vat_amount
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.is_drc = true AND si.company_id = ${companyId}
      ORDER BY si.invoice_date DESC
    `;

    const csvLines = [
      'Invoice,Supplier,Date,Amount (excl),VAT (15%)',
      ...rows.map((r: Record<string, unknown>) => [
        csvCell(String(r.invoice_number)),
        csvCell(String(r.supplier_name)),
        csvCell(String(r.invoice_date)),
        Number(r.total_amount || 0).toFixed(2),
        Number(r.vat_amount || 0).toFixed(2),
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="drc-vat-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvLines.join('\n'));
  } catch (err) {
    log.error('DRC VAT export failed', { error: err });
    return apiResponse.badRequest(res, 'Failed to export DRC VAT data');
  }
}

export default withCompany(withErrorHandler(handler));
