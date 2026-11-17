/**
 * firstCardAccount - the account the page opens on when the user has not chosen one (WP4a): the FIRST CARD in the user's
 * own card order, not the first account the API happens to list. Cards are the primary accounts and one per sub-account
 * group (keys `group:<id>`); a group opens on the sub-account last opened there, else its first active one. Inactive
 * accounts are never the default. Anything unknown falls back to the first active account.
 */

import { applyCardOrder } from './bankCardOrder';
import { pinnedKeys } from './bankCardPins';
import { groupBankAccounts } from './groupBankAccounts';
import { defaultBankId } from './bankTxPageView';
import type { BankAccountSummary } from './useBankTxSummary';

export function firstCardAccount(
  accounts: BankAccountSummary[], order: string[] | null, lastOpened: (groupId: string) => string | null = () => null,
): string {
  const { primaries, groups } = groupBankAccounts(accounts);
  const all = [...primaries.map(b => b.id), ...groups.map(g => `group:${g.groupId}`)];
  // The cards SHOWN come first, exactly as the row shows them (a boundary stored first gives the single first card, not the
  // first card after it); then the rest in the user's order.
  const pins = pinnedKeys(all, order);
  const keys = [...pins, ...applyCardOrder(all, order).filter(k => !pins.includes(k))];
  for (const key of keys) {
    const primary = primaries.find(b => b.id === key);
    if (primary) { if (primary.isActive) return primary.id; continue; }
    const group = groups.find(g => `group:${g.groupId}` === key);
    if (!group) continue;
    const resume = group.accounts.find(a => a.id === lastOpened(group.groupId) && a.isActive);
    const first = resume ?? group.accounts.find(a => a.isActive);
    if (first) return first.id;
  }
  return defaultBankId(accounts);
}
