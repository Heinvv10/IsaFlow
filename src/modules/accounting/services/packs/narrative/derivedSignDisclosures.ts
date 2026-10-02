/**
 * The derived SIGN disclosures — negative equity, income and cost lines below
 * zero, and asset and liability balances below zero. Moved out of
 * `derivedSentences.ts` unchanged to keep that file under the 300-line cap;
 * `derivedSentences.ts` re-exports every name here, so every existing import
 * path still resolves.
 */

import type { MoneyScale } from '@/lib/format/money';
import { money } from './derivedProseFigures';

/**
 * Spec §3.5's mandatory negative-equity disclosure, in one place.
 *
 * `NegativeEquityBlock.tsx` renders this and the page model carries it, and a
 * second copy of a MANDATORY disclosure is how the two drift until one of
 * them stops matching what the pack actually shows.
 */
export function negativeEquitySentence(equity: number, scale: MoneyScale): string {
  return `Total equity is ${money(equity, scale)}. Liabilities exceed assets by this amount, which may affect covenant compliance and the going-concern assessment.`;
}

/** Which side of the income statement the lines below zero sit on — see
 *  `impossibleIncomeLinesSentence`. */
export type ImpossibleIncomeSide = 'income' | 'cost' | 'both';

const IMPOSSIBLE_INCOME_CAUSE: Record<ImpossibleIncomeSide, string> = {
  income: 'income accounts in net debit, from credit notes or reversals exceeding the period\'s '
    + 'invoicing, or a receipt posted to an income account the wrong way round',
  cost: 'cost accounts in net credit, from a reversal or a refund exceeding the period\'s charges, '
    + 'or a payment posted to an expense account the wrong way round',
  // The arm the live Brightsphere pack takes, and the one the sheet has least
  // room for: naming four lines instead of one already costs page 6 a line of
  // 9.5pt it does not have, and the sheet composes at 258.4mm in a 255mm box
  // if this runs to the length of the two above. What went is the
  // restatement, not a cause a reader has to go looking for.
  both: 'income accounts in net debit and cost accounts in net credit — a reversal, a refund or a '
    + 'posting made the wrong way round',
};

/**
 * The consequence clause, which belongs to REVENUE and to nothing else: it is
 * the denominator of every margin in the pack. Naming it against a negative
 * other-income line would be a statement about a figure nothing divides by.
 */
const NEGATIVE_REVENUE_CONSEQUENCE =
  ' Every margin divides by revenue, so each is reported as not meaningful rather than computed '
  + 'off a negative base.';

/**
 * AND THE THIRD IMPOSSIBLE NUMBER, WHICH GOT NOTHING AT ALL.
 *
 * Brightsphere's pack heads its income statement with revenue of (5 535) and
 * puts the same figure on a highlights tile, with no callout anywhere —
 * while negative ASSETS, two sheets later and no stranger, get a full
 * explanatory block. A pack that explains one anomaly and stays silent about
 * another of the same class reads as though the silent one is normal.
 *
 * Negative turnover is at least as likely to be a posting error as a negative
 * asset side, and it is more consequential: every margin, every ratio with
 * revenue underneath it and the whole scorecard's profitability group are
 * computed off it, and each of them is then reported as not meaningful for a
 * reason the reader has to assemble from footnotes.
 *
 * Same shape as the other two: what it is, what causes it, what it does to
 * the rest of the pack, and that the ledger is reported as it stands.
 *
 * AND IT WAS THE REVENUE LINE ONLY, ON A SHEET WITH FOUR OF THEM.
 *
 * The same asymmetry the balance sheet's check had, one page earlier.
 * Brightsphere's income statement prints revenue of (5 535) under a headed
 * block AND operating expenses of (3 717), other expenses of (411) and other
 * income of (1) with no comment at all — three more lines the wrong side of
 * zero, on the sheet the block is about. They reach the pack's matters page
 * as "months whose expenses are a net credit", eleven sheets later, with
 * nothing on page 6 pointing there.
 *
 * So the check runs over every income and cost line the page prints, the way
 * `impossibleBalancesSentence` runs over every asset and liability row.
 * Subtotals are not in it: a negative gross profit, operating profit or net
 * profit is a real result a real business can post, and folding those in
 * would tell a director that a loss is a posting error.
 *
 * THE TWO SIDES HAVE DIFFERENT CAUSES and are stated separately, because an
 * income account in net debit and a cost account in net credit are different
 * postings to go looking for.
 */
export function impossibleIncomeLinesSentence(
  lines: ReadonlyArray<{ label: string; amount: number }>,
  side: ImpossibleIncomeSide,
  scale: MoneyScale,
  /** Whether REVENUE is one of the lines below zero — see the constant above. */
  revenueIsOne: boolean,
): string {
  const named = lines.map((line, i) => {
    // Sentence case on the first, lower on the rest, so the list reads as one
    // sentence rather than as four run together — `impossibleBalancesSentence`
    // does the same with its own rows.
    const label = i === 0 ? line.label : line.label.toLowerCase();
    return `${label} ${money(line.amount, scale)}`;
  });
  const list = named.length === 1
    ? named[0]!
    : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`;
  return `${list} ${lines.length === 1 ? 'is' : 'are'} below zero: ${IMPOSSIBLE_INCOME_CAUSE[side]}.`
    + `${revenueIsOne ? NEGATIVE_REVENUE_CONSEQUENCE : ''}`
    + ' The ledger is reported as it stands; trace these accounts before relying on this sheet.';
}

/**
 * AND THE FOURTH IMPOSSIBLE NUMBER, WHICH IS A COMPONENT RATHER THAN A TOTAL.
 *
 * Brightsphere's balance sheet prints non-current liabilities of (424) — a
 * NEGATIVE LIABILITY — and says nothing, on a sheet that devotes a titled
 * block to negative total assets and another to negative equity. The pack
 * treats a sign impossibility as worth explaining when it lands on a total
 * and as unremarkable when it lands on a line, and a reader cannot tell that
 * apart from the pack having decided the line is fine.
 *
 * It is the same class and the same remedy: a liability below zero means one
 * or more accounts in that band carry debit balances, which is a
 * classification or a posting question rather than a fact about what the
 * company owes. Stated at the same length and in the same shape as the other
 * three — what it is, what causes it, and that the ledger is reported as it
 * stands — so a reader meeting any of the four gets the same treatment.
 *
 * NAMED, because "a liability" would not say which. Page 7 prints two
 * liability lines and a total; this sentence is built for whichever of them
 * is below zero and states that row's own label.
 */
export type ImpossibleSide = 'assets' | 'liabilities' | 'both';

/**
 * WHY THE BALANCE CANNOT BE WHAT IT SAYS, one clause per side.
 *
 * A `Record` over the union rather than a chain of `if`s — the
 * `CREDIT_MONTH_STANDING` device — so the case a fixture never reaches is one
 * the author still had to write a sentence for. The `both` arm is not the
 * other two concatenated: an asset carrying credits and a liability carrying
 * debits are the same KIND of error and a reader who is told it twice reads
 * two problems.
 */
const IMPOSSIBLE_CAUSE: Record<ImpossibleSide, string> = {
  assets: 'An asset below zero is not a balance a business can hold: it means one or more '
    + 'accounts classified as assets carry credit balances.',
  liabilities: 'A liability below zero is not an amount that can be owed: it means one or more '
    + 'accounts classified as liabilities carry debit balances.',
  // "NONE OF THESE", NOT "NEITHER". The check reaches the memorandum
  // balances now, so this arm can name three figures — Brightsphere's current
  // assets, non-current liabilities and trade receivables — and "neither"
  // counts to two. A word that miscounts the list beneath it is the sort of
  // thing a director reads aloud.
  both: 'None of these is a balance that can be held as stated: it means one or more accounts '
    + 'carry balances contrary to the band they are classified in.',
};

/**
 * THE SIGN CHECK, RUN ON EVERY LINE OF THE BALANCE SHEET RATHER THAN ON TWO
 * OF THEM.
 *
 * The pack checked TOTAL assets and — after the round before this one —
 * COMPONENT liabilities, and nothing else. The asymmetry did exactly what an
 * asymmetry does: Brightsphere's page 7 printed `Non-current liabilities
 * (424)` with a headed block explaining it and `Current assets (3 372)`
 * three rows above with no comment at all, because that pack's total assets
 * are POSITIVE and the asset check only ever looked at the total. The one
 * line that fell through was the largest number it could have fallen
 * through on, on the sheet a director reads for solvency.
 *
 * So the check is over every asset and liability row the page prints,
 * component and total, both sides. Equity is deliberately NOT in it: negative
 * equity is a real position a real business can hold, and it has its own
 * §3.5 disclosure two blocks down.
 *
 * ONE NOTE, NAMING EVERY OFFENDING LINE. Page 7 composes at 253.07mm of 255
 * on BOTH companies — 1.93mm, less than half a line — so a note per line, or
 * a block per side, is paper the sheet does not have on either pack. The
 * lines are listed in one sentence and the cause follows once.
 */
export function impossibleBalancesSentence(
  lines: ReadonlyArray<{ label: string; amount: number }>,
  side: ImpossibleSide,
  scale: MoneyScale,
): string {
  const named = lines.map((l, i) => {
    // The first names its measure in full; the rest are figures under it, so
    // the sentence reads as a list rather than as three sentences run
    // together.
    const label = i === 0 ? `${l.label} are` : l.label.toLowerCase();
    return `${label} ${money(l.amount, scale)}`;
  });
  const list = named.length === 1
    ? named[0]!
    : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`;
  return `${list}. ${IMPOSSIBLE_CAUSE[side]} That is a classification or a posting question `
    + 'rather than a smaller figure, and the pack reports the ledger as it stands: the balances '
    + 'should be resolved before this sheet is relied on.';
}
