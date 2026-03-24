/**
 * Income Statement Export API
 * GET — export income statement (P&L) as CSV
 *
 * Query params:
 *   period_start   YYYY-MM-DD  required
 *   period_end     YYYY-MM-DD  required
 *   cost_centre_id UUID        optional
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getIncomeStatement } from '@/modules/accounting/services/financialReportingService';

/** Escape a value for CSV — wraps in double-quotes and escapes internal quotes. */
function csvVal(value: string | number): string {
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const periodStart = req.query.period_start as string;
  const periodEnd = req.query.period_end as string;
  const costCentreId = req.query.cost_centre_id as string | undefined;

  if (!periodStart) return apiResponse.badRequest(res, 'period_start is required');
  if (!periodEnd) return apiResponse.badRequest(res, 'period_end is required');

  try {
    const report = await getIncomeStatement(periodStart, periodEnd, {
      costCentreId: costCentreId || undefined,
    });

    const csvLines: string[] = [
      'Section,Account Code,Account Name,Amount',
    ];

    // Revenue lines
    for (const item of report.revenue) {
      csvLines.push(
        `${csvVal('Revenue')},${csvVal(item.accountCode)},${csvVal(item.accountName)},${Number(item.amount).toFixed(2)}`
      );
    }
    csvLines.push(`${csvVal('Revenue')},${csvVal('')},${csvVal('Total Revenue')},${Number(report.totalRevenue).toFixed(2)}`);

    // Cost of Sales lines
    for (const item of report.costOfSales) {
      csvLines.push(
        `${csvVal('Cost of Sales')},${csvVal(item.accountCode)},${csvVal(item.accountName)},${Number(item.amount).toFixed(2)}`
      );
    }
    csvLines.push(`${csvVal('Cost of Sales')},${csvVal('')},${csvVal('Total Cost of Sales')},${Number(report.totalCostOfSales).toFixed(2)}`);

    // Gross Profit summary
    csvLines.push(`${csvVal('Summary')},${csvVal('')},${csvVal('Gross Profit')},${Number(report.grossProfit).toFixed(2)}`);

    // Operating Expenses lines
    for (const item of report.operatingExpenses) {
      csvLines.push(
        `${csvVal('Operating Expenses')},${csvVal(item.accountCode)},${csvVal(item.accountName)},${Number(item.amount).toFixed(2)}`
      );
    }
    csvLines.push(`${csvVal('Operating Expenses')},${csvVal('')},${csvVal('Total Operating Expenses')},${Number(report.totalOperatingExpenses).toFixed(2)}`);

    // Net Profit summary
    csvLines.push(`${csvVal('Summary')},${csvVal('')},${csvVal('Net Profit')},${Number(report.netProfit).toFixed(2)}`);

    const csv = csvLines.join('\n');
    const filename = `income-statement-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export income statement', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export income statement');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
