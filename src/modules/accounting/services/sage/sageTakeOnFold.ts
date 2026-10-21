/**
 * Balance-sheet-only opening trial balance, for when Sage's financial year and
 * IsaFlow's fiscal year holding the cut-over date start on different days
 * (Hein, 2026-10-21: take it on rather than block).
 *
 * Sage's trial balance runs from ITS year start to the cut-over date, so its
 * income and expense lines are a part-year IsaFlow's year does not line up
 * with. They are not posted: their net — this year's profit (or loss) to date —
 * goes onto Retained Earnings instead, with the opening balances at the
 * cut-over date. IsaFlow then shows no P&L before the cut-over, and the
 * balance sheet is the same.
 *
 * Why Retained Earnings and not Opening Balance Equity: OBE here is the
 * take-on CLEARING account — the AR/AP documents post the opposite of the
 * clearing line, so it nets to zero (sageTakeOnAccounts). Profit earned is
 * equity proper, accumulated with the prior years' Retained Income Sage already
 * carries on the same account; parked on OBE it would sit there as an
 * unexplained balance for ever. A year-end close would move it to the same
 * place. Pure.
 */
import type { GLAccountType } from '@/modules/accounting/types/gl.types';
import type { AccountImportRow } from '../core/migrationCoaService';
import type { OpeningBalanceRow } from '../core/migrationWizardOpeningBalanceService';
import { round2 } from './sageTakeOnTypes';

const PROFIT_AND_LOSS: ReadonlySet<GLAccountType> = new Set<GLAccountType>(['revenue', 'expense']);

/** The lines without their income and expense, the profit to date (credit minus debit) folded onto `retainedEarningsCode`. */
export function foldProfitAndLoss(
  lines: readonly OpeningBalanceRow[], accounts: readonly AccountImportRow[], retainedEarningsCode: string,
): { lines: OpeningBalanceRow[]; profit: number } {
  const typeOf = new Map(accounts.map((a) => [a.accountCode, a.accountType]));
  let profit = 0;
  let equity = 0;
  const kept: OpeningBalanceRow[] = [];
  for (const l of lines) {
    const type = typeOf.get(l.accountCode);
    if (type && PROFIT_AND_LOSS.has(type)) { profit += l.credit - l.debit; continue; }
    if (l.accountCode === retainedEarningsCode) { equity += l.credit - l.debit; continue; }
    kept.push(l);
  }
  const net = round2(equity + profit);
  if (net !== 0) kept.push({ accountCode: retainedEarningsCode, debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0 });
  return { lines: kept, profit: round2(profit) };
}
