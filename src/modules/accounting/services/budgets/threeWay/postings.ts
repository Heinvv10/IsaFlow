/**
 * Double-entry postings of the three-way engine (P6 spec §5, steps 1–11).
 *
 * Every builder returns one balanced `Posting` (debit +, credit −): `post`
 * drops zero lines and refuses Σ ≠ 0 with `UnbalancedPostingError`, and a
 * posting that moves `cash` must name its `CashGroup` (that is what makes the
 * direct cash flow complete). Derived amounts are residuals of the figures the
 * caller already rounded (VAT-inclusive = ex VAT + VAT, never re-rounded), so
 * rounding can never unbalance a posting.
 */
import type { CashGroup } from '@/modules/accounting/services/afs/cashFlowClassification';
import { UnbalancedPostingError } from './errors';
import type { BucketKey, Buckets, Posting, PostingLine, PostingStep } from './types';

export function post(month: string, step: PostingStep, cashGroup: CashGroup | null, lines: readonly PostingLine[]): Posting {
  const kept = lines.filter(l => l.amount !== 0);
  let sum = 0;
  for (const l of kept) {
    if (!Number.isSafeInteger(l.amount)) throw new UnbalancedPostingError(step, month, Number.NaN);
    sum += l.amount;
  }
  if (sum !== 0) throw new UnbalancedPostingError(step, month, sum);
  if (cashGroup === null && kept.some(l => l.account === 'cash')) {
    throw new UnbalancedPostingError(`${step} (cash line without a cash group)`, month, 0);
  }
  return { month, step, cashGroup, lines: kept };
}

/** Apply a posting to the running buckets; P&L lines close to retained earnings. */
export function applyPosting(b: Buckets, p: Posting): void {
  for (const l of p.lines) {
    const key: BucketKey = l.account.startsWith('pnl.') ? 'retainedEarnings' : (l.account as BucketKey);
    b[key] += l.amount;
  }
}

/** 1. Sales: DR receivables (incl), CR revenue, CR VAT. `incl` must be `turnover + outputVat`. */
export function salesPosting(month: string, turnover: number, outputVat: number): Posting {
  const incl = turnover + outputVat;
  return post(month, 'sales', null, [
    { account: 'receivables', amount: incl }, { account: 'pnl.turnover', amount: -turnover }, { account: 'vatControl', amount: -outputVat },
  ]);
}

/** 1b. Other income: DR cash, CR income (no VAT). */
export function otherIncomePosting(month: string, amount: number): Posting {
  return post(month, 'other_income', 'other_operating', [{ account: 'cash', amount }, { account: 'pnl.otherIncome', amount: -amount }]);
}

/** 2. Receipts: DR cash, CR receivables. */
export function receiptsPosting(month: string, receipts: number): Posting {
  return post(month, 'receipts', 'cash_received_from_customers', [{ account: 'cash', amount: receipts }, { account: 'receivables', amount: -receipts }]);
}

/** 3. Cost of sales out of inventory. */
export function cogsPosting(month: string, cogs: number): Posting {
  return post(month, 'cogs', null, [{ account: 'pnl.costOfSales', amount: cogs }, { account: 'inventory', amount: -cogs }]);
}

/** 4. Supplier purchases: DR inventory (stock), DR opex, DR VAT input, CR payables (incl). */
export function purchasesPosting(month: string, stockPurchases: number, otherOpex: number, inputVat: number): Posting {
  return post(month, 'purchases', null, [
    { account: 'inventory', amount: stockPurchases }, { account: 'pnl.otherOpex', amount: otherOpex },
    { account: 'vatControl', amount: inputVat }, { account: 'payables', amount: -(stockPurchases + otherOpex + inputVat) },
  ]);
}

/** 4b. Supplier payments: DR payables, CR cash. */
export function supplierPaymentsPosting(month: string, payments: number): Posting {
  return post(month, 'supplier_payments', 'cash_paid_to_suppliers', [{ account: 'payables', amount: payments }, { account: 'cash', amount: -payments }]);
}

/** 5. Payroll: DR expense, CR cash (net), CR payroll liabilities (statutory). */
export function payrollPosting(month: string, net: number, statutory: number): Posting {
  return post(month, 'payroll', 'cash_paid_to_employees', [
    { account: 'pnl.payroll', amount: net + statutory }, { account: 'cash', amount: -net }, { account: 'payrollLiabilities', amount: -statutory },
  ]);
}

/** 5b. EMP201 remittance of the liability held at the start of the month. */
export function payrollRemittancePosting(month: string, amount: number): Posting {
  return post(month, 'payroll_remittance', 'cash_paid_to_employees', [{ account: 'payrollLiabilities', amount }, { account: 'cash', amount: -amount }]);
}

/** 6. Depreciation: DR expense, CR accumulated depreciation (non-cash). */
export function depreciationPosting(month: string, amount: number): Posting {
  return post(month, 'depreciation', null, [{ account: 'pnl.depreciation', amount }, { account: 'accumDepreciation', amount: -amount }]);
}

/** 7. Finance cost, paid in the month. */
export function financeCostPosting(month: string, amount: number): Posting {
  return post(month, 'finance_cost', 'other_operating', [{ account: 'pnl.financeCost', amount }, { account: 'cash', amount: -amount }]);
}

/** 7b. Loan drawdown: DR cash, CR loans. */
export function loanDrawdownPosting(month: string, amount: number): Posting {
  return post(month, 'loan_drawdown', 'financing', [{ account: 'cash', amount }, { account: 'loans', amount: -amount }]);
}

/** 7c. Loan principal repaid: DR loans, CR cash. */
export function loanPrincipalPosting(month: string, amount: number): Posting {
  return post(month, 'loan_principal', 'financing', [{ account: 'loans', amount }, { account: 'cash', amount: -amount }]);
}

/** 8. Capex: DR fixed assets (ex VAT), DR VAT (claimable), CR cash. */
export function capexPosting(month: string, exVat: number, vat: number): Posting {
  return post(month, 'capex', 'investing', [
    { account: 'fixedAssets', amount: exVat }, { account: 'vatControl', amount: vat }, { account: 'cash', amount: -(exVat + vat) },
  ]);
}

/** 9. Income tax expense accrued to the payable. */
export function incomeTaxPosting(month: string, amount: number): Posting {
  return post(month, 'income_tax', null, [{ account: 'pnl.taxExpense', amount }, { account: 'incomeTaxPayable', amount: -amount }]);
}

/** 9b. Provisional tax / top-up paid. */
export function provisionalTaxPosting(month: string, amount: number): Posting {
  return post(month, 'provisional_tax', 'other_operating', [{ account: 'incomeTaxPayable', amount }, { account: 'cash', amount: -amount }]);
}

/** 10. Share issue: DR cash, CR share capital. */
export function shareIssuePosting(month: string, amount: number): Posting {
  return post(month, 'share_issue', 'financing', [{ account: 'cash', amount }, { account: 'shareCapital', amount: -amount }]);
}

/** 10b. Dividend declared: DR retained earnings, CR dividends payable. */
export function dividendDeclaredPosting(month: string, amount: number): Posting {
  return post(month, 'dividend_declared', null, [{ account: 'retainedEarnings', amount }, { account: 'dividendsPayable', amount: -amount }]);
}

/** 10c. Dividend paid: DR dividends payable, CR cash. */
export function dividendPaidPosting(month: string, amount: number): Posting {
  return post(month, 'dividend_paid', 'financing', [{ account: 'dividendsPayable', amount }, { account: 'cash', amount: -amount }]);
}

/** 11. VAT settlement of a period's net (liability-positive: + pays, − refund received). */
export function vatSettlementPosting(month: string, net: number): Posting {
  return post(month, 'vat_settlement', 'other_operating', [{ account: 'vatControl', amount: net }, { account: 'cash', amount: -net }]);
}
