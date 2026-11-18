/**
 * The active company id as the browser holds it NOW. Another tab that switches company rewrites the shared active-company
 * storage entry and cookie; this tab's React state stays on the old one, so the screen would gate member rows against a
 * company the server no longer treats as active. Re-read on a storage event, on focus and when the tab becomes visible.
 */
import { useEffect, useState } from 'react';
import { COMPANY_STORAGE_KEY, readStoredCompanyId } from '@/contexts/companyModel';

export function useLiveActiveCompanyId(contextId: string | null): string | null {
  const [live, setLive] = useState<string | null>(contextId);
  useEffect(() => { setLive(contextId); }, [contextId]);
  useEffect(() => {
    const sync = () => setLive(readStoredCompanyId() ?? contextId);
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
  return live;
}
