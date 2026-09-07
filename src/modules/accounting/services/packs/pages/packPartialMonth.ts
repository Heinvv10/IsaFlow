/**
 * THE MONTH AT THE END OF THE SERIES THAT IS NOT A MONTH.
 *
 * A pack's reporting period ends on a DATE, and the trend runs twelve
 * calendar months to the month containing it. Run to 7 September, the last
 * of those twelve covers seven days — and the rendered pack drew it, totalled
 * it and quoted it as the current position with nothing anywhere saying so.
 * What that produced, on page 10 of the live demo pack:
 *
 *   "Gross margin fell from 5323.5% to 100.0% over 3 periods"
 *
 * 100.0% is that stub: revenue of 30 and no cost of sales yet posted. It is
 * the terminal point of the drawn line, and it is the figure a director
 * repeats back in a meeting. The same seven days set the end of the revenue
 * panel, the operating-expenses panel and the debtor-days panel, and the last
 * row of page 5's table.
 *
 * THE MONTH IS KEPT AND MARKED, rather than dropped. It is real posted
 * movement inside the period the pack reports on, and a series that stopped
 * at the last whole month would end in August on a pack whose footer says
 * 7 September — reporting a different window from the one it names. What was
 * missing was the marking, so this module owns it: one form of words, used by
 * the row label, the panel axes, the sentences that quote a terminal value,
 * and the basis of preparation.
 *
 * ONE MODULE BECAUSE IT IS ONE CLAIM. The marker appears on four pages; four
 * copies of it is four chances for the sheet and the sentence to describe the
 * same seven days differently, which is the defect class this pack has spent
 * a dozen commits closing.
 */
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

/** The stub at the end of the series, or null where the last month is whole.
 *  Only the last month can be partial — the window opens on a month start
 *  and only its upper bound is clamped — but this asks the points rather than
 *  assuming the position. */
export function partialMonthOf(trend: PackTrendPoint[]): PackTrendPoint | null {
  return trend.find((point) => point.partial) ?? null;
}

/**
 * A MONTH AS A LABEL, marked where it is a stub.
 *
 * Short deliberately: it is a table row label, an 83mm panel's axis tick and
 * a month named inside a sentence, and the fraction ("7 of 30 days") belongs
 * in the prose that has room to carry it. What this has to do is stop a
 * reader taking the row for a whole month at a glance.
 */
export function monthLabel(point: PackTrendPoint): string {
  return point.partial ? `${point.label} (part)` : point.label;
}

/**
 * The clause a sentence quoting this month's figure carries.
 *
 * Every derived sentence that ends on a terminal value takes this — the panel
 * titles on page 10, the closing-cash line on page 8, page 5's own headline —
 * so a value read off seven days is never stated as a current position
 * without saying what it is. One sentence, because a panel title is drawn
 * inside its own 30mm box and every line of it is a line the chart loses.
 */
export function partialMonthClause(point: PackTrendPoint): string {
  return `${point.label} is a part month: it covers ${point.daysCovered} of its `
    + `${point.daysInMonth} days, so its figure is not comparable with the months before it.`;
}

/** The same clause, or nothing, for a caller holding a whole series. */
export function partialMonthClauseFor(trend: PackTrendPoint[]): string | null {
  const point = partialMonthOf(trend);
  return point === null ? null : partialMonthClause(point);
}

/**
 * WHAT THE BASIS OF PREPARATION HAS TO SAY ABOUT IT.
 *
 * The basis page states the standard, the period, the comparative, the
 * currency, the source system and both timestamps, and said nothing about the
 * one month of the series that is not measured over the same window as the
 * other eleven.
 *
 * IT EXTENDS THE PERIOD FACT RATHER THAN ADDING A CAVEAT, and the reason is
 * both editorial and mechanical. Editorially it is a statement about the
 * WINDOW a figure was measured over, which is what the Period line is for; a
 * caveat qualifies the figures themselves. Mechanically the caveats block is
 * a single column at 9.5pt over the full measure, so the shortest possible
 * caveat still costs page 12 six and a half millimetres — and that page fits
 * with tenths to spare on Brightsphere. As a caveat it made the fitter drop
 * all eight basis facts, the ledger version among them.
 *
 * SHORT, THEREFORE. Which month and how much of it; what "(part)" means where
 * it prints is the marker's own job, on the pages that carry it.
 */
export function partialMonthBasisNote(point: PackTrendPoint): string {
  // SHORTER STILL, BY ONE CLAUSE. "…, to the reporting date" restated what
  // the Period fact it EXTENDS has already said two lines above, and the
  // sentence is charged against a page that composes within 2mm of its box on
  // the live company: with the fixtures finally carrying the part month, the
  // one that also rounds its EBITDA bridge lost the colour key to it.
  return `The series ends on a part month: ${point.label} covers ${point.daysCovered} of its `
    + `${point.daysInMonth} days.`;
}
