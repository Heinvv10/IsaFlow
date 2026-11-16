/**
 * Bank Transactions Export API
 * GET — export bank account transaction ledger as CSV
 *   ?period_start=YYYY-MM-DD
 *   ?period_end=YYYY-MM-DD
 *   ?account_code=1110           (optional, defaults to '1110'; must be one of this company's BANK accounts)
 *
 * Bounded like the all-accounts export: dates must be real ledger dates, a bank account only (the GL ledger of any
 * other account is the General Ledger report's business), at most BANK_TX_LEDGER_EXPORT_MAX_ROWS rows (400 beyond:
 * narrow the period), and a per-company rate limit.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { getBankTransactions } from '@/modules/accounting/services/reports/transactionReportingService';
import { csvCell } from '@/lib/csv';
import { sql } from '@/lib/neon';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { BANK_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';
import { isLedgerDate, LEDGER_DATE_MESSAGE } from '@/modules/accounting/services/gl/ledgerDateRange';

export const BANK_TX_LEDGER_EXPORT_MAX_ROWS = 50_000;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;

  const periodStart = req.query.period_start;
  const periodEnd = req.query.period_end;
  const accountCodeRaw = req.query.account_code;
  const accountCode = typeof accountCodeRaw === 'string' && accountCodeRaw !== '' ? accountCodeRaw : '1110';

  if (!periodStart) return apiResponse.badRequest(res, 'period_start is required');
  if (!periodEnd) return apiResponse.badRequest(res, 'period_end is required');
  if (!isLedgerDate(periodStart) || !isLedgerDate(periodEnd)) {
    return apiResponse.badRequest(res, `period_start and period_end: ${LEDGER_DATE_MESSAGE}`);
  }

  // A bank account of THIS company only: the GL ledger of any other account is another report's business.
  const [isBank] = (await sql`
    SELECT 1 AS ok FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND account_code = ${accountCode}
      AND account_subtype = ANY(${BANK_SUBTYPES as string[]})
    LIMIT 1`) as Array<{ ok: number }>;
  if (!isBank) return apiResponse.badRequest(res, 'account_code must be one of your bank accounts');

  if (!(await checkReportRateLimit(companyId, 'bank-transactions-export'))) {
    log.warn('Bank transactions export rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many export requests. Please try again shortly.');
  }

  try {
    const report = await getBankTransactions(companyId, periodStart, periodEnd, accountCode, BANK_TX_LEDGER_EXPORT_MAX_ROWS + 1);
    if (report.transactions.length > BANK_TX_LEDGER_EXPORT_MAX_ROWS) {
      return apiResponse.badRequest(res,
        `More than ${BANK_TX_LEDGER_EXPORT_MAX_ROWS.toLocaleString('en-ZA')} transactions in this period - narrow the period and export again`);
    }

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

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
