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
