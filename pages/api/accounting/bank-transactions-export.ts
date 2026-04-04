/**
 * Bank Transactions Export API
 * GET — export bank account transaction ledger as CSV
 *   ?period_start=YYYY-MM-DD
 *   ?period_end=YYYY-MM-DD
 *   ?account_code=1110           (optional, defaults to '1110')
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getBankTransactions } from '@/modules/accounting/services/transactionReportingService';
import { csvCell } from '@/lib/csv';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyApiRequest;

  const periodStart = req.query.period_start as string;
  const periodEnd = req.query.period_end as string;
  const accountCode = (req.query.account_code as string) || '1110';

  if (!periodStart) return apiResponse.badRequest(res, 'period_start is required');
  if (!periodEnd) return apiResponse.badRequest(res, 'period_end is required');

  try {
    const report = await getBankTransactions(companyId, periodStart, periodEnd, accountCode);

    const csvLines = [
      `Date,Entry Number,Description,Deposit,Withdrawal,Running Balance`,
      // Opening balance sentinel row
      [
        csvCell(periodStart),
        csvCell(''),
        csvCell('Opening Balance'),
        '',
        '',
        report.openingBalance.toFixed(2),
      ].join(','),
      // Transaction rows
      ...report.transactions.map(r =>
        [
          csvCell(r.date),
          csvCell(r.entryNumber),
          csvCell(r.description),
          r.deposit > 0 ? r.deposit.toFixed(2) : '',
          r.withdrawal > 0 ? r.withdrawal.toFixed(2) : '',
          r.runningBalance.toFixed(2),
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
      ].join(','),
    ];

    const csv = csvLines.join('\n');
    const filename = `bank-transactions-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (err) {
    log.error('Failed to export bank transactions', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to export bank transactions');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
