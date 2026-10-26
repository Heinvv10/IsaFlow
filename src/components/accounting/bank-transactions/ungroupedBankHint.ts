/**
 * ungroupedBankHint — primary bank accounts that look like they belong in an
 * existing sub-account group: three or more share a name prefix with that
 * group's members (VF, 2026-10-26: five "ABSA - PC : <card>" paycards sat
 * outside "Bank Transfer acc - ABSA Paycards"). The page offers to move them;
 * the move goes through the existing grouping PUT.
 */

import type { BankAcct } from './BankTxBankCards';
import type { BankAccountGroup } from './groupBankAccounts';

/** Fewer look-alikes than this is coincidence, not a missed group. */
export const MIN_UNGROUPED = 3;

export interface UngroupedHint {
  groupId: string;
  groupName: string;
  accounts: BankAcct[];
}

/**
 * The name up to its first ":" (e.g. "ABSA - PC" in "ABSA - PC : 4374…"), else up to its
 * first " - " ("PC" in "PC - Paycard - Byron"); lower-cased. Null when there is neither.
 */
export function namePrefix(name: string): string | null {
  const colon = name.indexOf(':');
  const cut = colon >= 0 ? colon : name.indexOf(' - ');
  const prefix = cut >= 0 ? name.slice(0, cut).trim().toLowerCase() : '';
  return prefix || null;
}

/** The prefix more than half of the group's members share, or null. */
function groupPrefix(group: BankAccountGroup): string | null {
  const tally = new Map<string, number>();
  for (const a of group.accounts) {
    const p = namePrefix(a.accountName);
    if (p) tally.set(p, (tally.get(p) ?? 0) + 1);
  }
  for (const [p, n] of tally) if (n * 2 > group.accounts.length) return p;
  return null;
}

export function findUngroupedHints(primaries: BankAcct[], groups: BankAccountGroup[]): UngroupedHint[] {
  const byPrefix = new Map<string, BankAccountGroup[]>();
  for (const g of groups) {
    const p = groupPrefix(g);
    if (p) byPrefix.set(p, [...(byPrefix.get(p) ?? []), g]);
  }
  const hints: UngroupedHint[] = [];
  for (const [prefix, owners] of byPrefix) {
    // Two groups claiming the same prefix: no way to say which one is meant.
    if (owners.length !== 1) continue;
    const strays = primaries.filter(a => namePrefix(a.accountName) === prefix);
    if (strays.length >= MIN_UNGROUPED) {
      hints.push({ groupId: owners[0]!.groupId, groupName: owners[0]!.groupName, accounts: strays });
    }
  }
  return hints;
}
