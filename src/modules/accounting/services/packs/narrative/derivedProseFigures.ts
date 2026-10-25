/**
 * The two helpers every derived title and disclosure shares: a money figure
 * on its way into a sentence, and a period-on-period change in words. Moved
 * out of `derivedSentences.ts` unchanged to keep that file under the 300-line
 * cap; the scale and percentage rules at the head of that file govern both.
 */

import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { formatStatementFigure, inProse, pctWithWord, type MoneyScale } from '@/lib/format/money';

/**
 * A MONEY FIGURE ON ITS WAY INTO A SENTENCE — always through `inProse`.
 *
 * `formatStatementFigure` prints a measured zero as an en dash, which is right in a
 * money COLUMN and is not a word. Five titles here interpolated it raw, and
 * the consequence was not a dash on paper: `packProseIntegrity`'s zero-glyph
 * rule reads `page.title`, and `assertPackIntegrity` THROWS on a hit — so a
 * company whose net profit, cash or working capital is nil received no pack
 * at all, surfacing as a 422. Reachability is ordinary: a dormant company, a
 * bank account exactly drawn down, current assets equal to current
 * liabilities, or — because the dash covers anything under half a unit of the
 * scale — any of those under five rand at `R'000`.
 *
 * One helper for the whole file rather than eleven `inProse(formatStatementFigure(...))`
 * call sites, because the one that gets forgotten is the eleventh.
 */
export function money(n: number, scale: MoneyScale): string {
  return inProse(formatStatementFigure(n, { scale }));
}

/** A change that rounds to 0.0%: it has no direction to name. A sentence
 *  that says "to" a level after a change says "at" after this. */
export const UNCHANGED = 'unchanged';

/** "up 12.0%" / "down 7.0%" / "unchanged", or null when the base is not usable. */
export function pctChangeClause(current: number, prior: number): string | null {
  const pct = marginPct(current - prior, prior);
  if (pct === null) return null;
  return pctWithWord(pct, 'up', 'down', UNCHANGED);
}
