/**
 * May this account take a system role? ONE rule, used by the Default Accounts
 * save and by the COA import's role map, so the two cannot drift apart (they
 * did: the import checked the classification only, and put a role on an
 * inactive account — the live holder was demoted and the role had no holder).
 *
 * The account must be active (the resolver ignores inactive rows), must not be
 * a header with sub-accounts when the role is a balance-sheet one
 * (`isBalanceSheetType` — hidden from the balance sheet, migration 484; an
 * income-statement role may go to a header, Hein 2026-10-02), and must be
 * unclassified ('other' or NULL) or already classified for that role
 * (Hein, 2026-09-30: no reclassifying by
 * assignment — which is also what keeps an account that holds ANOTHER role
 * from being taken from it). And its TYPE must be one the role allows
 * (`typeFitsSubtype`, the resolver's own table) — the EFFECTIVE type, the one
 * the row will have once the caller has written: the COA import keeps a system
 * row's type, so judging its import row instead put the bank role on a liability.
 */
import { GL_ACCOUNT_SUBTYPES_BY_TYPE } from '../../types/glAccountSubtypes';
import { GL_ACCOUNT_TYPES, type GLAccountType } from '../../types/gl.types';
import { isSystemAccountKey, typeFitsSubtype } from './systemAccountKeys';

export interface RoleTarget {
  code: string;
  /** The account_type the account has, or will have after the caller's write. */
  type: string;
  isActive: boolean;
  hasChildren: boolean;
  subtype: string | null;
}

/** Classifications an account may carry and still take any role. */
const UNCLASSIFIED = new Set(['other']);

/**
 * Who is asking, for the header refusal's advice: the save can offer the
 * header's sub-accounts; an import collided with a code the chart already uses
 * for a header; a reactivation is the account itself coming back.
 */
const HEADER_ADVICE = {
  save: (code: string, setting: string) => `Account ${code} is a header with sub-accounts, and a balance-sheet role cannot be held by a header; `
    + `choose one of its sub-accounts for '${setting}'`,
  import: (code: string, setting: string) => `Account ${code} is a header with sub-accounts, so it cannot hold the '${setting}' role (a balance-sheet role cannot be held by a header). `
    + `Map the role to an account that has none — or, if your file's ${code} is not the chart's ${code}, renumber it in the file and import again.`,
  reactivate: (code: string, setting: string) => `Account ${code} has sub-accounts, and an account that holds a balance-sheet role such as ${setting} cannot be a header. `
    + 'Move its sub-accounts to another parent first, or choose another account for the role in Default Accounts.',
} as const;

/** Why `target` cannot take `role`, or null. `setting` is the name the caller's user knows it by. */
export function roleTargetRefusal(
  role: string, setting: string, target: RoleTarget, caller: keyof typeof HEADER_ADVICE = 'save',
): string | null {
  const { code, subtype } = target;
  if (!typeFitsSubtype(target.type, role)) {
    const allowed = Object.entries(GL_ACCOUNT_SUBTYPES_BY_TYPE)
      .filter(([, subtypes]) => (subtypes as readonly string[]).includes(role)).map(([type]) => type);
    return `Account for '${setting}' must be of type '${allowed.join("' or '")}' (got '${target.type}')`;
  }
  if (!target.isActive) return `Account ${code} for '${setting}' is inactive`;
  if (target.hasChildren && isBalanceSheetType(target.type)) return HEADER_ADVICE[caller](code, setting);
  if (subtype !== null && subtype !== role && !UNCLASSIFIED.has(subtype)) {
    // "Subtype" is what the Chart of Accounts screen calls this field.
    return `Account ${code} has the subtype '${subtype}'; only an account with the subtype 'other' (or none), or one that already has the subtype '${role}', can hold that role. Change its subtype to 'other' first.`
      + (caller === 'import' ? ` Do that in Chart of Accounts: edit account ${code}, set its subtype to 'other' and save — then run this import again.` : '');
  }
  return null;
}

/**
 * Which side of the split each account type is on — the ONE definition (Hein,
 * 2026-10-01 / 2026-10-02). A balance-sheet holder may not have sub-accounts
 * and a balance-sheet role may not be assigned to an account that has them: a
 * level 1-2 asset / liability / equity account with children is left out of
 * the balance sheet (migration 484), so postings to it would be hidden behind
 * a header. The income statement has no such filter: "Sales - Services" under
 * the revenue holder 4100 is ordinary chart maintenance, as it always was.
 * Typed over every account type, so a new type must be placed here.
 */
const BALANCE_SHEET: Record<GLAccountType, boolean> = {
  asset: true, liability: true, equity: true, revenue: false, expense: false,
};

/**
 * THE balance-sheet test for both header rules: a holder of this type may not
 * gain sub-accounts (`roleBarringChildren`), and a role may not be assigned to
 * an account of this type that has them (`roleTargetRefusal`). The type is the
 * role's too: `typeFitsSubtype` admits no role on both sides of the split.
 */
export function isBalanceSheetType(accountType: unknown): boolean {
  return typeof accountType === 'string' && Object.hasOwn(BALANCE_SHEET, accountType)
    && BALANCE_SHEET[accountType as GLAccountType];
}

/** The same split as a list, for SQL (`= ANY(...)`): generated FROM `isBalanceSheetType`, so the two cannot drift. */
export const HOLDER_NO_CHILDREN_TYPES: readonly GLAccountType[] = GL_ACCOUNT_TYPES.filter(isBalanceSheetType);

/** The role a row holds, or null. */
export function roleHeldBy(row: { account_subtype?: unknown; is_system_account?: unknown }): string | null {
  return row.is_system_account === true && isSystemAccountKey(row.account_subtype) ? row.account_subtype : null;
}

/**
 * THE predicate for "may this account be given a sub-account": the role that
 * forbids it, or null. One rule for every writer that can put a child under
 * an account — `assertParentUsable` (create, reparent), the bank route's
 * grouping, the template seed's parent wiring, the Opening Balance Equity
 * auto-create — and, as `HOLDER_NO_CHILDREN_TYPES` in SQL, for the
 * post-condition's header check (which is what judges the COA import and a
 * merge that moves children).
 *
 * The same split decides ASSIGNMENT (`roleTargetRefusal`, Hein 2026-10-02): an
 * income-statement role may be moved onto an account that has sub-accounts, a
 * balance-sheet one may not — both through `isBalanceSheetType`.
 */
export function roleBarringChildren(
  row: { account_type?: unknown; account_subtype?: unknown; is_system_account?: unknown },
): string | null {
  return isBalanceSheetType(row.account_type) ? roleHeldBy(row) : null;
}

export function holderAsParentRefusal(code: string, role: string): string {
  return `Account ${code} holds the ${role} role, and a balance-sheet account that holds a system role cannot have sub-accounts `
    + '(postings to it would be hidden behind a header). Choose another parent, or move the role in Default Accounts first.';
}
