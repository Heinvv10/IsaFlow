/**
 * Bank Transactions Export — all bank accounts
 * GET ?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD (both required, at most
 *   BANK_TX_EXPORT_MAX_DAYS apart inclusive) — CSV of every posted statement
 *   line in the range across every bank account, with the allocated account
 *   and dimensions. More than BANK_TX_EXPORT_MAX_ROWS rows is refused (400)
 *   rather than built in memory; the caller narrows the range.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { checkReportRateLimit } from '@/lib/rateLimit';
import { isLedgerDate, LEDGER_DATE_MESSAGE } from '@/modules/accounting/services/gl/ledgerDateRange';
import {
  BANK_TX_EXPORT_MAX_DAYS,
  BANK_TX_EXPORT_MAX_ROWS,
  getAllBankTransactionsForExport,
} from '@/modules/accounting/services/bank/bankTxExportAll';
import { bankTxExportCsv } from '@/modules/accounting/services/bank/bankTxExportCsv';

const DAY_MS = 86_400_000;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const fromDate = req.query.from_date;
  const toDate = req.query.to_date;

  if (!isLedgerDate(fromDate) || !isLedgerDate(toDate)) {
    return apiResponse.badRequest(res, `from_date and to_date are required: ${LEDGER_DATE_MESSAGE}`);
  }
  // ISO YYYY-MM-DD strings order the same as the dates they name.
  if (fromDate > toDate) return apiResponse.badRequest(res, 'from_date must be on or before to_date');
  const days = (Date.parse(toDate) - Date.parse(fromDate)) / DAY_MS + 1;
  if (days > BANK_TX_EXPORT_MAX_DAYS) {
    return apiResponse.badRequest(res, `The range can be at most ${BANK_TX_EXPORT_MAX_DAYS} days`);
  }
  if (!(await checkReportRateLimit(companyId, 'bank-transactions-export-all'))) {
    log.warn('Bank transactions export-all rate limit exceeded', { companyId }, 'rateLimit');
    return apiResponse.tooManyRequests(res, 'Too many export requests. Please try again shortly.');
  }

  const txs = await getAllBankTransactionsForExport(companyId, fromDate, toDate, BANK_TX_EXPORT_MAX_ROWS + 1);
  if (txs.length > BANK_TX_EXPORT_MAX_ROWS) {
    return apiResponse.badRequest(res,
      `More than ${BANK_TX_EXPORT_MAX_ROWS.toLocaleString('en-ZA')} transactions in this range - narrow the date range and export again`);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bank-transactions-all-${fromDate}-to-${toDate}.csv"`);
  return res.status(200).send(bankTxExportCsv(txs));
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
