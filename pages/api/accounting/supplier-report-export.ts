/**
 * Supplier Report Export API
 * GET — export supplier transaction summary as CSV
 *   ?period_start=YYYY-MM-DD
 *   ?period_end=YYYY-MM-DD
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getSupplierReport } from '@/modules/accounting/services/transactionReportingService';

/** Escape a string value for safe embedding in a CSV cell. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const periodStart = req.query.period_start as string;
  const periodEnd = req.query.period_end as string;

  if (!periodStart) return apiResponse.badRequest(res, 'period_start is required');
  if (!periodEnd) return apiResponse.badRequest(res, 'period_end is required');

  try {
    const rows = await getSupplierReport(companyId, periodStart, periodEnd);

    const totalInvoiced = rows.reduce((s, r) => s + r.totalInvoiced, 0);
    const totalPaid = rows.reduce((s, r) => s + r.totalPaid, 0);
    const totalBalance = rows.reduce((s, r) => s + r.balance, 0);

    const csvLines = [
      'Supplier Name,Invoice Count,Total Invoiced,Total Paid,Balance',
      ...rows.map(r =>
        [
          csvCell(r.supplierName),
          r.invoiceCount,
          r.totalInvoiced.toFixed(2),
          r.totalPaid.toFixed(2),
          r.balance.toFixed(2),
        ].join(',')
      ),
      [
        csvCell('TOTALS'),
        rows.reduce((s, r) => s + r.invoiceCount, 0),
        totalInvoiced.toFixed(2),
        totalPaid.toFixed(2),
        totalBalance.toFixed(2),
      ].join(','),
    ];

    const csv = csvLines.join('\n');
    const filename = `supplier-report-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export supplier report', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export supplier report');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
