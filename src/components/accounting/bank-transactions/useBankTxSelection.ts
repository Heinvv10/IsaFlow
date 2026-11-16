/**
 * The selected bank account of the bank-transactions page. Default: the first ACTIVE account (an inactive one holding a
 * balance is selectable but never the default). A selection that vanishes from the summary falls back to the default.
 * A `?account_id=` deep link selects that account once, when it is among the accounts.
 */

import { useEffect, useRef, useState } from 'react';
import { keepOrDefault } from './bankTxPageView';
import type { BankAccountSummary } from './useBankTxSummary';

export function useBankTxSelection(accounts: BankAccountSummary[], deepLink: string | string[] | undefined) {
  const [selected, setSelected] = useState('');
  const applied = useRef(false);
  useEffect(() => {
    if (accounts.length > 0) setSelected(prev => keepOrDefault(accounts, prev));
  }, [accounts]);
  useEffect(() => {
    if (applied.current || typeof deepLink !== 'string' || deepLink === '' || accounts.length === 0) return;
    if (accounts.some(b => b.id === deepLink)) { setSelected(deepLink); applied.current = true; }
  }, [deepLink, accounts]);
  return [selected, setSelected] as const;
}
