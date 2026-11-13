/**
 * Cash flow from the engine's postings and balances (P6 spec §5 Output, T6).
 *
 * Direct: every posting that moves cash names its `CashGroup`; the month's
 * direct cash flow is the sum of those cash lines by group (customers,
 * suppliers, employees incl. EMP201, other_operating = VAT + income tax +
 * interest + other income, investing = capex, financing = loans/equity/dividends).
 *
 * Indirect (computed independently, from the P&L input and bucket movements):
 * NP + depreciation − ΔAR − ΔInv + ΔAP + ΔpayrollLiab + ΔVAT + ΔtaxPayable.
 * ΔVAT excludes the VAT paid on capex in the month: that cash is investing,
 * so leaving it in would put an investing flow in operating. I3 (direct
 * operating = indirect operating) is the test that the postings agree.
 */
import { OPERATING_GROUPS, type CashGroup } from '@/modules/accounting/services/afs/cashFlowClassification';
import type {
  Buckets, CashFlowMonth, DirectCashFlow, IndirectCashFlow, MonthResult, PnlMonth, Posting, Runway,
} from './types';

const GROUPS: readonly CashGroup[] = [
  'cash_received_from_customers', 'cash_paid_to_suppliers', 'cash_paid_to_employees', 'other_operating', 'investing', 'financing',
];

export function netProfit(p: PnlMonth): number {
  return p.turnover + p.otherIncome - p.costOfSales - p.payroll - p.depreciation - p.financeCost - p.taxExpense - p.otherOpex;
}

export function directCashFlow(postings: readonly Posting[]): DirectCashFlow {
  const out = Object.fromEntries(GROUPS.map(g => [g, 0])) as DirectCashFlow;
  for (const p of postings) {
    if (p.cashGroup === null) continue;
    for (const l of p.lines) if (l.account === 'cash') out[p.cashGroup] += l.amount;
  }
  return out;
}

/** Cash effect of each movement (a liability rising is +, an asset rising is −). */
export function indirectCashFlow(open: Buckets, close: Buckets, pnl: PnlMonth, capexVat: number): IndirectCashFlow {
  const fall = (k: keyof Buckets) => -(close[k] - open[k]);
  const lines = {
    netProfit: netProfit(pnl),
    depreciation: pnl.depreciation,
    receivables: fall('receivables'),
    inventory: fall('inventory'),
    payables: fall('payables'),
    payrollLiabilities: fall('payrollLiabilities'),
    vat: fall('vatControl') + capexVat,
    incomeTax: fall('incomeTaxPayable'),
  };
  const operating = Object.values(lines).reduce((s, v) => s + v, 0);
  return { ...lines, operating };
}

export function cashFlowMonth(
  open: Buckets, close: Buckets, postings: readonly Posting[], pnl: PnlMonth, capexVat: number,
): CashFlowMonth {
  const direct = directCashFlow(postings);
  const operating = GROUPS.filter(g => OPERATING_GROUPS.has(g)).reduce((s, g) => s + direct[g], 0);
  const net = GROUPS.reduce((s, g) => s + direct[g], 0);
  return {
    openingCash: open.cash, direct, operating, investing: direct.investing, financing: direct.financing,
    net, closingCash: close.cash, indirect: indirectCashFlow(open, close, pnl, capexVat),
  };
}

/** Runway (§5): first month below the minimum, and the lowest closing cash (its first month). */
export function runwayOf(months: readonly MonthResult[], minimumCash: number): Runway {
  let minCash = Number.POSITIVE_INFINITY;
  let minCashMonth = '';
  let firstBelowMinimum: string | null = null;
  for (const m of months) {
    const c = m.closing.cash;
    if (c < minCash) { minCash = c; minCashMonth = m.month; }
    if (firstBelowMinimum === null && c < minimumCash) firstBelowMinimum = m.month;
  }
  return { minimumCash, firstBelowMinimum, minCash, minCashMonth };
}
