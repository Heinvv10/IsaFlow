/**
 * A SENTENCE THAT STATES A RELATION MUST TAKE THE RELATION'S RESULT AS AN
 * INPUT, COMPUTED FROM THE FIGURES.
 *
 * Three derived sentences on this branch have now been found false, and all
 * three failed the same way: the clause asserted a relation between two
 * figures while the code only ever tested the CONDITION THAT TRIGGERED THE
 * SENTENCE. Each was true on the demo fixture and false on Brightsphere,
 * which is why three separate reviews passed them.
 *
 *   1. "the trends panel plots the month's net profit, which is larger by the
 *      month's revenue" — fired whenever a month's expenses were a net
 *      credit, and never compared the two figures. Wrong in DIRECTION on
 *      Brightsphere, whose turnover is negative.
 *   2. the min-to-max / first-to-last construction, one form of words for two
 *      different comparisons.
 *   3. "so the month reports a profit the period does not" — fired whenever
 *      expenses were a net credit, and never asked whether the month was in
 *      profit. Brightsphere's April is (1 408) against a period of (1 408):
 *      the same loss, and page 5's own title calls that month the LOWEST of
 *      the twelve.
 *
 * The shape of the fix, in one place so the next sentence of this class has
 * somewhere to be written:
 *
 * - The relation is a `Relation` VALUE, produced by `relationOf` from the two
 *   numbers. Nothing else can make one.
 * - The wording is a `Record<Relation, string>` — TOTAL over the union, so a
 *   caller that has thought about only one case does not compile. That is the
 *   same device `DELTA_ABSENCE` uses in `derivedCaptions.ts`, for the same
 *   reason: the branch a fixture never reaches is the branch that ships
 *   wrong.
 * - The caller cannot get the clause without handing over both figures, so
 *   there is no phrasing under which a sentence can claim a comparison the
 *   code did not take.
 *
 * A test that only ever sees the true case is what let all three ship, so
 * every consumer of this module is pinned against a fixture in which the
 * relation is FALSE as well as one in which it holds.
 */

/**
 * Where a subject figure stands against a reference figure.
 *
 * `equal` is a member rather than a rounding of `below`, because "the same
 * loss" and "a smaller loss" are different sentences to a director — and
 * Brightsphere's April is exactly the equal case.
 */
export type Relation = 'above' | 'below' | 'equal';

/**
 * The tolerance two figures are called equal within: one cent, the same
 * `MONEY_TOLERANCE` the figure-integrity gate compares money at. A pack that
 * calls two figures equal must call them equal by the same rule the gate
 * uses to check them, or the sentence and the gate disagree about one pair
 * of numbers.
 */
const EQUAL_WITHIN = 0.01;

/** The relation, TAKEN FROM THE NUMBERS. The only way to make a `Relation`. */
export function relationOf(subject: number, reference: number): Relation {
  const gap = subject - reference;
  if (Math.abs(gap) <= EQUAL_WITHIN) return 'equal';
  return gap > 0 ? 'above' : 'below';
}

/**
 * The clause for the relation these two figures are actually in.
 *
 * `clauses` is total over `Relation`, so the case a fixture never reaches is
 * a case the author had to write down.
 */
export function statedRelation(
  subject: number,
  reference: number,
  clauses: Record<Relation, string>,
): string {
  return clauses[relationOf(subject, reference)];
}

/**
 * WHETHER A FIGURE IS A PROFIT, on the pack's own convention: above zero is a
 * profit, zero and below is not. Nil is not a profit — a company that broke
 * even to the cent did not report one, and the sentence that says it did is
 * the defect this module exists to close.
 */
export function isProfit(netProfit: number): boolean {
  return netProfit > EQUAL_WITHIN;
}

/**
 * HOW A MONTH'S RESULT STANDS AGAINST THE PERIOD'S — the relation the credit-
 * month matter (`packDerivedMatters.ts`) asserted and never computed.
 *
 * Four cases because there are two figures and each is or is not a profit,
 * and every one of the four is reachable: the demo pack is
 * `profitWherePeriodHasNone` (July +1 908 against a period of (1 544)) and
 * Brightsphere is `lossAsThePeriodDoes` (April (1 408) against a period of
 * (1 408)). The other two are ordinary — a profitable period with a month
 * that lost money, and a profitable period whose credit month is also in
 * profit — and each has its own sentence rather than a shared one, because a
 * shared sentence is how this class of defect is written.
 */
export type ProfitStanding =
  | 'profitWherePeriodHasNone'
  | 'profitAsThePeriodDoes'
  | 'lossWherePeriodHasProfit'
  | 'lossAsThePeriodDoes';

export function profitStanding(monthNetProfit: number, periodNetProfit: number): ProfitStanding {
  const month = isProfit(monthNetProfit);
  const period = isProfit(periodNetProfit);
  if (month) return period ? 'profitAsThePeriodDoes' : 'profitWherePeriodHasNone';
  return period ? 'lossWherePeriodHasProfit' : 'lossAsThePeriodDoes';
}

/**
 * A SUPERLATIVE MUST NAME THE MEASURE IT RANKED ON.
 *
 * The same defect family as `Relation` above, in its fourth appearance on
 * this branch. Page 6's caption read "Operating expenses moved the most, up
 * 102.1%." — true of the percentage column and false of the sentence a board
 * reads. On the same table cost of sales moved 626 against operating
 * expenses' 115: 626 of the 639 total deterioration, five times the money.
 * The caption answered "which line has the largest percentage change" in the
 * words of "which line explains the result".
 *
 * THE MEASURE CHOSEN IS THE MONEY, and the reason is the sheet rather than
 * taste. Page 6 draws a BRIDGE, whose whole argument is that the bars sum to
 * the movement — cost of sales is the tall one — and a caption ranking on
 * percentage puts a sentence under that chart naming a different line from
 * the one the chart points at. Spec §7.1 criterion 6 fails a pack where a
 * chart and the text on the same sheet disagree, and a percentage ranking can
 * produce that disagreement on any company with a small comparative base.
 * Percentage rank measures how far a line moved relative to itself; nothing
 * on this page asks that question.
 *
 * So `Superlative` carries the measure that produced it, `rankedBy` is the
 * only way to make one, and `superlativeClause` is TOTAL over the measure —
 * a caller ranking on money cannot borrow the percentage wording, and adding
 * a measure to the union is a compile error at every call site until its
 * wording is written. Percentage is not deleted from the union: a caption
 * that genuinely ranks percentages must still be able to say so, and a
 * measure that cannot be named is a measure that gets named wrongly.
 */
export type RankedMeasure = 'money' | 'percentage';

export interface Superlative<T> {
  /** The item that ranked highest. */
  readonly winner: T;
  /** ITS value on the ranked measure, carried so the sentence prints the
   *  figure that decided the ranking rather than looking a second one up —
   *  two reads of the same field is one edit away from a superlative stated
   *  about one column and quantified from another. */
  readonly value: number;
  /** What it ranked highest ON — printed, never assumed. */
  readonly measure: RankedMeasure;
}

/**
 * The largest of `items` by the MAGNITUDE of `by`, paired with the measure
 * that ranked them. `null` where nothing carries the measure at all, which is
 * a page with no superlative to state rather than a page whose first row wins
 * by default.
 *
 * Magnitude, not signed value: "moved the most" is about the size of a
 * movement, and a signed maximum makes the largest decline the smallest mover.
 */
export function rankedBy<T>(
  items: readonly T[],
  measure: RankedMeasure,
  by: (item: T) => number | null,
): Superlative<T> | null {
  let found: { winner: T; value: number } | null = null;
  for (const item of items) {
    const value = by(item);
    if (value === null || !Number.isFinite(value)) continue;
    if (found === null || Math.abs(value) > Math.abs(found.value)) found = { winner: item, value };
  }
  return found === null ? null : { ...found, measure };
}

/**
 * "moved the most in …" — the clause that says which ranking was taken.
 *
 * TOTAL over `RankedMeasure`, for the reason the module docblock gives: the
 * branch a fixture never reaches is the branch that ships wrong.
 */
const MEASURE_CLAUSE: Record<RankedMeasure, string> = {
  money: 'moved the most in money',
  percentage: 'moved the most in percentage terms',
};

export function superlativeClause(superlative: Superlative<unknown>): string {
  return MEASURE_CLAUSE[superlative.measure];
}
