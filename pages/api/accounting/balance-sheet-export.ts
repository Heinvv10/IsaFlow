/**
 * Balance Sheet Export API
 * GET — export balance sheet as CSV
 *
 * Query params:
 *   as_at_date     YYYY-MM-DD  required
 *   cost_centre_id UUID        optional
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getBalanceSheet } from '@/modules/accounting/services/financialReportingService';

/** Escape a value for CSV — wraps in double-quotes and escapes internal quotes. */
function csvVal(value: string | number): string {
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const asAtDate = req.query.as_at_date as string;
  const costCentreId = req.query.cost_centre_id as string | undefined;

  if (!asAtDate) return apiResponse.badRequest(res, 'as_at_date is required');

  try {
    const report = await getBalanceSheet(companyId, asAtDate, costCentreId || undefined);

    const csvLines: string[] = [
      'Section,Account Code,Account Name,Balance',
    ];

    // Assets
    for (const item of report.assets) {
      csvLines.push(
        `${csvVal('Assets')},${csvVal(item.accountCode)},${csvVal(item.accountName)},${Number(item.balance).toFixed(2)}`
      );
    }
    csvLines.push(`${csvVal('Assets')},${csvVal('')},${csvVal('Total Assets')},${Number(report.totalAssets).toFixed(2)}`);

    // Liabilities
    for (const item of report.liabilities) {
      csvLines.push(
        `${csvVal('Liabilities')},${csvVal(item.accountCode)},${csvVal(item.accountName)},${Number(item.balance).toFixed(2)}`
      );
    }
    csvLines.push(`${csvVal('Liabilities')},${csvVal('')},${csvVal('Total Liabilities')},${Number(report.totalLiabilities).toFixed(2)}`);

    // Equity
    for (const item of report.equity) {
      csvLines.push(
        `${csvVal('Equity')},${csvVal(item.accountCode)},${csvVal(item.accountName)},${Number(item.balance).toFixed(2)}`
      );
    }
    csvLines.push(`${csvVal('Equity')},${csvVal('')},${csvVal('Total Equity')},${Number(report.totalEquity).toFixed(2)}`);

    const csv = csvLines.join('\n');
    const filename = `balance-sheet-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export balance sheet', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export balance sheet');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
