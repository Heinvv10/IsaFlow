/**
 * The one place that decides whether an `account_subtype` may be written to a
 * given account. `account_subtype` is a plain TEXT column with no CHECK
 * constraint, so nothing below this stops a typo — and a subtype the rest of
 * the system does not recognise is indistinguishable from NULL to every
 * consumer that filters on a known value (`getBankAccountsStatus`,
 * `systemAccountResolver`, the AFS mappings).
 *
 * Pure and dependency-free so `createAccount` and `reclassifyAccount` can both
 * use it without an import cycle.
 */

import type { GLAccountSubtype, GLAccountType } from '../../types/gl.types';
import {
  GL_ACCOUNT_SUBTYPES_BY_TYPE,
  SYSTEM_RESERVED_SUBTYPES,
} from '../../types/glAccountSubtypes';

export interface SubtypeCheckTarget {
  accountType: GLAccountType;
  isSystemAccount?: boolean;
  /** The subtype the row already carries — re-stating it is never an error. */
  currentSubtype?: string | null;
}

/**
 * @returns a human-readable refusal, or `null` when the write is allowed.
 */
export function subtypeErrorFor(
  target: SubtypeCheckTarget,
  subtype: string | null | undefined,
): string | null {
  if (subtype === null || subtype === undefined || subtype === '') return null;
  if (subtype === target.currentSubtype) return null;

  const allowed = GL_ACCOUNT_SUBTYPES_BY_TYPE[target.accountType] as readonly string[] | undefined;
  if (!allowed) return `Unknown account type "${target.accountType}"`;

  if (!allowed.includes(subtype)) {
    return `Subtype "${subtype}" is not valid for an ${target.accountType} account. ` +
      `Valid: ${allowed.join(', ')}`;
  }

  // Reserved subtypes are how `systemAccountResolver` finds the VAT, AR, AP,
  // depreciation and default revenue/expense accounts. Its cache does
  // `map.set(subtype, row)` with no uniqueness guard, so a second system row
  // claiming a key silently displaces the first and every auto-posting path
  // starts posting to the wrong account with no error anywhere. A NON-system
  // row is harmless today, but it is one `is_system_account` flag away from
  // that failure, so the value is refused at the point it would be written.
  if (SYSTEM_RESERVED_SUBTYPES.includes(subtype as GLAccountSubtype)) {
    return `Subtype "${subtype}" is reserved for this company's system account of ` +
      'that role and cannot be assigned here';
  }

  return null;
}

/**
 * Income-statement accounts must carry a subtype. The income statement bands
 * on it — `cost_of_sales` above gross profit, everything else below — and a
 * NULL is silently "everything else". Velocity Fibre's Sage import left 77
 * revenue/expense accounts blank, so R82.7m of direct costs sat under
 * operating expenses and gross margin read 96.6% instead of about −1.9%.
 * Balance-sheet accounts are exempt: their NULL defaults to CURRENT and is
 * counted as unclassified, which the reports already disclose.
 *
 * @returns a human-readable refusal, or `null` when the value is present or
 *   not required for this account type.
 */
export function missingSubtypeError(
  accountType: GLAccountType,
  subtype: string | null | undefined,
): string | null {
  if (accountType !== 'revenue' && accountType !== 'expense') return null;
  if (subtype) return null;
  // Reserved values are refused by subtypeErrorFor, so listing them here
  // would send the caller straight into a second, different error.
  const allowed = (GL_ACCOUNT_SUBTYPES_BY_TYPE[accountType] as readonly GLAccountSubtype[])
    .filter(s => !SYSTEM_RESERVED_SUBTYPES.includes(s));
  return `Subtype is required for a ${accountType} account. Valid: ${allowed.join(', ')}`;
}

/**
 * What a BULK import writes when a revenue/expense row arrives without a
 * subtype. Interactive creation refuses (the user can be asked); a 400-line
 * chart import cannot ask, and skipping every income-statement row would
 * strand the opening trial balance that references those codes. An explicit
 * default is visible and reclassifiable, which NULL never was — but it does
 * mean cost-of-sales rows imported without a subtype land under operating
 * expenses until someone reclassifies them, so callers must say so.
 */
export function defaultIncomeStatementSubtype(accountType: GLAccountType): GLAccountSubtype | null {
  if (accountType === 'revenue') return 'revenue';
  if (accountType === 'expense') return 'operating_expense';
  return null;
}
