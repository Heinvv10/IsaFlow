/**
 * The active company id as the browser holds it NOW. Another tab that switches company rewrites the shared active-company
 * storage entry and cookie; this tab's React state stays on the old one, so the screen would gate member rows against a
 * company the server no longer treats as active. Re-read on a storage event, on focus and when the tab becomes visible.
 */
import { useEffect, useRef, useState } from 'react';
import { COMPANY_STORAGE_KEY, readStoredCompanyId } from '@/contexts/companyModel';

export function useLiveActiveCompanyId(contextId: string | null): string | null {
  // A generation that moves each time the context's id changes (render-time, idempotent: the same id never bumps it). The
  // re-read id is tagged with the generation it was read in, so a context change invalidates every earlier override for
  // good: A -> B -> A does not bring back an override read in the first A. Derived in render: no sync effect, no extra render.
  const generation = useRef({ id: contextId, n: 0 });
  if (generation.current.id !== contextId) generation.current = { id: contextId, n: generation.current.n + 1 };
  const [override, setOverride] = useState<{ generation: number; id: string | null } | null>(null);
  useEffect(() => {
    const sync = () => setOverride({ generation: generation.current.n, id: readStoredCompanyId() ?? contextId });
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
  return override && override.generation === generation.current.n ? override.id : contextId;
}
