/**
 * Which posted eliminations the consolidated trial balance applies, and where (D4 round 3).
 *
 * Members' income statements run from the start of the fiscal year containing the range END,
 * and their profit before it sits on Retained Earnings b/f. Eliminations follow the same floor,
 * or the group misstates revenue (a prior-year intercompany sale eliminated against this year's
 * revenue) and stops footing (a dividend's P&L leg dropped while its equity leg is kept):
 *
 *   - balance-sheet legs: every adjustment ending on or before the range end (cumulative);
 *   - P&L legs of adjustments ending on or after the floor: applied to the P&L rows;
 *   - P&L legs of earlier adjustments: folded into Retained Earnings b/f, as members' profit is.
 *
 * Every posted adjustment up to the range end lands somewhere, and each one balances, so the
 * elimination column foots for any range. An adjustment is dated by its period_end.
 *
 * The floor is ONE date for the group: the fiscal year of the holding company (getGroupMembers
 * lists it first), the group's reporting year. Members on other year ends are already flagged
 * `coterminous: false`; their own rows keep their own floors.
 */

import { round2 } from '../gl/trialBalanceBasis';
import { getPostedEliminations, type EliminationLineWithAccount } from './consolidatedTrialBalanceService';

/** The earliest date the ledger can hold — "since inception" for a range query. */
const INCEPTION = '1900-01-01';

const BALANCE_SHEET_TYPES = new Set(['asset', 'liability', 'equity']);

export interface PlacedEliminations {
  /** Legs applied to their own group accounts. */
  rows: EliminationLineWithAccount[];
  /** P&L legs dated before the floor, summed: they belong on Retained Earnings b/f. */
  broughtForward: { debit: number; credit: number };
}

export async function eliminationsOnFloor(groupId: string, periodEnd: string, floor: string): Promise<PlacedEliminations> {
  const rows: EliminationLineWithAccount[] = [];
  const broughtForward = { debit: 0, credit: 0 };
  for (const elim of await getPostedEliminations(groupId, INCEPTION, periodEnd)) {
    if (BALANCE_SHEET_TYPES.has(elim.groupAccountType) || elim.adjustmentPeriodEnd >= floor) {
      rows.push(elim);
    } else {
      broughtForward.debit = round2(broughtForward.debit + elim.debit);
      broughtForward.credit = round2(broughtForward.credit + elim.credit);
    }
  }
  return { rows, broughtForward };
}
