/**
 * Which `account_subtype` values each `account_type` may legally carry, plus
 * the ones reserved for system accounts.
 *
 * Kept out of `gl.types.ts` because these are runtime values, not types, and
 * folding them in pushed that file past the 300-line cap.
 */

import type { GLAccountSubtype, GLAccountType } from './gl.types';

/**
 * The subtypes each account_type may legally carry, as a runtime value.
 *
 * Was a private `SUBTYPES_BY_TYPE` inside ChartOfAccountsTab, visible only to
 * the Add Account dialog. Nothing on the edit path or the MCP write path could
 * validate against it, and `account_subtype` is not a database enum — so any
 * string, or NULL, reached the column. A NULL subtype is not cosmetic: it makes
 * an account invisible to `getBankAccountsStatus` (which filters
 * `account_subtype = 'bank'`) and therefore unable to receive a statement
 * import at all. 27 Velocity Fibre paycards sat in exactly that state.
 *
 * Pairings mirror the seeded templates in `chartOfAccountsImportService` —
 * VAT Input is an ASSET (claimable) and VAT Output a LIABILITY (payable).
 */
export const GL_ACCOUNT_SUBTYPES_BY_TYPE = {
  asset: [
    'bank', 'cash', 'receivable', 'inventory', 'fixed_asset', 'accumulated_depreciation',
    'vat_input', 'vat_input_late_claim', 'other_current_asset', 'other',
  ],
  // payroll_liability (2140-2175), current_liability (2215) and
  // long_term_liability (BL1024) are carried by system accounts and are
  // canonical in accountSubtypeVocabulary; leaving them out made
  // chart_of_accounts_health report those accounts as subtype_does_not_fit_type
  // and settle_by_contra refuse them as unclassifiable.
  liability: [
    'payable', 'tax', 'vat_output', 'payroll_liability', 'current_liability',
    'other_current_liability', 'long_term_liability', 'other',
  ],
  equity: ['equity', 'retained_earnings', 'opening_balance_equity', 'dividends', 'other'],
  revenue: ['revenue', 'default_revenue', 'other_income', 'disposal_profit_loss', 'other'],
  // finance_cost: interest and bank charges (5810), banded below operating profit.
  expense: [
    'cost_of_sales', 'operating_expense', 'default_expense', 'admin_expense',
    'depreciation_expense', 'finance_cost', 'disposal_profit_loss', 'other',
  ],
} as const satisfies Record<GLAccountType, readonly GLAccountSubtype[]>;

/**
 * Subtypes `systemAccountResolver` resolves BY NAME on `is_system_account`
 * rows. They stay listed above because seeded charts legitimately carry them
 * and an edit must not reject the value an account already has — but a caller
 * may not MOVE an account onto one. The resolver's cache does
 * `map.set(subtype, row)` with no uniqueness guard, so a second system account
 * claiming a key silently displaces the first, and every auto-posting path
 * (VAT, AR, AP, depreciation) then posts to the wrong account with no error.
 */
export const SYSTEM_RESERVED_SUBTYPES: readonly GLAccountSubtype[] = [
  'vat_input', 'vat_output', 'receivable', 'payable', 'retained_earnings',
  'opening_balance_equity',
  'default_revenue', 'other_income', 'default_expense', 'admin_expense',
  'accumulated_depreciation', 'depreciation_expense', 'disposal_profit_loss',
  'vat_input_late_claim',
];

/** Every subtype any account_type may carry, flattened. */
export const GL_ACCOUNT_SUBTYPES: readonly GLAccountSubtype[] = Array.from(
  new Set(Object.values(GL_ACCOUNT_SUBTYPES_BY_TYPE).flat()),
) as GLAccountSubtype[];
