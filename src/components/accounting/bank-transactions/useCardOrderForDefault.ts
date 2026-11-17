/**
 * useCardOrderForDefault - READS the user's saved bank card order once, so the page can open on their first card (WP4a).
 * Read-only on purpose: the order is saved and edited by useBankCardOrder (the cards); this never writes. `ready` turns true
 * when the order has loaded or could not be loaded (then the default order stands), so a default is never chosen before
 * the answer is known.
 */

import { useEffect, useState } from 'react';
import { useActiveCompanyIdOrUndefined } from '@/contexts/CompanyContext';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { cardOrderPrefKey, parseCardOrder } from './bankCardOrder';

export function useCardOrderForDefault(): { order: string[] | null; ready: boolean } {
  const companyId = useActiveCompanyIdOrUndefined();
  const [state, setState] = useState<{ for: string | null; order: string[] | null }>({ for: null, order: null });
  useEffect(() => {
    if (!companyId) return undefined; // no provider (undefined): nothing to read; no company yet (null): wait
    let cancelled = false;
    void (async () => {
      let order: string[] | null = null;
      try {
        const res = await apiFetch('/api/auth/preferences');
        await assertOk(res, 'Could not load your card order');
        order = parseCardOrder(((await res.json()) as { data?: Record<string, string> }).data?.[cardOrderPrefKey(companyId)]);
      } catch (err) {
        // The page still opens: on the default order (the cards report this themselves, with a toast, when they load it).
        log.warn('Bank card order unavailable for the default account, using the default order', { error: err }, 'bank-transactions');
      }
      if (!cancelled) setState({ for: companyId, order });
    })();
    return () => { cancelled = true; };
  }, [companyId]);
  // Outside a provider there is no order to wait for.
  return { order: state.for === companyId ? state.order : null, ready: companyId === undefined || (!!companyId && state.for === companyId) };
}
