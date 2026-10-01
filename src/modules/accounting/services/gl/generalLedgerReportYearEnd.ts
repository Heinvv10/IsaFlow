/**
 * Year-end handling for the GL report (generalLedgerReportService).
 *
 * - Income-statement accounts whose range crosses a fiscal-year start get a
 *   derived close row at each boundary (gl/fiscalYearCloseRows), so their
 *   closing balance is the trial balance's as at periodEnd.
 * - A derived Retained Earnings b/f account (the TB's RE-BF) opens at the profit
 *   earned before the fiscal year of periodStart and receives each close. Each
 *   balance is signed to its own account's normal side, so the set does not sum
 *   to zero; what holds is that debit-normal balances equal credit-normal balances
 *   (RE-BF included), at the opening and at the closing.
 *
 * Posted totals (`totalDebit` / `totalCredit`) never include derived rows.
 */

import { fiscalYearStartsWithin, isIncomeStatementType, runWithYearEndCloses, yearEndCloseDescription } from './fiscalYearCloseRows';
import type { GeneralLedgerAccountReport, GeneralLedgerTransaction } from './generalLedgerReportService';

interface AccountMeta {
  type: string;
  normalBalance: string;
}

export function withYearEndCloses(
  reports: GeneralLedgerAccountReport[],
  opts: {
    accounts: ReadonlyMap<string, AccountMeta>;
    periodStart: string;
    periodEnd: string;
    fyStartMonth: number;
    retainedEarnings: { accountCode: string; accountName: string; openingBalance: number };
  },
): GeneralLedgerAccountReport[] {
  const boundaries = fiscalYearStartsWithin(opts.periodStart, opts.periodEnd, opts.fyStartMonth);
  // Net debit (debit − credit) of the close rows per fiscal-year end, across accounts.
  const closedPerYearEnd = new Map<string, number>();

  for (const rep of reports) {
    const meta = opts.accounts.get(rep.accountCode);
    if (!meta || !isIncomeStatementType(meta.type) || boundaries.length === 0) continue;
    const { rows, closing } = runWithYearEndCloses(rep.transactions, {
      opening: rep.openingBalance,
      normalBalance: meta.normalBalance,
      boundaries,
      makeClose: (fyEnd, { debit, credit }): GeneralLedgerTransaction => {
        closedPerYearEnd.set(fyEnd, (closedPerYearEnd.get(fyEnd) ?? 0) + debit - credit);
        return {
          date: fyEnd, entryNumber: '', description: yearEndCloseDescription(fyEnd),
          debit, credit, balance: 0, source: 'year_end_close', derived: true,
        };
      },
    });
    rep.transactions = rows;
    rep.closingBalance = closing;
  }

  const { accountCode, accountName, openingBalance } = opts.retainedEarnings;
  let balance = openingBalance;
  const reTransactions: GeneralLedgerTransaction[] = [];
  for (const [fyEnd, netDebitToIncomeStatement] of [...closedPerYearEnd].sort(([a], [b]) => a.localeCompare(b))) {
    const amount = Math.round(Math.abs(netDebitToIncomeStatement) * 100) / 100;
    if (amount === 0) continue;
    // The retained-earnings side of the close is the mirror image.
    const debit = netDebitToIncomeStatement < 0 ? amount : 0;
    const credit = netDebitToIncomeStatement > 0 ? amount : 0;
    balance += credit - debit;
    reTransactions.push({
      date: fyEnd, entryNumber: '', description: yearEndCloseDescription(fyEnd),
      debit, credit, balance, source: 'year_end_close', derived: true,
    });
  }
  if (Math.abs(openingBalance) >= 0.01 || reTransactions.length > 0) {
    reports.push({
      accountCode, accountName, accountType: 'equity', derived: true,
      openingBalance, closingBalance: balance, totalDebit: 0, totalCredit: 0,
      transactions: reTransactions,
    });
  }
  return reports;
}
