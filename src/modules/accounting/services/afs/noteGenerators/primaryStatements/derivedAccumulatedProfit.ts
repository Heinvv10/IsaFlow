/**
 * The accumulated profit the Statement of Financial Position derives.
 *
 * The SFP sums the ledger's balance-sheet accounts, which hold no profit of an unclosed year, and
 * the posted year-end close (source 'year_end') is skipped by every report (G-01), so the
 * retained-earnings account carries neither. The balance sheet service injects the profit to the
 * date onto equity for exactly that reason (`calculateRetainedEarnings`), and the SFP takes it from
 * the same function, on the same "Accumulated profit (loss)" line the retained-earnings account is
 * mapped to, so the two statements cannot name different equity.
 *
 * Amounts are raw debit-minus-credit like every other SFP line, so a profit is negative.
 *
 * The income statement's twin lives below: `addDerivedOpeningAccumulatedIncome` (the "beginning of year"
 * line IS485's running chain needs), moved here from _helpers.ts to keep that file under 300 lines.
 */

import { sql } from '@/lib/neon';
import { getRetainedEarningsBroughtForward } from '@/modules/accounting/services/gl/trialBalanceBasis';
import { calculateRetainedEarnings } from '@/modules/accounting/services/reports/balanceSheetService';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';
import type { SectionLine } from './_helpers';

/** The taxonomy's "Accumulated profit (loss)" line and its parent header. */
const ACCUMULATED_PROFIT_CODE = 'BS045';
const CAPITAL_AND_RESERVES_CODE = 'BS041';
const TOTAL_EQUITY_CODE = 'BS048';
/** Code of the derived line, for a taxonomy without BS045. */
export const DERIVED_ACCUMULATED_PROFIT_CODE = 'BSACCPL';

export async function addDerivedAccumulatedProfit(
  lines: SectionLine[],
  companyId: string,
  end: string,
  priorEnd: string | null,
): Promise<SectionLine[]> {
  const [current, prior] = await Promise.all([
    calculateRetainedEarnings(companyId, end),
    priorEnd === null ? Promise.resolve(0) : calculateRetainedEarnings(companyId, priorEnd),
  ]);
  const target = lines.find((l) => l.code === ACCUMULATED_PROFIT_CODE);
  if (target) {
    return lines.map((l) => (l === target
      ? { ...l, currentAmount: l.currentAmount - current, priorAmount: l.priorAmount - prior }
      : l));
  }
  const total = lines.find((l) => l.code === TOTAL_EQUITY_CODE);
  if (!total) return lines;
  return [...lines, {
    code: DERIVED_ACCUMULATED_PROFIT_CODE,
    label: 'Accumulated profit (loss) (derived)',
    parentCode: CAPITAL_AND_RESERVES_CODE,
    noteNumber: null,
    sortOrder: total.sortOrder - 0.5,
    isHeader: false,
    isTotal: false,
    currentAmount: -current,
    priorAmount: -prior,
    totalBasis: 'children',
    totalComponents: null,
  }];
}

/**
 * Code for the DERIVED opening-accumulated-income line on the income
 * statement. Deliberately not a seeded taxonomy code: no GL account maps to
 * it, it is computed, and giving it a code an accountant could map would
 * invite exactly that.
 *
 * Mirrors what trialBalanceBasis does for its brought-forward row.
 */
export const ACCUMULATED_BF_CODE = 'ISACCBF';

/**
 * The taxonomy's "Accumulated income (loss) end of year" line — the running
 * total the derived opening balance feeds.
 */
const ACCUMULATED_EOY_CODE = 'IS485';

/**
 * Accumulated income at the start of a period: what has been posted to equity
 * retained-earnings accounts, plus every prior year's result as the ledger's
 * revenue and expense accounts still carry it.
 *
 * Both halves are needed for the same reason the balance sheet needs both. The
 * posted year-end close (source 'year_end') is skipped on BOTH halves
 * (YEAR_END_JOURNAL_SOURCE): the derived half already counts the year it
 * transfers, so reading its retained-earnings credit as well counted it twice.
 *
 * Returned CREDIT-POSITIVE, like retained earnings itself.
 */
async function fetchOpeningAccumulatedIncome(
  companyId: string,
  beforeDate: string,
): Promise<number> {
  const [postedRows, broughtForward] = await Promise.all([
    sql`
      SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::numeric AS balance
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga        ON ga.id = jl.gl_account_id
      WHERE je.status     = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::uuid
        AND jl.company_id = ${companyId}::uuid
        AND ga.company_id = ${companyId}::uuid
        AND ga.account_type = 'equity'
        AND ga.account_subtype = 'retained_earnings'
        AND je.entry_date < ${beforeDate}::date
    ` as unknown as Promise<Array<{ balance: string | number }>>,
    getRetainedEarningsBroughtForward(companyId, beforeDate),
  ]);

  return Number(postedRows[0]?.balance ?? 0) + broughtForward;
}

/**
 * The income statement's derived "Accumulated income (loss) beginning of year" line (IS485's running chain
 * needs an opening figure among the lines before it). Appended, so the caller re-sorts.
 */
export async function addDerivedOpeningAccumulatedIncome(
  lines: SectionLine[],
  companyId: string,
  start: string,
  priorStart: string | null,
): Promise<SectionLine[]> {
  const out = [...lines];
  // IS485 "Accumulated income (loss) end of year" is a RUNNING total, so it
  // is the previous total plus the lines between. Without an opening
  // accumulated figure among those lines it reports only THIS year's
  // retained profit under a label that promises the accumulated balance —
  // 60,000 for a company whose real accumulated income is 960,000, with the
  // error growing every year it trades, on the one line a reader is most
  // likely to tie back to retained earnings on the balance sheet.
  //
  // The taxonomy has no line for it, and no GL account maps to one, so it is
  // derived here and inserted where the running chain will pick it up:
  // after IS480 (Net income after taxation, 5800) and before IS485 (5850).
  //
  // Amounts are raw debit-minus-credit, in which a credit-positive
  // accumulated income is negative.
  const [openingCurrent, openingPrior] = await Promise.all([
    fetchOpeningAccumulatedIncome(companyId, start),
    priorStart === null
      ? Promise.resolve(0)
      : fetchOpeningAccumulatedIncome(companyId, priorStart),
  ]);

  // Positioned RELATIVE to the accumulated-income total, never on a fixed
  // sort_order: seedDefaultTaxonomy numbers lines by array index, so IS485
  // sits at 1770 for a seeded company and 5850 in production. A hard-coded
  // number lands on the wrong side of it in one of the two.
  const accumulatedTotal = out.find((l) => l.code === ACCUMULATED_EOY_CODE);

  if (accumulatedTotal !== undefined) {
    out.push({
      code: ACCUMULATED_BF_CODE,
      label: 'Accumulated income (loss) beginning of year',
      parentCode: null,
      noteNumber: null,
      // Immediately before the total it feeds, and therefore after every
      // line the running chain has already consumed.
      sortOrder: accumulatedTotal.sortOrder - 0.5,
      isHeader: false,
      isTotal: false,
      currentAmount: -openingCurrent,
      priorAmount: -openingPrior,
      totalBasis: 'children',
      totalComponents: null,
    });
  }
  return out;
}
