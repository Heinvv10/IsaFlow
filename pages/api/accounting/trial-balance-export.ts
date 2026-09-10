/**
 * Trial Balance Export API
 * GET — export trial balance as CSV
 *
 * Columns are opening / movement / closing per account. Closing is the balance
 * (cumulative for balance-sheet accounts, year-to-date for income-statement
 * ones) — see trialBalanceService.ts. It used to export one period's turnover
 * under a "Debit"/"Credit" heading.
 * Optional cost_centre_id and business_unit_id filters are cumulative.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { getTrialBalanceReport } from '@/modules/accounting/services/gl/trialBalanceService';
import { csvVal } from '@/lib/csv';
import { isUuidParam } from '@/lib/validation';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const fiscalPeriodId = req.query.fiscal_period_id as string;
  const costCentreId = req.query.cost_centre_id as string | undefined;
  const businessUnitId = req.query.business_unit_id;
  if (businessUnitId !== undefined && !isUuidParam(businessUnitId)) {
    return apiResponse.badRequest(res, 'business_unit_id must be a valid UUID');
  }
  if (!fiscalPeriodId) return apiResponse.badRequest(res, 'fiscal_period_id is required');

  try {
    type CompanyRow = { name: string };
    type PeriodRow = { name: string; start_date: unknown; end_date: unknown };
    const [[companyRows, periodRows], report] = await Promise.all([
      Promise.all([
        sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1` as Promise<CompanyRow[]>,
        sql`SELECT period_name AS name, start_date, end_date FROM fiscal_periods WHERE id = ${fiscalPeriodId}::UUID AND company_id = ${companyId}::UUID LIMIT 1` as Promise<PeriodRow[]>,
      ]),
      getTrialBalanceReport(companyId, fiscalPeriodId, {
        costCentreId: costCentreId || undefined,
        businessUnitId,
      }),
    ]);
    const { rows, totalDebit, totalCredit, difference, balanced } = report;
    const companyName = companyRows[0]?.name ?? 'Company';
    const period = periodRows[0];
    const periodLabel = period
      ? `${period.name} (${String(period.start_date).slice(0, 10)} – ${String(period.end_date).slice(0, 10)})`
      : fiscalPeriodId;
    const today = new Date().toLocaleDateString('en-ZA');

    // totalDebit / totalCredit / difference / balanced come from the service.
    const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((acc, r) => acc + pick(r), 0);
    const totalOpeningDebit = sum(r => r.openingDebit ?? 0);
    const totalOpeningCredit = sum(r => r.openingCredit ?? 0);
    const totalMovementDebit = sum(r => r.periodDebit ?? 0);
    const totalMovementCredit = sum(r => r.periodCredit ?? 0);

    const csvLines = [
      `${csvVal(companyName)}`,
      `Trial Balance`,
      `Period: ${csvVal(periodLabel)}`,
      `Generated: ${csvVal(today)}`,
      ``,
      'Account Code,Account Name,Account Type,Normal Balance,Opening Debit,Opening Credit,Movement Debit,Movement Credit,Closing Debit,Closing Credit',
      ...rows.map(r =>
        [
          csvVal(r.accountCode), csvVal(r.accountName), csvVal(r.accountType), csvVal(r.normalBalance),
          (r.openingDebit ?? 0).toFixed(2), (r.openingCredit ?? 0).toFixed(2),
          (r.periodDebit ?? 0).toFixed(2), (r.periodCredit ?? 0).toFixed(2),
          r.debitBalance.toFixed(2), r.creditBalance.toFixed(2),
        ].join(',')
      ),
      `${csvVal('')},${csvVal('TOTALS')},${csvVal('')},${csvVal('')},${totalOpeningDebit.toFixed(2)},${totalOpeningCredit.toFixed(2)},${totalMovementDebit.toFixed(2)},${totalMovementCredit.toFixed(2)},${totalDebit.toFixed(2)},${totalCredit.toFixed(2)}`,
      ``,
      `${csvVal('Check')},${csvVal(balanced ? 'Balanced' : 'OUT OF BALANCE')},${csvVal('Difference (should be 0)')},${csvVal('')},${csvVal('')},${csvVal('')},${csvVal('')},${csvVal('')},${difference.toFixed(2)},`,
      `${csvVal('Accounts')},${csvVal(String(report.accountCount))},${csvVal('Income statement measured from')},${csvVal(report.fiscalYearStart)},,,,,,`,
    ];

    const csv = csvLines.join('\n');
    const filename = `trial-balance-${String(period?.start_date ?? fiscalPeriodId).slice(0, 7)}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export trial balance', { error: err }, 'accounting-api');
    return apiResponse.internalError(res, err, 'Failed to export trial balance');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
