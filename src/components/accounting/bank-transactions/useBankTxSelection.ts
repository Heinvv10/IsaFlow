/**
 * The selected bank account of the bank-transactions page, derived SYNCHRONOUSLY so no frame shows a state the next
 * effect would undo: `selected` is the account the user chose while it is still listed, else the default (the first
 * ACTIVE account; with only inactive accounts nothing, and `noneActive` says so).
 *
 *  - A `?account_id=` deep link is handled ONCE, on the first load of the accounts, found or not: found, it is chosen;
 *    missing, `notice` says so. A later refresh never re-applies it (it would yank the user back mid-session).
 *  - A chosen account that later leaves the summary falls back to the default, and `notice` says which went and what
 *    is shown instead.
 * The state is adjusted while rendering (React's "derive state from props" pattern), so there is no extra render with
 * the old value.
 */

import { useState } from 'react';
import { defaultBankId } from './bankTxPageView';
import type { BankAccountSummary } from './useBankTxSummary';

export function useBankTxSelection(accounts: BankAccountSummary[], deepLink: string | string[] | undefined) {
  const [chosen, setChosen] = useState('');
  const [seen, setSeen] = useState<BankAccountSummary[]>([]);
  const [handled, setHandled] = useState(false);
  const [lost, setLost] = useState<{ kind: 'link' } | { kind: 'gone'; name: string } | null>(null);
  const [dismissed, setDismissed] = useState('');

  if (accounts !== seen) {
    setSeen(accounts);
    if (accounts.length > 0) {
      if (!handled) {
        setHandled(true);
        if (typeof deepLink === 'string' && deepLink !== '') {
          if (accounts.some(b => b.id === deepLink)) setChosen(deepLink);
          else setLost({ kind: 'link' });
        }
      } else if (chosen && !accounts.some(b => b.id === chosen)) {
        setLost({ kind: 'gone', name: seen.find(b => b.id === chosen)?.accountName ?? 'The selected account' });
        setChosen('');
      }
    }
  }

  const selected = accounts.some(b => b.id === chosen) ? chosen : defaultBankId(accounts);
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
