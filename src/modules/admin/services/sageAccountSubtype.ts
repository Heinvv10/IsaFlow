/**
 * Bands a Sage-imported income-statement account into an `account_subtype`.
 *
 * The Sage commit never named `account_subtype` in its INSERT, and
 * `MappedAccount` did not even carry Sage's category, so every revenue and
 * expense account arrived NULL — the income statement then filed all of them
 * under operating expenses. Velocity Fibre's chart carries the Sage code in
 * the account name (`COS - Direct Material - EX2001`); Sage numbers its
 * expense categories EX2xxx = Cost of Sales and everything else as expenses,
 * so the suffix recovers the category when the extension did not send one.
 *
 * Only non-reserved subtypes are returned: the reserved ones belong to the
 * company's system accounts (see SYSTEM_RESERVED_SUBTYPES).
 */
import type { GLAccountSubtype, GLAccountType } from '@/modules/accounting/types/gl.types';

const COST_OF_SALES_CATEGORY = /cost\s*of\s*(sales|goods)/i;
const COST_OF_SALES_NAME = /^COS\b|\bEX2\d{3}\b/i;

export function sageAccountSubtype(
  accountType: GLAccountType,
  category: string | undefined,
  accountName: string,
): GLAccountSubtype | null {
  if (accountType === 'revenue') return 'revenue';
  if (accountType !== 'expense') return null;
  if (category && COST_OF_SALES_CATEGORY.test(category)) return 'cost_of_sales';
  if (!category && COST_OF_SALES_NAME.test(accountName)) return 'cost_of_sales';
  return 'operating_expense';
}
