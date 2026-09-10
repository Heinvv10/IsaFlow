/**
 * Balance Sheet Export API
 * GET — export balance sheet as CSV
 *
 * Query params:
 *   as_at_date     YYYY-MM-DD  required
 *   cost_centre_id UUID        optional
 *   business_unit_id UUID      optional
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { getBalanceSheet } from '@/modules/accounting/services/reports/financialReportingService';
import { csvVal } from '@/lib/csv';
import { isUuidParam } from '@/lib/validation';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const asAtDate = req.query.as_at_date as string;
  const costCentreId = req.query.cost_centre_id;
  const businessUnitId = req.query.business_unit_id;

  if (!asAtDate) return apiResponse.badRequest(res, 'as_at_date is required');
  if (costCentreId !== undefined && !isUuidParam(costCentreId)) {
    return apiResponse.badRequest(res, 'cost_centre_id must be a valid UUID');
  }
  if (businessUnitId !== undefined && !isUuidParam(businessUnitId)) {
    return apiResponse.badRequest(res, 'business_unit_id must be a valid UUID');
  }

  try {
    const [companyRows, report] = await Promise.all([
      sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1` as Promise<{name: string}[]>,
      getBalanceSheet(companyId, asAtDate, costCentreId || undefined, undefined, businessUnitId),
    ]);
    const companyName = (companyRows as {name: string}[])[0]?.name ?? 'Company';

    const csvLines: string[] = [
      `${csvVal(companyName)}`,
      `Balance Sheet`,
      `As at: ${csvVal(asAtDate)}`,
      `Generated: ${csvVal(new Date().toLocaleDateString('en-ZA'))}`,
      ``,
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
    const filename = `balance-sheet-${asAtDate}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export balance sheet', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export balance sheet');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
