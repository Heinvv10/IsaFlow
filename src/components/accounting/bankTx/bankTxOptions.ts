/**
 * Option lists for the bank transaction Selection cell: which list a row type draws from, the search
 * filter, the description-match ordering and the pinned suggestion. Pure functions.
 */

import type { AllocType, BankTx, SelectOption } from './bankTxTypes';

export interface OptionLists {
  glAccounts: SelectOption[];
  suppliers: SelectOption[];
  customers: SelectOption[];
  transferTargets: SelectOption[];
}

export function getOptionsForType(type: AllocType, lists: OptionLists): SelectOption[] {
  if (type === 'supplier') return lists.suppliers;
  if (type === 'customer') return lists.customers;
  if (type === 'transfer') return lists.transferTargets;
  return lists.glAccounts;
}

export function filterOptions(options: SelectOption[], q: string): SelectOption[] {
  if (!q) return options;
  const lq = q.toLowerCase();
  return options.filter(o =>
    (o.code || '').toLowerCase().includes(lq) ||
    o.name.toLowerCase().includes(lq)
  );
}

/** Sort options so names matching words in the transaction description appear first */
export function sortByDescriptionMatch(opts: SelectOption[], description: string): SelectOption[] {
  if (!description) return opts;
  const descLower = description.toLowerCase();
  // Extract meaningful words (3+ chars) from description
  const words = descLower.split(/\s+/).filter(w => w.length >= 3);
  if (words.length === 0) return opts;

  return [...opts].sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    // Check if any word from the description appears in the option name, or vice versa
    const aMatch = words.some(w => aName.includes(w)) || aName.split(/\s+/).some(w => w.length >= 3 && descLower.includes(w));
    const bMatch = words.some(w => bName.includes(w)) || bName.split(/\s+/).some(w => w.length >= 3 && descLower.includes(w));
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    return 0;
  });
}

/** Get suggested entity for a transaction based on its type */
export function getSuggestedOption(tx: BankTx, type: AllocType): SelectOption | null {
  if (type === 'supplier' && tx.suggestedSupplierId) {
    return { id: tx.suggestedSupplierId, name: tx.suggestedSupplierName || 'Suggested Supplier', code: '' };
  }
  if (type === 'customer' && tx.suggestedClientId) {
    return { id: tx.suggestedClientId, name: tx.suggestedClientName || 'Suggested Customer', code: '' };
  }
  if (type === 'account' && tx.suggestedGlAccountId) {
    return { id: tx.suggestedGlAccountId, name: tx.suggestedGlAccountName || 'Suggested Account', code: tx.suggestedGlAccountCode || '' };
  }
  return null;
}
