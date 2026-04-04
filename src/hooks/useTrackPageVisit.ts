/**
 * useTrackPageVisit — records a page visit for usage-based quick actions.
 * Fire-and-forget: errors are swallowed silently.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/apiFetch';
import { PAGE_REGISTRY } from '@/modules/accounting/constants/pageRegistry';

export function useTrackPageVisit() {
  const router = useRouter();
  const path = router.pathname;

  useEffect(() => {
    if (!path || !PAGE_REGISTRY[path]) return;

    apiFetch('/api/accounting/page-visits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).catch(() => {});
  }, [path]);
}
