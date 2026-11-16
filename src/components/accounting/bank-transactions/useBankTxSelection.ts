/**
 * The selected bank account of the bank-transactions page. Default: the first ACTIVE account (an inactive one holding a
 * balance is selectable but never the default; with only inactive accounts nothing is selected, and `noneActive` says
 * so). A selection that vanishes from the summary falls back to the default. A `?account_id=` deep link selects that
 * account once, when it is among the accounts; when it is not, `notice` says so instead of silently showing another.
 */

import { useEffect, useRef, useState } from 'react';
import { keepOrDefault } from './bankTxPageView';
import type { BankAccountSummary } from './useBankTxSummary';

export function useBankTxSelection(accounts: BankAccountSummary[], deepLink: string | string[] | undefined) {
  const [selected, setSelected] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const applied = useRef(false);
  useEffect(() => {
    if (accounts.length > 0) setSelected(prev => keepOrDefault(accounts, prev));
  }, [accounts]);
  useEffect(() => {
    if (applied.current || typeof deepLink !== 'string' || deepLink === '' || accounts.length === 0) return;
    if (accounts.some(b => b.id === deepLink)) { setSelected(deepLink); applied.current = true; }
  }, [deepLink, accounts]);
  const wanted = typeof deepLink === 'string' && deepLink !== '';
  const missing = wanted && accounts.length > 0 && !accounts.some(b => b.id === deepLink);
  const showing = accounts.find(b => b.id === selected);
  const notice = missing && !dismissed
    ? `That account isn't available${showing ? `; showing ${showing.accountName}` : ''}.` : '';
  return {
    selected, setSelected, notice, dismissNotice: () => setDismissed(true),
    noneActive: accounts.length > 0 && selected === '',
  };
}
