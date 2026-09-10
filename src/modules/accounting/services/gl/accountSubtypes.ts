/**
 * Shared GL account classification.
 *
 * `gl_accounts.account_type` is NOT NULL and CHECK-constrained to
 * asset/liability/equity/revenue/expense, so it is the only authoritative
 * source for the five top-level buckets. `account_code` is NOT — production
 * charts put assets, liabilities, equity, revenue and expenses all under code
 * prefix `4`, and Sage-imported charts use alphabetic prefixes entirely.
 * Nothing in this module may look at account_code.
 *
 * `account_subtype` is free-form and carries duplicate singular/plural
 * spellings plus importer-specific tokens, so it is canonicalised here before
 * anything is derived from it. Where it is NULL or unrecognised, assets and
 * liabilities default to CURRENT — and the default is counted, so callers can
 * warn instead of presenting a guess as a fact.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

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
const SUBTYPE_ALIASES: Record<string, CanonicalSubtype> = {
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

const NON_CURRENT: ReadonlySet<CanonicalSubtype> = new Set<CanonicalSubtype>([
  'fixed_asset',
  'accumulated_depreciation',
  'intangible_asset',
  'investment',
  'non_current_asset',
  'long_term_liability',
  'non_current_liability',
]);

/** Normalise then look up. Returns null when absent or ambiguous — never a guess. */
export function canonicalSubtype(raw: string | null | undefined): CanonicalSubtype | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return null;
  return SUBTYPE_ALIASES[key] ?? null;
}

/**
 * Current vs non-current. Only meaningful on the balance sheet, so revenue and
 * expense always answer false. Unknown asset/liability subtypes default to
 * current — see `unclassifiedCount` for how much of the answer that is.
 */
export function isCurrentSubtype(
  accountType: AccountType,
  subtype: string | null | undefined
): boolean {
  if (accountType !== 'asset' && accountType !== 'liability') return false;
  const canon = canonicalSubtype(subtype);
  if (canon === null) return true;
  return !NON_CURRENT.has(canon);
}

/**
 * Every raw `account_subtype` spelling that canonicalises to one of the given
 * tokens. SQL that must filter on subtype (rather than aggregate through
 * `aggregateFigures`) passes this as a TEXT[] so the vocabulary stays defined
 * in exactly one place.
 */
export function rawSubtypesFor(...canonical: CanonicalSubtype[]): string[] {
  const wanted = new Set<CanonicalSubtype>(canonical);
  return Object.keys(SUBTYPE_ALIASES).filter((k) => wanted.has(SUBTYPE_ALIASES[k]!));
}

/** Raw spellings of the cash-and-cash-equivalents subtypes, for SQL filters. */
export const CASH_SUBTYPES: readonly string[] = rawSubtypesFor('bank', 'cash');

/**
 * Raw spellings of every NON-CURRENT token, derived from the same `NON_CURRENT`
 * set `isCurrentSubtype` reads. SQL that partitions the balance sheet passes
 * this, so the current/non-current split cannot disagree between a query and
 * the TypeScript answering the same question. Asset and liability tokens are
 * disjoint by side, so a caller already filtering `account_type` needs only one.
 */
export const NON_CURRENT_SUBTYPES: readonly string[] = rawSubtypesFor(...NON_CURRENT);

/** Every canonical token in the vocabulary. Used by the census lint. */
export const ALL_CANONICAL_SUBTYPES: readonly CanonicalSubtype[] =
  Array.from(new Set(Object.values(SUBTYPE_ALIASES)));

/**
 * Raw spellings meaning inventory / stock. No production account currently
 * carries any of them — see `inventoryWarning` in financialFiguresService.
 */
export const INVENTORY_SUBTYPES: readonly string[] = rawSubtypesFor('inventory');

/**
 * Raw spellings meaning a BANK account specifically — narrower than
 * CASH_SUBTYPES, which also covers petty cash. Use this where the surface is
 * about bank accounts (a bank-account picker, a "Bank Balances" tile, a feed
 * pairing) and CASH_SUBTYPES where it is about cash and cash equivalents.
 */
export const BANK_SUBTYPES: readonly string[] = rawSubtypesFor('bank');

/**
 * The predicate form of `BANK_SUBTYPES`, for the paths that compare a subtype
 * in TypeScript rather than in SQL. Both answer the same question — "does this
 * account hold bank transactions?" — so they must not be able to disagree, and
 * a literal `=== 'bank'` beside a query that accepts `bank_account` is exactly
 * such a disagreement.
 */
export function isBankSubtype(subtype: string | null | undefined): boolean {
  return canonicalSubtype(subtype) === 'bank';
}

/** Raw spellings meaning trade receivables. */
export const RECEIVABLE_SUBTYPES: readonly string[] = rawSubtypesFor('receivable');

/** Raw spellings meaning trade payables. */
export const PAYABLE_SUBTYPES: readonly string[] = rawSubtypesFor('payable');

/**
 * Raw spellings of the non-current asset subtypes whose movement is an
 * investing activity. `fixed_assets` (plural) is 30 accounts in production and
 * was invisible to the singular-only filter this replaces.
 */
export const INVESTING_ASSET_SUBTYPES: readonly string[] = rawSubtypesFor(
  'fixed_asset',
  'non_current_asset',
  'intangible_asset',
  'investment'
);

/** Cash and cash equivalents: bank or cash subtypes on an asset account. */
export function isCashEquivalent(
  accountType: AccountType,
  subtype: string | null | undefined
): boolean {
  if (accountType !== 'asset') return false;
  const canon = canonicalSubtype(subtype);
  return canon === 'bank' || canon === 'cash';
}

