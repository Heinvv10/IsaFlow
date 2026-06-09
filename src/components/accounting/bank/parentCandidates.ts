/**
 * buildParentCandidates — derives group-parent options for the bank-account
 * Add/Edit modals. The list API only returns leaf accounts, so umbrellas are
 * reconstructed from their children's groupId/groupName.
 */

export interface BankAccountRow {
  id: string;
  accountCode: string;
  accountName: string;
  groupId?: string | null;
  groupName?: string | null;
  txnCount?: number;
}

export interface ParentCandidate {
  id: string;
  label: string;
}

/**
 * Distinct group umbrellas + ungrouped accounts, excluding the account being
 * edited. Leaves with their own transactions are excluded — promoting one to
 * umbrella would hide its transactions (the API rejects this too).
 */
export function buildParentCandidates(accounts: BankAccountRow[], excludeId?: string): ParentCandidate[] {
  const groups = new Map<string, string>();
  for (const a of accounts) {
    if (a.groupId && a.groupName && a.groupId !== excludeId) groups.set(a.groupId, a.groupName);
  }
  const umbrellas: ParentCandidate[] = [...groups.entries()].map(([id, name]) => ({ id, label: name }));
  const leaves: ParentCandidate[] = accounts
    .filter(a => !a.groupId && a.id !== excludeId && !groups.has(a.id) && (a.txnCount ?? 0) === 0)
    .map(a => ({ id: a.id, label: `${a.accountCode} — ${a.accountName}` }));
  return [...umbrellas, ...leaves];
}
