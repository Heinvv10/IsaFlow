/**
 * The selected bank account of the bank-transactions page, derived SYNCHRONOUSLY so no frame shows a state the next
 * effect would undo: `selected` is the account the user chose while it is still listed, else the default (the first
 * ACTIVE account; with only inactive accounts nothing, and `noneActive` says so).
 *
 *  - A `?account_id=` deep link is handled ONCE, on the first load of the accounts once the link is readable (`linkReady`, i.e. router.isReady), found or not: found, it is chosen;
 *    missing, `notice` says so. A later refresh never re-applies it (it would yank the user back mid-session).
 *  - The default is PINNED into the chosen state on the first load, so a later change of "first active account" never
 *    moves the user silently; losing it goes through the "no longer listed" notice.
 *  - A chosen account that later leaves the summary falls back to the default, and `notice` says which went and what
 *    is shown instead.
 * A fallback notice clears when its account returns to the summary. A multi-valued link is invalid.
 *
 * CONTRACT: `accounts` must be referentially stable between renders (React state, not a fresh array per render), or the
 * render-phase update below loops.
 * The state is adjusted while rendering (React's "derive state from props" pattern), so there is no extra render with
 * the old value.
 */

import { useState } from 'react';
import { defaultBankId } from './bankTxPageView';
import type { BankAccountSummary } from './useBankTxSummary';

type Lost = { kind: 'link'; id: string } | { kind: 'gone'; id: string; name: string };

export function useBankTxSelection(
  accounts: BankAccountSummary[], deepLink: string | string[] | undefined, linkReady = true,
  /** The account chosen when the user has not chosen one (WP4a: the first card in THEIR order); must be stable between renders. */
  pickDefault: (accounts: BankAccountSummary[]) => string = defaultBankId,
) {
  const [chosen, setChosen] = useState('');
  const [seen, setSeen] = useState<BankAccountSummary[]>([]);
  const [handled, setHandled] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [lost, setLost] = useState<Lost | null>(null);
  const [dismissed, setDismissed] = useState('');

  // All updates are computed first and applied together, so the render-phase update settles in one extra pass.
  let next = chosen;
  let nextLost = lost;
  if (accounts !== seen && accounts.length > 0) {
    if (nextLost && accounts.some(b => b.id === nextLost!.id && (nextLost!.kind !== 'link' || b.isActive))) nextLost = null; // a link to an inactive account stays "not available"
    if (next && !accounts.some(b => b.id === next)) {
      nextLost = { kind: 'gone', id: next, name: seen.find(b => b.id === next)?.accountName ?? 'The selected account' };
      next = pickDefault(accounts); // re-pin the fallback so the next loss is again a notice, not a silent drift
    }
  }
  if (accounts.length > 0 && linkReady && !handled) {
    const link = typeof deepLink === 'string' ? deepLink : '';
    if (Array.isArray(deepLink) && deepLink.length > 0) nextLost = { kind: 'link', id: '' };
    else if (link !== '') {
      // An inactive account is never opened from a link (the default is shown instead, with the notice).
      if (accounts.some(b => b.id === link && b.isActive)) next = link;
      else nextLost = { kind: 'link', id: link };
    }
  }
  const handledNow = handled || (accounts.length > 0 && linkReady);
  const pinNow = pinned || (accounts.length > 0 && pickDefault(accounts) !== '');
  if (pinNow && !pinned && next === '') next = pickDefault(accounts);
  if (next !== chosen) { setChosen(next); }
  if (nextLost !== lost) { setLost(nextLost); }
  if (handledNow !== handled) { setHandled(handledNow); }
  if (pinNow !== pinned) { setPinned(pinNow); }
  if (accounts !== seen) { setSeen(accounts); }

  const selected = accounts.some(b => b.id === next) ? next : pinNow ? pickDefault(accounts) : '';
  const showing = accounts.find(b => b.id === selected);
  const message = !lost ? '' : lost.kind === 'link'
    ? `That account isn't available${showing ? `; showing ${showing.accountName}` : ''}.`
    : `${lost.name} is no longer listed${showing ? `; showing ${showing.accountName}` : ''}.`;

  return {
    selected,
    /** The user's choice: it also retires a fallback notice (they have looked at the list and picked). */
    setSelected: (id: string) => { setChosen(id); setLost(null); },
    notice: message !== '' && message !== dismissed ? message : '',
    dismissNotice: () => setDismissed(message),
    /** Accounts exist, none is active and none is chosen: nothing is selected for the user. */
    noneActive: accounts.length > 0 && selected === '',
  };
}
