/**
 * Bank Transactions Export — all bank accounts
 * GET ?from_date=YYYY-MM-DD&to_date=YYYY-MM-DD (both required, at most
 *   BANK_TX_EXPORT_MAX_DAYS apart) — CSV of every posted statement line in the
 *   range across every bank account, with the allocated account and dimensions.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { isLedgerDate, LEDGER_DATE_MESSAGE } from '@/modules/accounting/services/gl/ledgerDateRange';
import {
  BANK_TX_EXPORT_MAX_DAYS,
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
  if (fromDate > toDate) return apiResponse.badRequest(res, 'from_date must be on or before to_date');
  const days = (Date.parse(toDate) - Date.parse(fromDate)) / DAY_MS + 1;
  if (days > BANK_TX_EXPORT_MAX_DAYS) {
    return apiResponse.badRequest(res, `The range can be at most ${BANK_TX_EXPORT_MAX_DAYS} days`);
  }

  const txs = await getAllBankTransactionsForExport(companyId, fromDate, toDate);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bank-transactions-all-${fromDate}-to-${toDate}.csv"`);
  return res.status(200).send(bankTxExportCsv(txs));
}

export default withAuth(withErrorHandler(handler as any));
