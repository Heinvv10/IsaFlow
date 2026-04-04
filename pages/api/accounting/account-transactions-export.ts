/**
 * Account Transactions Export API
 * GET — export general ledger account detail as CSV
 *   ?account_code=XXXX           (required)
 *   ?period_start=YYYY-MM-DD     (required)
 *   ?period_end=YYYY-MM-DD       (required)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAccountTransactions } from '@/modules/accounting/services/transactionReportingService';
import { csvCell } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);

  const { companyId } = req as CompanyApiRequest;
  const accountCode = req.query.account_code as string;
  const periodStart = req.query.period_start as string;
  const periodEnd = req.query.period_end as string;

  if (!accountCode) return apiResponse.badRequest(res, 'account_code is required');
  if (!periodStart) return apiResponse.badRequest(res, 'period_start is required');
  if (!periodEnd) return apiResponse.badRequest(res, 'period_end is required');

  try {
    const report = await getAccountTransactions(companyId, accountCode, periodStart, periodEnd);

    const csvLines = [
      `Date,Entry Number,Description,Debit,Credit,Balance,Source`,
      // Opening balance sentinel row
      [
        csvCell(periodStart),
        csvCell(''),
        csvCell('Opening Balance'),
        '',
        '',
        report.openingBalance.toFixed(2),
        csvCell(''),
      ].join(','),
      // Transaction rows
      ...report.transactions.map(r =>
        [
          csvCell(r.date),
          csvCell(r.entryNumber),
          csvCell(r.description),
          r.debit > 0 ? r.debit.toFixed(2) : '',
          r.credit > 0 ? r.credit.toFixed(2) : '',
          r.balance.toFixed(2),
          csvCell(r.source),
        ].join(',')
      ),
      // Closing balance sentinel row
      [
        csvCell(periodEnd),
        csvCell(''),
        csvCell('Closing Balance'),
        '',
        '',
        report.closingBalance.toFixed(2),
        csvCell(''),
      ].join(','),
    ];

    const csv = csvLines.join('\n');
    const filename = `account-transactions-${accountCode}-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export account transactions', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export account transactions');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
