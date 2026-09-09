/**
 * Which reporting population a GL account belongs to — the axis a merge or a
 * reclassification may NOT move an account across.
 *
 * Its own file because the rule is shared, small, and the comment on
 * `VAT_CLASS_SUBTYPES` below is a cross-branch landmine that needs a stable
 * home a grep will find.
 */

import { isBankSubtype } from './accountSubtypes';

/**
 * The reporting class of a subtype — the axis a merge may NOT cross.
 *
 * `account_type` is guarded because crossing it moves a balance to the wrong
 * side of the balance sheet. `account_subtype` needed the same treatment for a
 * narrower but sharper reason, and gating on subtype EQUALITY would have been
 * wrong: `SYS-7 -> 1120` is NULL -> `receivable` and `SYS-8 -> 2110` is
 * NULL -> `payable`, so an equality rule refuses the two merges this tool
 * exists for.
 *
 * What actually matters is which subtypes are read as MEMBERSHIP PREDICATES
 * elsewhere, and there are exactly four:
 *
 *  - `vat_input`, `vat_output`, `tax` — `vatReturnService` scopes the VAT
 *    return by `ga.account_subtype IN ('vat_input','vat_output','tax')`, and
 *    its unclassified-input sweep adds any such line with a NULL `vat_type` to
 *    box 15 at full `debit - credit`. Merging an ordinary account INTO one puts
 *    money that is not tax onto a SARS return; merging one OUT drops its lines
 *    from the filter entirely and understates the return. Both directions, hence
 *    a symmetric check — the out direction is covered today only by accident,
 *    because most VAT accounts carry `is_system_account = true` and the source
 *    guard catches them, but Brightsphere's `34550639 Pay As You Earn` and
 *    `34024651 Income Tax` are subtype `tax` and are NOT system accounts.
 *  - `bank` — `bank_transactions.bank_account_id` FKs to `gl_accounts(id)` while
 *    every banking screen reaches those rows through `account_subtype = 'bank'`.
 *    The source side of this was already guarded by row COUNT; the class rule is
 *    what stops the target side.
 *
 * Everything else — `receivable`, `payable`, `equity`, NULL and the rest — is
 * presentation grouping inside a side of the balance sheet that `account_type`
 * already pins, and stays permitted or the tool cannot do its job. A same-class
 * merge (`vat_input` -> `vat_input`) also stays permitted: that is the same
 * split-control problem one axis over.
 */
export type ReportingClass = 'vat' | 'bank' | 'ordinary';

/**
 * The subtypes that decide VAT201 membership — mirroring what the return
 * ACTUALLY reads, not what it ought to.
 *
 * `'tax'` is in the set even though it is not VAT. FINDINGS B37 records exactly
 * that: Brightsphere's `34550639 Pay As You Earn` is an EXPENSE account carrying
 * `account_subtype = 'tax'`, and R23,219.01 of PAYE was being pulled into box
 * 15. It is here anyway because the membership query still reads it —
 * `reports/vatReturnService.ts:103`,
 * `ga.account_subtype IN ('vat_input', 'vat_output', 'tax')`. Narrowing this set
 * while that line stands would silently re-open the hole the guard exists to
 * close.
 *
 * **B37 is marked FIXED, and that is a trap for whoever reads this next.** The
 * fix landed on the VAT-CONTROL sense — `reports/vatBoxBasis.ts` now exports
 * `VAT_TAX_SUBTYPES = ['vat_input', 'vat_output']`, with `'tax'` dropped. The
 * LINE-MEMBERSHIP filter at `vatReturnService.ts:103` was not changed and still
 * carries it. So the finding reads closed while the dependency this set has on
 * it is live.
 *
 * **The same dependency exists in a second place, and neither side can see the
 * other.** `gl/reclassification/planGuards.ts` holds `VAT_RETURN_SUBTYPES`, the
 * identical three subtypes, for the identical reason. When
 * `vatReturnService.ts:103` stops reading `'tax'`, BOTH sets have to lose it in
 * the same change — otherwise every merge and every reclassification touching a
 * PAYE or income-tax account is refused with a message citing a VAT return that
 * no longer includes it. Brightsphere has two such accounts live today
 * (`34024651 Income Tax`, `34550639 Pay As You Earn`), both `tax`, both
 * non-system, both active — the same two that made the symmetric guard
 * necessary here in the first place.
 *
 * A grep for `'tax'` across `vatReturnService`, this file and `planGuards.ts`
 * finds all three ends. That grep is the only thing that will surface this.
 */
const VAT_CLASS_SUBTYPES: ReadonlySet<string> = new Set(['vat_input', 'vat_output', 'tax']);

export function reportingClassFor(subtype: string | null): ReportingClass {
  if (subtype === null) return 'ordinary';
  if (VAT_CLASS_SUBTYPES.has(subtype)) return 'vat';
  if (isBankSubtype(subtype)) return 'bank';
  return 'ordinary';
}

/**
 * Moving an account off the bank subtype orphans its statement rows:
 * `bank_transactions.bank_account_id` FKs to `gl_accounts(id)`, but every
 * banking screen reaches those rows through `account_subtype = 'bank'`. Same
 * rule `accountReclassifyService` enforces, for the same reason — a merge that
 * deactivates a bank account leaves its transactions reachable from nothing.
 */
