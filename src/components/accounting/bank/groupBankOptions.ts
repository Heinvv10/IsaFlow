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
    // An umbrella is a group label only — never a selectable option, not even
    // when it is itself the child of another umbrella (it stays unselectable).
    if (umbrellaIds.has(a.id)) {
      if (!groupIndex.has(a.id)) {
        groupIndex.set(a.id, groups.length);
        groups.push({ umbrella: a, children: [] });
      } else {
        groups[groupIndex.get(a.id)!]!.umbrella = a;
      }
      continue;
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

    primaries.push(a);
  }

  // Drop groups whose only members were themselves umbrellas (no selectable
  // children) — an empty <optgroup> is noise.
  return { primaries, groups: groups.filter(g => g.children.length > 0) };
}
