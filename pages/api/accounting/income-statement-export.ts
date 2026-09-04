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
import { reasonLabel } from '@/modules/accounting/services/reports/incomeStatementDisclosure';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { getIncomeStatement } from '@/modules/accounting/services/reports/financialReportingService';
import { csvVal } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const periodStart = req.query.period_start as string;
  const periodEnd = req.query.period_end as string;
  const costCentreId = req.query.cost_centre_id as string | undefined;

  if (!periodStart) return apiResponse.badRequest(res, 'period_start is required');
  if (!periodEnd) return apiResponse.badRequest(res, 'period_end is required');

  try {
    const [companyRows, report] = await Promise.all([
      sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1` as Promise<{name: string}[]>,
      getIncomeStatement(companyId, periodStart, periodEnd, {
        costCentreId: costCentreId || undefined,
      }),
    ]);
    const companyName = (companyRows as {name: string}[])[0]?.name ?? 'Company';
    const today = new Date().toLocaleDateString('en-ZA');

    const csvLines: string[] = [
      `${csvVal(companyName)}`,
      `Income Statement (Profit & Loss)`,
      `Period: ${csvVal(periodStart)} to ${csvVal(periodEnd)}`,
      `Generated: ${csvVal(today)}`,
      ``,
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

    // Margin summaries
    csvLines.push(`${csvVal('Summary')},${csvVal('')},${csvVal('Gross Margin %')},${report.totalRevenue > 0 ? ((report.grossProfit / report.totalRevenue) * 100).toFixed(1) + '%' : '—'}`);
    csvLines.push(`${csvVal('Summary')},${csvVal('')},${csvVal('Net Margin %')},${report.totalRevenue > 0 ? ((report.netProfit / report.totalRevenue) * 100).toFixed(1) + '%' : '—'}`);

    // An exported file leaves the app and carries the margins with no screen to
    // qualify them, so the caveat travels WITH the figures — immediately after
    // the margin rows it applies to, not interleaved into the statement body.
    if (report.subtypeDisclosure) {
      csvLines.push(
        `${csvVal('Warning')},${csvVal('')},${csvVal('Gross Profit overstated by at least')},${Number(report.subtypeDisclosure.grossProfitOverstatedByAtLeast).toFixed(2)}`
      );
      csvLines.push(
        `${csvVal('Warning')},${csvVal('')},${csvVal('Expense that could be cost of sales (at most)')},${Number(report.subtypeDisclosure.costOfSalesExposureAtMost).toFixed(2)}`
      );
      csvLines.push(
        `${csvVal('Warning')},${csvVal('')},${csvVal('Revenue that could be other income (at most)')},${Number(report.subtypeDisclosure.otherIncomeExposureAtMost).toFixed(2)}`
      );
      for (const line of report.subtypeDisclosure.notices) {
        csvLines.push(`${csvVal('Warning')},${csvVal('')},${csvVal(line)},${csvVal('')}`);
      }
      for (const a of report.subtypeDisclosure.accounts) {
        csvLines.push(
          `${csvVal('Warning')},${csvVal(a.accountCode)},${csvVal(`${a.accountName} — ${reasonLabel(a.reason)}`)},${Number(a.amount).toFixed(2)}`
        );
      }
      if (report.subtypeDisclosure.unnamedAccounts > 0) {
        csvLines.push(
          `${csvVal('Warning')},${csvVal('')},${csvVal(`and ${report.subtypeDisclosure.unnamedAccounts} further affected account(s)`)},${csvVal('')}`
        );
      }
      csvLines.push(
        `${csvVal('Warning')},${csvVal('')},${csvVal('The amounts above are repeated elsewhere in this file — do not add them again.')},${csvVal('')}`
      );
    }

    const csv = csvLines.join('\n');
    const filename = `income-statement-${periodStart}-to-${periodEnd}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export income statement', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export income statement');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
