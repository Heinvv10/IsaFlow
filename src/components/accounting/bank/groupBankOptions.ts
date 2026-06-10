/**
 * groupBankAccountOptions — buckets a flat bank-account list into primary
 * accounts and umbrella groups for use in <optgroup>-based pickers. An account
 * is an umbrella iff another row in the same list names it as parentAccountId;
 * the umbrella itself is NOT returned as a selectable option (you cannot import
 * or reconcile into it — each sub-account has its own statement). Children whose
 * parent is absent from the list fall back to primaries.
 */

export interface BankAccountGrouping<T> {
  primaries: T[];
  groups: { umbrella: T; children: T[] }[];
}

export function groupBankAccountOptions<
  T extends { id: string; parentAccountId: string | null },
>(accounts: T[]): BankAccountGrouping<T> {
  const byId = new Map(accounts.map(a => [a.id, a]));
  const umbrellaIds = new Set<string>();
  for (const a of accounts) {
    if (a.parentAccountId && byId.has(a.parentAccountId)) {
      umbrellaIds.add(a.parentAccountId);
    }
  }

  const primaries: T[] = [];
  const groups: { umbrella: T; children: T[] }[] = [];
  const groupIndex = new Map<string, number>();

  for (const a of accounts) {
    // Register this account as an umbrella group if it has children in the list
    if (umbrellaIds.has(a.id)) {
      if (!groupIndex.has(a.id)) {
        groupIndex.set(a.id, groups.length);
        groups.push({ umbrella: a, children: [] });
      } else {
        groups[groupIndex.get(a.id)!]!.umbrella = a;
      }
      // An umbrella may also be a child of another umbrella — fall through to
      // the parent-check below so it gets added as a child there too.
    }

    if (a.parentAccountId && byId.has(a.parentAccountId)) {
      // Parent is present in the list — add this account as a child of its group
      const parentId = a.parentAccountId;
      let idx = groupIndex.get(parentId);
      if (idx === undefined) {
        idx = groups.length;
        groupIndex.set(parentId, idx);
        groups.push({ umbrella: byId.get(parentId)!, children: [] });
      }
      groups[idx]!.children.push(a);
      continue;
    }

    // Only reach here for accounts that are neither umbrellas nor have a
    // known parent — i.e. true standalone primaries
    if (!umbrellaIds.has(a.id)) {
      primaries.push(a);
    }
  }

  return { primaries, groups };
}
