/**
 * Trial Balance Export API
 * GET — export trial balance as CSV
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getTrialBalance } from '@/modules/accounting/services/journalEntryService';
import { csvCell } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const fiscalPeriodId = req.query.fiscal_period_id as string;
  if (!fiscalPeriodId) return apiResponse.badRequest(res, 'fiscal_period_id is required');

  try {
    const rows = await getTrialBalance(companyId, fiscalPeriodId);
    const totalDebit = rows.reduce((s, r) => s + r.debitBalance, 0);
    const totalCredit = rows.reduce((s, r) => s + r.creditBalance, 0);

    const csvLines = [
      'Account Code,Account Name,Account Type,Normal Balance,Debit,Credit',
      ...rows.map(r =>
        `${csvCell(r.accountCode)},${csvCell(r.accountName)},${csvCell(r.accountType)},${csvCell(r.normalBalance)},${r.debitBalance.toFixed(2)},${r.creditBalance.toFixed(2)}`
      ),
      `${csvCell('')},${csvCell('TOTALS')},${csvCell('')},${csvCell('')},${totalDebit.toFixed(2)},${totalCredit.toFixed(2)}`,
    ];

    const csv = csvLines.join('\n');
    const filename = `trial-balance-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export trial balance', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export trial balance');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
