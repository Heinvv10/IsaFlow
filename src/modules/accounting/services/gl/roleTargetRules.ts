/**
 * May this account take a system role? ONE rule, used by the Default Accounts
 * save and by the COA import's role map, so the two cannot drift apart (they
 * did: the import checked the classification only, and put a role on an
 * inactive account — the live holder was demoted and the role had no holder).
 *
 * The account must be active (the resolver ignores inactive rows), must not be
 * a header with sub-accounts (hidden from the balance sheet, refused for direct
 * posting — migration 484), and must be unclassified ('other' or NULL) or
 * already classified for that role (Hein, 2026-09-30: no reclassifying by
 * assignment — which is also what keeps an account that holds ANOTHER role
 * from being taken from it). The account TYPE a role needs is checked by each
 * caller against its own source (the save's fixed map, the import's row).
 */
import { isSystemAccountKey } from './systemAccountKeys';

export interface RoleTarget {
  code: string;
  isActive: boolean;
  hasChildren: boolean;
  subtype: string | null;
}

/** Classifications an account may carry and still take any role. */
const UNCLASSIFIED = new Set(['other']);

/** Why `target` cannot take `role`, or null. `setting` is the name the caller's user knows it by. */
export function roleTargetRefusal(role: string, setting: string, target: RoleTarget): string | null {
  const { code, subtype } = target;
  if (!target.isActive) return `Account ${code} for '${setting}' is inactive`;
  if (target.hasChildren) {
    return `Account ${code} is a header with sub-accounts; choose one of its sub-accounts for '${setting}'`;
  }
  if (subtype !== null && subtype !== role && !UNCLASSIFIED.has(subtype)) {
    return `Account ${code} is classified '${subtype}'; only an account classified 'other' (or unclassified), or one already classified '${role}', can hold that role. It must be reclassified to 'other' first.`;
  }
  return null;
}

/**
 * The mirror of the header rule above: a role is refused a header, so the
 * account that HOLDS a role may not be made one afterwards (a child created
 * under it, an account moved under it, a bank account grouped under it). The
 * role a row holds, or null.
 */
export function roleHeldBy(row: { account_subtype?: unknown; is_system_account?: unknown }): string | null {
  return row.is_system_account === true && isSystemAccountKey(row.account_subtype) ? row.account_subtype : null;
}

export function holderAsParentRefusal(code: string, role: string): string {
  return `Account ${code} holds the ${role} role, and an account that holds a system role cannot have sub-accounts `
    + '(postings to it would be hidden behind a header). Choose another parent, or move the role in Default Accounts first.';
}
