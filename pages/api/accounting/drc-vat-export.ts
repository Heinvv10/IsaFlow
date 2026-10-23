/**
 * DRC VAT Export API
 * GET — export DRC VAT history as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess, withVatVendor} from '@/lib/auth';
import { log } from '@/lib/logger';
import { withErrorHandler } from '@/lib/api-error-handler';
import { csvCell } from '@/lib/csv';
import { EXPORT_ROW_CEILING } from '@/lib/pagination';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  const { companyId } = req as CompanyAuthedRequest;

  // This company's VAT rate from settings, default 15%. Only "no row" and an
  // unusable value fall back to the default; a failed read is an error (a
  // swallowed one left the request transaction aborted under the next query).
  let vatRate = 0.15;
  const settingRows = await sql`
    SELECT value FROM app_settings WHERE company_id = ${companyId}::UUID AND key = 'vat_rate'`;
  if (settingRows[0]?.value != null) {
    const rate = Number(settingRows[0].value);
    if (rate > 0 && rate < 1) vatRate = rate;
    else log.warn('DRC VAT export: unusable vat_rate setting, using 15%', { companyId, value: settingRows[0].value });
  }

  const rows = await sql`
    SELECT si.invoice_number, s.company_name AS supplier_name,
      si.total_amount, si.invoice_date,
      COALESCE(si.total_amount * ${vatRate}, 0) AS vat_amount
    FROM supplier_invoices si
    JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.is_drc = true AND si.company_id = ${companyId}
    ORDER BY si.invoice_date DESC
    LIMIT ${EXPORT_ROW_CEILING + 1}
  `;

  // P3.4: cap the export rather than paginate — the extra row (if present)
  // is dropped and replaced with a truncation marker row.
  const truncated = rows.length > EXPORT_ROW_CEILING;
  const pageRows = truncated ? rows.slice(0, EXPORT_ROW_CEILING) : rows;

  const csvLines = [
    'Invoice,Supplier,Date,Amount (excl),VAT (15%)',
    ...pageRows.map((r: Record<string, unknown>) => [
      csvCell(String(r.invoice_number)),
      csvCell(String(r.supplier_name)),
      csvCell(String(r.invoice_date)),
      Number(r.total_amount || 0).toFixed(2),
      Number(r.vat_amount || 0).toFixed(2),
    ].join(',')),
  ];
  if (truncated) {
    csvLines.push([
      csvCell(`TRUNCATED — export capped at ${EXPORT_ROW_CEILING} rows; narrow the date range`),
      ...Array(4).fill(csvCell(undefined)),
    ].join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="drc-vat-${new Date().toISOString().split('T')[0]}.csv"`);
  return res.status(200).send(csvLines.join('\n'));
}

export default withAuth(withErrorHandler(withVatVendor(withWriteAccess(handler))));
