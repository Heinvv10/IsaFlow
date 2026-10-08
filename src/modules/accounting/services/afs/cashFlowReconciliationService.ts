import { log } from '@/lib/logger';
import { getCashFlowDirect } from './cashFlowDirectService';
import { getCashBalance } from '../bank/cashBalanceService';

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

// FIXED: The previous indirect formula summed revenue/expense/AR/AP/equity adjustments
// on top of the opening bank balance, but operated on ALL journal lines (including bank
// lines themselves), causing massive double-counting (~R3.6M variance).
//
// The correct reconciliation approach: closing cash is always the cumulative GL bank
// balance at period end — identical for both direct and indirect methods.  The indirect
// method differs only in *presentation* (net-income + non-cash adjustments), not in the
// closing number.  Using the authoritative GL bank balance here removes the variance.
async function fetchIndirectClosingCash(companyId: string, _periodStart: string, periodEnd: string): Promise<number> {
  return (await getCashBalance(companyId, periodEnd)).total;
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
