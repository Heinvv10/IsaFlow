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
