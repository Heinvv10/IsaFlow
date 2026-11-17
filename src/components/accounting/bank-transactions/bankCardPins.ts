/**
 * bankCardPins — which cards the bank-transactions row shows once there are more accounts than fit a row (WP5).
 *
 * Pins live in the existing card-order store (bankCardOrder): the saved order is `[...pinned, PIN_BOUNDARY, ...rest]`.
 * `applyCardOrder` drops a key that is no card, so a client that does not know the boundary reads the same order.
 * Without a boundary the first MAX_PINNED cards in the user's order are the pins.
 *
 * Also the switcher's search (name, code, account number) and the middle-truncation of long names.
 */
import { applyCardOrder } from './bankCardOrder';
import type { BankAccountGroup } from './groupBankAccounts';
import type { BankAccountSummary } from './useBankTxSummary';

/** More accounts than this and the row shows pinned cards plus the "All accounts" switcher. */
export const SWITCHER_THRESHOLD = 6;
export const MAX_PINNED = 6;
/** Splits pinned keys from the rest in the saved order. Matches no account id and no `group:<id>` key. */
export const PIN_BOUNDARY = '~unpinned';

const cleanOrder = (saved: string[] | null) => (saved ? saved.filter(k => k !== PIN_BOUNDARY) : saved);

/** The keys of the pinned cards, in their order. `allKeys` is every card's key in the page's default order. */
export function pinnedKeys(allKeys: string[], saved: string[] | null): string[] {
  const at = saved ? saved.indexOf(PIN_BOUNDARY) : -1;
  if (!saved || at < 0) return applyCardOrder(allKeys, cleanOrder(saved)).slice(0, MAX_PINNED);
  const present = new Set(allKeys);
  const pins = [...new Set(saved.slice(0, at))].filter(k => present.has(k)).slice(0, MAX_PINNED);
  // Every pin gone (all their accounts deleted, or a boundary stored first): never an empty row.
  return pins.length > 0 ? pins : allKeys.slice(0, 1);
}

export interface PinResult {
  /** The order to save (null: nothing to store, the defaults already say it). */
  order: string[] | null;
  /** Why the toggle was refused (a seventh pin, or the last pin), else null. */
  refused: string | null;
}

/**
 * Pin the card if it is not pinned, unpin it if it is. A seventh pin, and unpinning the last pin (the row is never
 * empty), are refused and the order is returned as it was.
 */
export function togglePin(allKeys: string[], saved: string[] | null, key: string): PinResult {
  const pinned = pinnedKeys(allKeys, saved);
  const rest = applyCardOrder(allKeys, cleanOrder(saved)).filter(k => !pinned.includes(k));
  if (pinned.includes(key)) {
    if (pinned.length === 1) return { order: saved, refused: 'Keep at least one card pinned - pin another before unpinning this one.' };
    return { order: [...pinned.filter(k => k !== key), PIN_BOUNDARY, key, ...rest.filter(k => k !== key)], refused: null };
  }
  if (pinned.length >= MAX_PINNED) {
    return { order: saved, refused: `You can pin up to ${MAX_PINNED} cards - unpin one first.` };
  }
  return { order: [...pinned, key, PIN_BOUNDARY, ...rest.filter(k => k !== key)], refused: null };
}

export type SwitcherRow =
  | { kind: 'account'; account: BankAccountSummary; groupId: string | null; key: string }
  | { kind: 'group'; group: BankAccountGroup; key: string };

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function matches(a: BankAccountSummary, q: string): boolean {
  const number = norm(a.bankAccountNumber);
  return norm(a.accountName).includes(q) || norm(a.accountCode).includes(q)
    || (number !== '' && (number.includes(q) || number.endsWith(q)));
}

/**
 * The switcher's rows for `query`: primaries, then each group with its sub-accounts under it. A group shows when a
 * sub-account matches (with only the matching ones) or when its own name or code matches (with all of them).
 */
export function searchAccounts(primaries: BankAccountSummary[], groups: BankAccountGroup[], query: string): SwitcherRow[] {
  const q = norm(query);
  const rows: SwitcherRow[] = [];
  for (const a of primaries) {
    if (q === '' || matches(a, q)) rows.push({ kind: 'account', account: a, groupId: null, key: a.id });
  }
  for (const g of groups) {
    const groupHit = q === '' || norm(g.groupName).includes(q) || norm(g.groupCode).includes(q);
    const subs = groupHit ? g.accounts : g.accounts.filter(a => matches(a, q));
    if (subs.length === 0) continue;
    rows.push({ kind: 'group', group: g, key: `group:${g.groupId}` });
    for (const a of subs) rows.push({ kind: 'account', account: a, groupId: g.groupId, key: a.id });
  }
  return rows;
}

const TAIL_CHARS = 16;

/** A name in two parts for middle truncation: the head may be clipped, the tail (its ending) never is. */
export function splitName(name: string): { head: string; tail: string } {
  if (name.length <= TAIL_CHARS + 8) return { head: name, tail: '' };
  const cut = name.length - TAIL_CHARS;
  const space = name.indexOf(' ', cut);
  const at = space > 0 && space < name.length - 4 ? space : cut;
  return { head: name.slice(0, at), tail: name.slice(at) };
}
