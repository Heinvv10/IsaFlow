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
 */
export interface PackPandLRow {
  key: PackPandLBand;
  label: string;
  amount: number;
  margin?: number;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
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
    { key: 'grossProfit', label: 'Gross Profit', amount: grossProfit, margin: num(d['grossMargin']) },
    ...(otherIncome !== 0 ? [{ key: 'otherIncome' as const, label: 'Other Income', amount: otherIncome }] : []),
    { key: 'operatingExpenses', label: 'Operating Expenses', amount: operatingExpenses },
    { key: 'operatingProfit', label: 'Operating Profit', amount: operatingProfit },
    ...(otherExpenses !== 0 ? [{ key: 'otherExpenses' as const, label: 'Other Expenses', amount: otherExpenses }] : []),
    { key: 'netProfit', label: 'Net Profit', amount: num(d['netProfit']), margin: num(d['netMargin']) },
  ];
}
