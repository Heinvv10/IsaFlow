/**
 * useBankCardOrder — loads and saves this user's bank card order for the
 * active company through /api/auth/preferences (user_preferences). A save is
 * applied at once and reverted, with a toast, if the server refuses it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { notify } from '@/utils/toast';
import { cardOrderPrefKey, parseCardOrder } from './bankCardOrder';

export function useBankCardOrder(companyId: string | null | undefined) {
  const [order, setOrder] = useState<string[] | null>(null);
  // Set by a save: the user has reordered, so a load that arrives later must not overwrite it.
  const touched = useRef(false);

  useEffect(() => {
    setOrder(null);
    touched.current = false;
    if (!companyId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch('/api/auth/preferences');
        await assertOk(res, 'Could not load your card order');
        const json = (await res.json()) as { data?: Record<string, string> };
        if (!cancelled && !touched.current) setOrder(parseCardOrder(json.data?.[cardOrderPrefKey(companyId)]));
      } catch (err) {
        log.warn('Bank card order unavailable, using the default order', { error: err }, 'bank-transactions');
      }
    })();
    return () => { cancelled = true; };
  }, [companyId]);

  const save = useCallback(async (next: string[] | null) => {
    if (!companyId) return;
    const prev = order;
    touched.current = true;
    setOrder(next);
    try {
      const res = await apiFetch('/api/auth/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ preferences: { [cardOrderPrefKey(companyId)]: next ? JSON.stringify(next) : '' } }),
      });
      await assertOk(res, 'Could not save your card order');
    } catch (err) {
      setOrder(prev);
      log.warn('Saving the bank card order failed', { error: err }, 'bank-transactions');
      notify.error(apiErrorMessage(err, 'Could not save your card order'));
    }
  }, [companyId, order]);

  return { order, save };
}
