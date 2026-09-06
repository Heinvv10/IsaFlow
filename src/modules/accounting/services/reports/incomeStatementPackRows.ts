/**
 * The report pack's P&L rows — ONE definition, rendered by both the HTML pack
 * and the PDF pack.
 *
 * They had a row list each, and both were short by `otherIncome -
 * otherExpenses`: R341,712.00 on Brightsphere, R53,787.07 on ISAFlow Demo, on
 * documents sent to clients. Two copies of a list is two chances to omit a
 * band, and neither copy could be tested — `renderSectionHtml` and
 * `renderSection` are not exported and take a jsPDF document.
 *
 * Order is the order a reader reconciles: Turnover, Cost of Sales, Gross
 * Profit, Other Income, Operating Expenses, Operating Profit, Other Expenses,
 * Net Profit. Other income sits ABOVE the operating profit that contains it;
 * printing it after made the column fail to reconcile by exactly that amount.
 */

/**
 * The bands, in reconciling order. The stable identity of a row: `label` is
 * display text and may be reworded, `key` may not. Consumers that decide
 * anything from a row — which are totals, what id a row gets — key off this.
 */
export type PackPandLBand =
  | 'revenue' | 'costOfSales' | 'grossProfit' | 'otherIncome'
  | 'operatingExpenses' | 'operatingProfit' | 'otherExpenses' | 'netProfit';

/**
 * One rendered row: a band key, a label, an amount, and an optional margin.
 *
 * `margin` is a NUMBER. Carrying it as a string had each pack coerce it
 * differently — HTML did `fmtPct(Number(r.margin))`, the PDF `pct(r.margin)` —
 * so typing it properly at source would have kept one working and made the
 * other print `NaN%`, on surfaces neither of which has a render test.
 *
 * Three states, not two. `undefined` is a band that HAS no margin (Operating
 * Expenses); `null` is a band that has one in principle but not on this
 * period's figures — `marginPct2dp` returns null on zero or negative turnover,
 * because a margin needs turnover to be a margin OF. Coercing that null to 0
 * here is what had both legacy routes print "Gross margin 0.0%" on a loss
 * period: a figure nothing else on the page supports, on a document a director
 * forwards to a bank.
 */
export interface PackPandLRow {
  key: PackPandLBand;
  label: string;
  amount: number;
  margin?: number | null;
}

/**
 * What both legacy pack renderers print in a margin cell whose margin is not
 * meaningful. An en dash rather than the pack's full sentence
 * (`NO_MARGIN_REASON` in packs/packDocument.ts) because this is a narrow
 * third column in a table, not a labelled key/value row — same meaning, the
 * format the cell can carry. Exported so the two routes cannot drift.
 */
export const NO_MARGIN_CELL = '–';

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** A margin, or null when there is none to print. Unlike `num`, an absent or
 *  non-finite value is NOT 0 — see the three states on `PackPandLRow.margin`. */
const marginOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Build the rows for an `income_statement` pack section.
 *
 * The two optional bands are omitted when nil — a zero Other Income line is
 * noise — but Operating Profit is unconditional: it is the subtotal the reader
 * needs to get from gross profit to the bottom line.
 */
export function incomeStatementPackRows(d: Record<string, unknown>): PackPandLRow[] {
  const otherIncome = num(d['otherIncome']);
  const otherExpenses = num(d['otherExpenses']);
  const grossProfit = num(d['grossProfit']);
  const operatingExpenses = num(d['operatingExpenses']);
  const operatingProfit = d['operatingProfit'] === undefined
    ? grossProfit + otherIncome - operatingExpenses
    : num(d['operatingProfit']);

  return [
    { key: 'revenue', label: 'Turnover', amount: num(d['revenue']) },
    { key: 'costOfSales', label: 'Cost of Sales', amount: num(d['costOfSales']) },
    { key: 'grossProfit', label: 'Gross Profit', amount: grossProfit, margin: marginOrNull(d['grossMargin']) },
    ...(otherIncome !== 0 ? [{ key: 'otherIncome' as const, label: 'Other Income', amount: otherIncome }] : []),
    { key: 'operatingExpenses', label: 'Operating Expenses', amount: operatingExpenses },
    { key: 'operatingProfit', label: 'Operating Profit', amount: operatingProfit },
    ...(otherExpenses !== 0 ? [{ key: 'otherExpenses' as const, label: 'Other Expenses', amount: otherExpenses }] : []),
    { key: 'netProfit', label: 'Net Profit', amount: num(d['netProfit']), margin: marginOrNull(d['netMargin']) },
  ];
}
