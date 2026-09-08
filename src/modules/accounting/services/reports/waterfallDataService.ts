/**
 * Waterfall Data Service — builds data for waterfall charts.
 * Pure business logic — no database dependencies.
 */

export interface WaterfallStep {
  label: string;
  start: number;
  end: number;
  value: number;
  isSubtotal: boolean;
  color: 'green' | 'red' | 'blue' | 'teal';
  /**
   * THE FIGURE THE BAR IS LABELLED WITH, where that is not `value`.
   *
   * `value` is the step's EFFECT ON PROFIT, which is what positions the bar
   * and is the negation of the ledger figure for every subtracted line. So a
   * board pack printed Cost of sales as `1 431` in its income statement and
   * `(1 431)` on the bridge a hundred millimetres below it, and Brightsphere
   * printed three of six bars as the negation of the table above them —
   * `3 717` against a table reading `(3 717)`. Two visual gates in a row
   * reported it as a chart contradicting a table, and both were reading the
   * sheet correctly: an explanatory footnote had been added and was not read.
   *
   * The label now carries the TABLE's sign and the bar's DIRECTION carries
   * the effect on profit, so the two are one figure read two ways rather than
   * two signs for one figure. Absent where the two agree — revenue, other
   * income, the subtotals, and either bridge's residual plug, which is a
   * derived movement with no ledger line to agree with.
   */
  labelValue?: number;
}

// ---------------------------------------------------------------------------
// Profit Waterfall: Revenue → COGS → Gross Profit → OpEx → Other → Net Profit
// ---------------------------------------------------------------------------

/**
 * The figures arrive from `aggregateFigures` on NORMAL-BALANCE signs: revenue
 * is credit less debit, every expense band is debit less credit. So the usual
 * company hands in a positive `revenue` and a positive `operatingExpenses`,
 * and this builds a revenue bar that RISES and an expense bar that FALLS.
 *
 * Neither sign is guaranteed, and this function must not force one. A period
 * whose revenue accounts are in net DEBIT — credit notes, reversals, an
 * unclassified account posted the other way — has genuinely negative revenue,
 * and its revenue bar falls; a period whose expense accounts are in net CREDIT
 * has negative expenses, and its expense bar rises. Measured on this database
 * (2026-03-01 to 2026-08-31): ISAFlow Demo has revenue +71,600 and operating
 * expenses +162,667, drawing revenue up and expenses down; Brightsphere has
 * revenue −5,535,000 and operating expenses −3,717,000, drawing revenue down
 * and expenses up. Both are the same arithmetic reporting different books.
 *
 * The bar's COLOUR follows the direction it moved (`waterfallOption.barColor`,
 * favourable when the step grows profit), never the step's `color` hint here,
 * so a falling revenue bar is red because profit fell — which is what it did.
 */
export function buildProfitWaterfall(data: {
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  otherIncome: number;
  otherExpenses: number;
  netProfit: number;
}): WaterfallStep[] {
  const steps: WaterfallStep[] = [];
  let running = 0;

  // Revenue: from zero to whatever the ledger says. Usually positive.
  steps.push({ label: 'Revenue', start: 0, end: data.revenue, value: data.revenue, isSubtotal: false, color: 'green' });
  running = data.revenue;

  // Cost of Sales: subtracted, so a positive cost draws downward.
  steps.push({ label: 'Cost of Sales', start: running, end: running - data.costOfSales, value: -data.costOfSales, labelValue: data.costOfSales, isSubtotal: false, color: 'red' });
  running -= data.costOfSales;

  // Gross Profit (subtotal)
  steps.push({ label: 'Gross Profit', start: 0, end: data.grossProfit, value: data.grossProfit, isSubtotal: true, color: 'teal' });

  // Operating Expenses: subtracted, so a positive expense draws downward.
  running = data.grossProfit;
  steps.push({ label: 'Operating Expenses', start: running, end: running - data.operatingExpenses, value: -data.operatingExpenses, labelValue: data.operatingExpenses, isSubtotal: false, color: 'red' });
  running -= data.operatingExpenses;

  // Other Income: added.
  steps.push({ label: 'Other Income', start: running, end: running + data.otherIncome, value: data.otherIncome, isSubtotal: false, color: 'green' });
  running += data.otherIncome;

  // Other Expenses: subtracted.
  steps.push({ label: 'Other Expenses', start: running, end: running - data.otherExpenses, value: -data.otherExpenses, labelValue: data.otherExpenses, isSubtotal: false, color: 'red' });
  running -= data.otherExpenses;

  // Net Profit (subtotal)
  steps.push({ label: 'Net Profit', start: 0, end: data.netProfit, value: data.netProfit, isSubtotal: true, color: data.netProfit >= 0 ? 'teal' : 'red' });

  return withoutNilMovements(steps);
}

/**
 * A MOVEMENT WITH NOTHING IN IT IS NOT DRAWN — one rule, for every line and
 * every caller.
 *
 * The two "Other" bands used to carry a `!== 0` gate of their own and the
 * other three lines carried none, so a bridge dropped a nil Other Expenses
 * and drew a nil Cost of Sales. On the board pack that showed as six bars for
 * one company and seven for another off the same statement, with nothing on
 * either sheet saying which lines were left out; the same split was reaching
 * `reportPackService` and `/api/accounting/reports-waterfall` unchanged.
 *
 * SUBTOTALS STAY whatever their value. Gross Profit and Net Profit are where
 * the bridge lands rather than steps in it, and a nil subtotal is a figure the
 * reader is owed, not a bar carrying nothing.
 *
 * A caller that has to say WHICH lines it dropped cannot read that back off
 * the steps — the answer is in the figures it passed in. See
 * `withoutNilLines` in `packPageCharts.ts`, which derives page 6's omission
 * sentence from the statement lines for exactly that reason.
 */
function withoutNilMovements(steps: WaterfallStep[]): WaterfallStep[] {
  return steps.filter((step) => step.isSubtotal || step.value !== 0);
}

// ---------------------------------------------------------------------------
// Cash Flow Waterfall: Opening → Operating In → Operating Out → Investing → Financing → Closing
// ---------------------------------------------------------------------------

export function buildCashFlowWaterfall(data: {
  opening: number;
  operatingIn: number;
  operatingOut: number;
  investingNet: number;
  financingNet: number;
  closing: number;
}): WaterfallStep[] {
  const steps: WaterfallStep[] = [];
  let running = data.opening;

  steps.push({ label: 'Opening Balance', start: 0, end: data.opening, value: data.opening, isSubtotal: true, color: 'blue' });

  steps.push({ label: 'Operating Inflows', start: running, end: running + data.operatingIn, value: data.operatingIn, isSubtotal: false, color: 'green' });
  running += data.operatingIn;

  steps.push({ label: 'Operating Outflows', start: running, end: running + data.operatingOut, value: data.operatingOut, isSubtotal: false, color: 'red' });
  running += data.operatingOut;

  if (data.investingNet !== 0) {
    steps.push({ label: 'Investing', start: running, end: running + data.investingNet, value: data.investingNet, isSubtotal: false, color: data.investingNet >= 0 ? 'green' : 'red' });
    running += data.investingNet;
  }

  if (data.financingNet !== 0) {
    steps.push({ label: 'Financing', start: running, end: running + data.financingNet, value: data.financingNet, isSubtotal: false, color: data.financingNet >= 0 ? 'green' : 'red' });
    running += data.financingNet;
  }

  steps.push({ label: 'Closing Balance', start: 0, end: data.closing, value: data.closing, isSubtotal: true, color: 'teal' });

  return steps;
}

// ---------------------------------------------------------------------------
// Variance Waterfall: Budget → each variance → Actual
// ---------------------------------------------------------------------------

export function buildVarianceWaterfall(
  items: Array<{ label: string; budgetAmount: number; actualAmount: number }>,
): WaterfallStep[] {
  const steps: WaterfallStep[] = [];

  const budgetTotal = items.reduce((s, i) => s + i.budgetAmount, 0);
  const actualTotal = items.reduce((s, i) => s + i.actualAmount, 0);

  steps.push({ label: 'Budget Total', start: 0, end: budgetTotal, value: budgetTotal, isSubtotal: true, color: 'blue' });

  let running = budgetTotal;
  for (const item of items) {
    const variance = item.actualAmount - item.budgetAmount;
    if (variance === 0) continue;
    steps.push({
      label: `${item.label} variance`,
      start: running,
      end: running + variance,
      value: variance,
      isSubtotal: false,
      color: variance >= 0 ? 'green' : 'red',
    });
    running += variance;
  }

  steps.push({ label: 'Actual Total', start: 0, end: actualTotal, value: actualTotal, isSubtotal: true, color: 'teal' });

  return steps;
}
