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
}

// ---------------------------------------------------------------------------
// Profit Waterfall: Revenue → COGS → Gross Profit → OpEx → Other → Net Profit
// ---------------------------------------------------------------------------

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

  // Revenue (positive, starts from 0)
  steps.push({ label: 'Revenue', start: 0, end: data.revenue, value: data.revenue, isSubtotal: false, color: 'green' });
  running = data.revenue;

  // Cost of Sales (negative)
  steps.push({ label: 'Cost of Sales', start: running, end: running - data.costOfSales, value: -data.costOfSales, isSubtotal: false, color: 'red' });
  running -= data.costOfSales;

  // Gross Profit (subtotal)
  steps.push({ label: 'Gross Profit', start: 0, end: data.grossProfit, value: data.grossProfit, isSubtotal: true, color: 'teal' });

  // Operating Expenses (negative)
  running = data.grossProfit;
  steps.push({ label: 'Operating Expenses', start: running, end: running - data.operatingExpenses, value: -data.operatingExpenses, isSubtotal: false, color: 'red' });
  running -= data.operatingExpenses;

  // Other Income (positive, skip if zero)
  if (data.otherIncome !== 0) {
    steps.push({ label: 'Other Income', start: running, end: running + data.otherIncome, value: data.otherIncome, isSubtotal: false, color: 'green' });
    running += data.otherIncome;
  }

  // Other Expenses (negative, skip if zero)
  if (data.otherExpenses !== 0) {
    steps.push({ label: 'Other Expenses', start: running, end: running - data.otherExpenses, value: -data.otherExpenses, isSubtotal: false, color: 'red' });
    running -= data.otherExpenses;
  }

  // Net Profit (subtotal)
  steps.push({ label: 'Net Profit', start: 0, end: data.netProfit, value: data.netProfit, isSubtotal: true, color: data.netProfit >= 0 ? 'teal' : 'red' });

  return steps;
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
