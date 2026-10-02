/**
 * The `account_subtype` vocabulary: every canonical token, and every raw
 * spelling that maps onto one. Moved out of `accountSubtypes.ts` unchanged to
 * keep that file under the 300-line cap; `accountSubtypes.ts` re-exports
 * `CanonicalSubtype` and owns every function that reads this table.
 */

export type CanonicalSubtype =
  // asset
  | 'bank'
  | 'cash'
  | 'receivable'
  | 'inventory'
  | 'prepaid_expense'
  | 'current_asset'
  | 'other_current_asset'
  | 'vat_input'
  | 'vat_input_late_claim' // the late-claim clearing account (migration 701) — NOT a VAT control subtype
  | 'fixed_asset'
  | 'accumulated_depreciation'
  | 'intangible_asset'
  | 'investment'
  | 'non_current_asset'
  // liability
  | 'payable'
  | 'credit_card'
  | 'payroll_liability'
  | 'vat_output'
  | 'current_liability'
  | 'other_current_liability'
  | 'long_term_liability'
  | 'non_current_liability'
  // equity
  | 'equity'
  | 'retained_earnings'
  | 'opening_balance_equity'
  // revenue
  | 'revenue'
  | 'sales'
  | 'other_income'
  // expense
  | 'cost_of_sales'
  | 'operating_expense'
  | 'admin_expense'
  | 'depreciation_expense'
  | 'insurance_expense'
  | 'payroll_expense'
  | 'finance_cost'
  | 'tax_expense'
  | 'other_expense';

/**
 * Every spelling observed in the live `isaflow` and `isaflow_dev` databases,
 * plus the obvious variants importers produce, mapped onto one token.
 * Deliberately absent: `other`, which appears on both expenses and liabilities
 * and says nothing — it resolves to null and is reported as unclassified.
 */
export const SUBTYPE_ALIASES: Record<string, CanonicalSubtype> = {
  // --- asset ---
  bank: 'bank',
  bank_account: 'bank',
  cash: 'cash',
  cash_on_hand: 'cash',
  petty_cash: 'cash',
  receivable: 'receivable',
  receivables: 'receivable',
  accounts_receivable: 'receivable',
  trade_receivable: 'receivable',
  trade_receivables: 'receivable',
  debtor: 'receivable',
  debtors: 'receivable',
  inventory: 'inventory',
  stock: 'inventory',
  prepaid_expense: 'prepaid_expense',
  prepaid_expenses: 'prepaid_expense',
  prepayment: 'prepaid_expense',
  prepayments: 'prepaid_expense',
  current_asset: 'current_asset',
  current_assets: 'current_asset',
  other_current_asset: 'other_current_asset',
  other_current_assets: 'other_current_asset',
  vat_input: 'vat_input',
  vat_input_late_claim: 'vat_input_late_claim',
  fixed_asset: 'fixed_asset',
  fixed_assets: 'fixed_asset',
  property_plant_equipment: 'fixed_asset',
  accumulated_depreciation: 'accumulated_depreciation',
  intangible_asset: 'intangible_asset',
  intangible_assets: 'intangible_asset',
  investment: 'investment',
  investments: 'investment',
  non_current_asset: 'non_current_asset',
  non_current_assets: 'non_current_asset',
  fixed_asset_other: 'non_current_asset',

  // --- liability ---
  payable: 'payable',
  payables: 'payable',
  accounts_payable: 'payable',
  trade_payable: 'payable',
  trade_payables: 'payable',
  creditor: 'payable',
  creditors: 'payable',
  credit_card: 'credit_card',
  payroll_liability: 'payroll_liability',
  payroll_liabilities: 'payroll_liability',
  vat_output: 'vat_output',
  current_liability: 'current_liability',
  current_liabilities: 'current_liability',
  other_current_liability: 'other_current_liability',
  other_current_liabilities: 'other_current_liability',
  long_term_liability: 'long_term_liability',
  long_term_liabilities: 'long_term_liability',
  non_current_liability: 'non_current_liability',
  non_current_liabilities: 'non_current_liability',

  // --- equity ---
  equity: 'equity',
  owners_equity: 'equity',
  share_capital: 'equity',
  retained_earnings: 'retained_earnings',
  opening_balance_equity: 'opening_balance_equity',

  // --- revenue ---
  revenue: 'revenue',
  default_revenue: 'revenue',
  income: 'revenue',
  operating_revenue: 'revenue',
  sales: 'sales',
  other_income: 'other_income',
  other_revenue: 'other_income',

  // --- expense ---
  cost_of_sales: 'cost_of_sales',
  cost_of_goods_sold: 'cost_of_sales',
  cogs: 'cost_of_sales',
  direct_cost: 'cost_of_sales',
  direct_costs: 'cost_of_sales',
  operating_expense: 'operating_expense',
  operating_expenses: 'operating_expense',
  default_expense: 'operating_expense',
  expense: 'operating_expense',
  admin_expense: 'admin_expense',
  admin_expenses: 'admin_expense',
  administrative_expense: 'admin_expense',
  depreciation_expense: 'depreciation_expense',
  depreciation: 'depreciation_expense',
  amortisation: 'depreciation_expense',
  amortization: 'depreciation_expense',
  insurance_expense: 'insurance_expense',
  // Salaries and wages. Distinct from `payroll_liability`, which is the PAYE,
  // UIF and pension withheld and not yet paid over. Without these the cash
  // flow reported every salary payment as cash paid to SUPPLIERS.
  payroll_expense: 'payroll_expense',
  payroll_expenses: 'payroll_expense',
  salary: 'payroll_expense',
  salaries: 'payroll_expense',
  salary_expense: 'payroll_expense',
  salaries_and_wages: 'payroll_expense',
  wage: 'payroll_expense',
  wages: 'payroll_expense',
  staff_cost: 'payroll_expense',
  staff_costs: 'payroll_expense',
  employee_cost: 'payroll_expense',
  employee_costs: 'payroll_expense',
  employee_benefits: 'payroll_expense',
  finance_cost: 'finance_cost',
  finance_costs: 'finance_cost',
  interest_expense: 'finance_cost',
  bank_charges: 'finance_cost', // unaliased, it banded operating: notes 20 AND 21 printed it
  tax: 'tax_expense',
  tax_expense: 'tax_expense',
  income_tax: 'tax_expense',
  // The AFS note generators' own spellings. Absent from this map they
  // canonicalised to NULL, so `expenseBand` reported an income-tax account as an
  // OPERATING expense while AFS note 20 excluded it — the same statutory pack
  // disagreeing with itself. Note 17 still splits current from deferred by the
  // raw spelling; that split lives inside this one canonical token.
  income_tax_expense: 'tax_expense',
  deferred_tax_expense: 'tax_expense',
  other_expense: 'other_expense',
  other_expenses: 'other_expense',
};
