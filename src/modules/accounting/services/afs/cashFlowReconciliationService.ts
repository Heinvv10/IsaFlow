import { log } from '@/lib/logger';
import { getCashFlowDirect } from './cashFlowDirectService';
import { getCashBalance } from '../bank/cashBalanceService';
import { getIndirectCashFlow } from '../reports/cashFlowIndirectService';
import { toMoney } from '@/lib/money/decimalSum';

export interface CashFlowReconciliation {
  periodStart: string;
  periodEnd: string;
  directClosing: number;
  indirectClosing: number;
  bankBalance: number;
  variance: number;
  isReconciled: boolean;
}

const TOLERANCE = 0.01;

// The indirect closing is what the REAL indirect statement's journals reach (the Reports screen's, from
// cashFlowIndirectService), compared with the ledger cash. It used to return the ledger cash itself, so the
// "indirect vs direct vs bank" check could never fail. The statement always closes on the ledger's cash, so the closing its
// journals reach is `closingCash - unexplainedDifference`: equal to the ledger's on sound books, different when they do not tie.
async function fetchIndirectClosingCash(companyId: string, periodStart: string, periodEnd: string): Promise<number> {
  const cf = await getIndirectCashFlow(companyId, periodStart, periodEnd);
  return toMoney(cf.closingCash - cf.unexplainedDifference);
}

// `cash.balance.v1`. Its own copy of this query signed each account by its
// user-set `normal_balance`, summing a credit-normal cash account as negative
// cash and reporting a variance on correct books (K-091g).
async function fetchBankBalance(companyId: string, asAtDate: string): Promise<number> {
  return (await getCashBalance(companyId, asAtDate)).total;
}

export async function getCashFlowReconciliation(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CashFlowReconciliation> {
  try {
    const [directReport, indirectClosing, bankBalance] = await Promise.all([
      getCashFlowDirect(companyId, periodStart, periodEnd),
      fetchIndirectClosingCash(companyId, periodStart, periodEnd),
      fetchBankBalance(companyId, periodEnd),
    ]);

    const directClosing = directReport.closingCash;
    const variance = Math.max(
      Math.abs(directClosing - bankBalance),
      Math.abs(indirectClosing - bankBalance),
      Math.abs(directClosing - indirectClosing),
    );
    const isReconciled = variance < TOLERANCE;

    if (!isReconciled) {
      log.warn('Cash flow reconciliation variance detected', {
        companyId, periodStart, periodEnd, directClosing, indirectClosing, bankBalance, variance,
      }, 'accounting');
    }

    return { periodStart, periodEnd, directClosing, indirectClosing, bankBalance, variance, isReconciled };
  } catch (err) {
    log.error('Failed to generate cash flow reconciliation', { error: err }, 'accounting');
    throw err;
  }
}
