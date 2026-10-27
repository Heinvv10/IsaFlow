/**
 * useBankCardOrder — loads and saves this user's bank card order for the
 * active company through /api/auth/preferences (user_preferences). A save is
 * applied at once; saves go to the server one at a time, in order, so the
 * last order shown is the last one stored. A refused save goes back, with a
 * toast, to the order the server last confirmed, and only while it is still
 * the newest save for the same company.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { notify } from '@/utils/toast';
import { cardOrderPrefKey, parseCardOrder, withUnseen } from './bankCardOrder';

async function putOrder(companyId: string, next: string[] | null): Promise<void> {
  const res = await apiFetch('/api/auth/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ preferences: { [cardOrderPrefKey(companyId)]: next ? JSON.stringify(next) : '' } }),
  });
  await assertOk(res, 'Could not save your card order');
}

export function useBankCardOrder(companyId: string | null | undefined) {
  const [order, setOrder] = useState<string[] | null>(null);
  // The order last shown, the order the server last confirmed, the company they belong to, and how
  // many saves have started: read by saves that settle after a re-render, a company switch or a newer save.
  const orderRef = useRef<string[] | null>(null);
  const storedRef = useRef<string[] | null>(null);
  const companyRef = useRef(companyId);
  const saveSeq = useRef(0);
  // True while what is shown is a revert to storedRef: a load arriving then may replace it.
  const reverted = useRef(false);
  // True once a save has been stored: the server holds that order, newer than any load still in flight.
  const savedOk = useRef(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const show = useCallback((next: string[] | null) => { orderRef.current = next; setOrder(next); }, []);

  useEffect(() => {
    companyRef.current = companyId;
    saveSeq.current = 0;
    reverted.current = false;
    savedOk.current = false;
    storedRef.current = null;
    show(null);
    if (!companyId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/auth/preferences');
        await assertOk(res, 'Could not load your card order');
        const json = (await res.json()) as { data?: Record<string, string> };
        // A reorder made while this was loading wins over the stored order.
        if (cancelled) return;
        if (!savedOk.current) storedRef.current = parseCardOrder(json.data?.[cardOrderPrefKey(companyId)]);
        if (saveSeq.current === 0 || reverted.current) show(storedRef.current);
      } catch (err) {
        log.warn('Bank card order unavailable, using the default order', { error: err }, 'bank-transactions');
      }
    })();
    return () => { cancelled = true; };
  }, [companyId, show]);

  const save = useCallback((next: string[] | null): Promise<void> => {
    if (!companyId) return Promise.resolve();
    const seq = ++saveSeq.current;
    reverted.current = false;
    show(next);
    chain.current = chain.current.then(async () => {
      try {
        await putOrder(companyId, next);
        if (companyRef.current === companyId) { storedRef.current = next; savedOk.current = true; }
      } catch (err) {
        log.warn('Saving the bank card order failed', { error: err }, 'bank-transactions');
        if (companyRef.current !== companyId || saveSeq.current !== seq) return;
        reverted.current = true;
        show(storedRef.current);
        notify.error(apiErrorMessage(err, 'Could not save your card order'));
      }
    });
    return chain.current;
  }, [companyId, show]);

  /** The cards on screen in their new order; saved places of cards not on screen are kept after them. */
  const reorder = useCallback((keys: string[]) => save(withUnseen(keys, orderRef.current)), [save]);
  const reset = useCallback(() => save(null), [save]);

  return { order, reorder, reset };
}
