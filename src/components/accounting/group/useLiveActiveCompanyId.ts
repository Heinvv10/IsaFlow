/**
 * The active company id as the browser holds it NOW. Another tab that switches company rewrites the shared active-company
 * storage entry and cookie; this tab's React state stays on the old one, so the screen would gate member rows against a
 * company the server no longer treats as active. Re-read on a storage event, on focus and when the tab becomes visible.
 */
import { useEffect, useState } from 'react';
import { COMPANY_STORAGE_KEY, readStoredCompanyId } from '@/contexts/companyModel';

export function useLiveActiveCompanyId(contextId: string | null): string | null {
  // The re-read id, remembered with the context id it was read against: when the context moves (a same-tab switch) the
  // override no longer applies and the context's id is used at once, with no effect and no second render.
  const [override, setOverride] = useState<{ against: string | null; id: string | null } | null>(null);
  useEffect(() => {
    const sync = () => setOverride({ against: contextId, id: readStoredCompanyId() ?? contextId });
    const onStorage = (e: StorageEvent) => { if (e.key === null || e.key === COMPANY_STORAGE_KEY) sync(); };
    const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [contextId]);
  // No company in the context (its details failed to load) stays no company on every event: the screen says so and offers
  // a retry, instead of gating against a stored id on the first focus and not before it.
  if (contextId === null) return null;
  return override && override.against === contextId ? override.id : contextId;
}
