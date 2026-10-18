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
 */

import { calculateRetainedEarnings } from '@/modules/accounting/services/reports/balanceSheetService';
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
