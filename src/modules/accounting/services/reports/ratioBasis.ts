/**
 * When a financial ratio cannot be computed, and what to say about it.
 *
 * AN-07: `safeDiv` returns 0 for a zero denominator and a sign-flipped number
 * for a negative one, so every ratio dividing by equity silently produced a
 * reading for an insolvent company. Because debt-to-equity is scored
 * lower-is-better, that reading was the healthiest possible one — insolvency
 * presented as excellent gearing.
 *
 * A ratio with a non-positive denominator is not merely unusual, it is
 * arithmetically meaningless, and the honest output is no number plus a reason.
 */

/** Ratio fields whose denominator is total equity. */
export const EQUITY_DIVIDED_RATIOS = [
  'debtToEquity',
  'returnOnEquity',
  'equityMultiplier',
  'dupontLeverage',
] as const;

/**
 * Why an equity-divided ratio cannot be reported, or null if it can.
 *
 * Zero and negative equity are DIFFERENT conditions and both are fatal to the
 * arithmetic, so they share the null but not the wording. Zero means there is
 * no equity base to express anything as a proportion of. Negative means
 * liabilities exceed assets, and the sign flip inverts the ranking so that a
 * worse company scores better — which is the specific harm here.
 */
export function equityBasisFailure(totalEquity: number): string | null {
  if (totalEquity < 0) {
    return 'Equity is negative — liabilities exceed assets, so this ratio inverts and cannot be ranked.';
  }
  if (totalEquity === 0) {
    return 'There is no equity to divide by, so this ratio has no meaning.';
  }
  return null;
}

/** `{ ratioField: reason }` for every equity-divided ratio, or `{}` when equity is sound. */
export function equityNotMeaningful(totalEquity: number): Record<string, string> {
  const reason = equityBasisFailure(totalEquity);
  if (!reason) return {};
  return Object.fromEntries(EQUITY_DIVIDED_RATIOS.map((k) => [k, reason]));
}

/** Why a ratio on a base that is zero or negative is not stated. */
/** Bases whose name is plural, so the reason says "are": "Total assets is
 *  not positive" printed on the management pack. */
const PLURAL_BASES: ReadonlySet<string> = new Set([
  'Total assets', 'Current liabilities', 'Net operating assets', 'Accounts receivable', 'Accounts payable',
]);

export function notPositive(base: string): string {
  return `${base} ${PLURAL_BASES.has(base) ? 'are' : 'is'} not positive, so this ratio has no meaning.`;
}

/**
 * The chart of accounts classifies no inventory at all (`inventoryClassified`
 * false), so an inventory of nil is not a measurement. The cycle's wording is
 * the board pack's own (`packScorecardMetrics.NO_INVENTORY_CLASSIFIED`), so
 * the two packs say the same thing of the same company.
 */
export const NO_INVENTORY_CLASSIFIED =
  'No inventory could be identified in the chart of accounts, so this ratio cannot be computed.';
export const NO_INVENTORY_CLASSIFIED_CYCLE =
  'No inventory could be identified in the chart of accounts, so the cash conversion cycle cannot be computed.';

/**
 * TWO DIFFERENT ABSENCES, AND THE ENGINE MUST NOT CONFUSE THEM.
 *
 * `notCaptured` — the caller did not supply the input (`undefined`). That is
 * a fact about the REPORT: it did not read the interest accounts, it carries
 * no head count. The engine cannot say the company has none.
 *
 * `noneRecorded` — the input was supplied and is nil. That is a fact about
 * the LEDGER in the period, and only a caller that read it can make it true.
 *
 * It used to say "No interest expense is recorded" for both, so a pack that
 * never looked told a client their company paid no interest.
 */
export function notCaptured(input: string): string {
  return `${input} is not captured in this report, so this ratio cannot be stated.`;
}

export function noneRecorded(input: string): string {
  return `No ${input} recorded in the period, so this ratio cannot be stated.`;
}

/** Why cover on NET interest is not stated where interest earned is at least interest paid. */
export const NET_INTEREST_IS_INCOME =
  'Interest income is at least interest expense in the period, so there is no net interest cost to cover.';

/** Why a ratio built from other ratios is not stated when one of them is not. */
/** A reversal or refund larger than the period's charge: not "none recorded". */
export const INTEREST_IS_NET_CREDIT =
  'Interest expense is a net credit in the period, so cover on it is not meaningful.';

/**
 * Inventory turnover where no stock is held: cost of sales over nil has no
 * value, while inventory days on the same figures is exactly nil. Said so the
 * two rows read as one statement rather than as a contradiction.
 */
export const NO_STOCK_HELD =
  'No inventory is held, so there is no stock to turn over; inventory days are nil.';

export function dependsOnUnstated(parts: string): string {
  return `Not stated: it depends on ${parts}, and one of them could not be stated.`;
}

/**
 * Why no free cash flow is stated. It is operating cash flow less capital
 * expenditure, and no caller supplies capex: the cash flow statement nets
 * acquisitions against disposals. An absent capex read as zero printed
 * operating cash flow under the name "free cash flow".
 */
export const NO_FREE_CASH_FLOW =
  'Not stated: capital expenditure is not captured separately from other investing cash flows.';

/** Why no operating cash flow ratio is stated where no cash flow was read. */
export const NO_OPERATING_CASH_FLOW_RATIO =
  'Not stated: no operating cash flow figure was read for this period.';
