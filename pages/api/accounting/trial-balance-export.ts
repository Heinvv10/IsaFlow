/**
 * Trial Balance Export API
 * GET — export trial balance as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { getTrialBalance } from '@/modules/accounting/services/gl/journalEntryService';
import { csvVal } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req as CompanyAuthedRequest;
  const fiscalPeriodId = req.query.fiscal_period_id as string;
  if (!fiscalPeriodId) return apiResponse.badRequest(res, 'fiscal_period_id is required');

  try {
    type CompanyRow = { name: string };
    type PeriodRow = { name: string; start_date: unknown; end_date: unknown };
    const [[companyRows, periodRows], rows] = await Promise.all([
      Promise.all([
        sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1` as Promise<CompanyRow[]>,
        sql`SELECT name, start_date, end_date FROM fiscal_periods WHERE id = ${fiscalPeriodId}::UUID AND company_id = ${companyId}::UUID LIMIT 1` as Promise<PeriodRow[]>,
      ]),
      getTrialBalance(companyId, fiscalPeriodId),
    ]);
    const companyName = companyRows[0]?.name ?? 'Company';
    const period = periodRows[0];
    const periodLabel = period
      ? `${period.name} (${String(period.start_date).slice(0, 10)} – ${String(period.end_date).slice(0, 10)})`
      : fiscalPeriodId;
    const today = new Date().toLocaleDateString('en-ZA');

    const totalDebit = rows.reduce((s, r) => s + r.debitBalance, 0);
    const totalCredit = rows.reduce((s, r) => s + r.creditBalance, 0);

    const csvLines = [
      `${csvVal(companyName)}`,
      `Trial Balance`,
      `Period: ${csvVal(periodLabel)}`,
      `Generated: ${csvVal(today)}`,
      ``,
      'Account Code,Account Name,Account Type,Normal Balance,Debit,Credit',
      ...rows.map(r =>
        `${csvVal(r.accountCode)},${csvVal(r.accountName)},${csvVal(r.accountType)},${csvVal(r.normalBalance)},${r.debitBalance.toFixed(2)},${r.creditBalance.toFixed(2)}`
      ),
      `${csvVal('')},${csvVal('TOTALS')},${csvVal('')},${csvVal('')},${totalDebit.toFixed(2)},${totalCredit.toFixed(2)}`,
      ``,
      `${csvVal('Check')},${csvVal('')},${csvVal('Difference (should be 0)')},${csvVal('')},${(totalDebit - totalCredit).toFixed(2)},`,
    ];

    const csv = csvLines.join('\n');
    const filename = `trial-balance-${String(period?.start_date ?? fiscalPeriodId).slice(0, 7)}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export trial balance', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export trial balance');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
