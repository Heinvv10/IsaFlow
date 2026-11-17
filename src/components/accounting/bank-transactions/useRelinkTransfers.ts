/**
 * Re-link imported transactions that are the counterpart of an existing allocation (covers 'account'
 * type pointing to a bank GL) the FIRST time each bank is selected on this page (WP4a). It used to run on every selection:
 * a WRITE per card click, repeated for the same account while flicking between cards. Once per account per page visit is
 * enough: the pass is idempotent, the transfers it links come from imports and allocations (a new visit, or the
 * "re-linking failed" retry below, picks those up), and a visit's own allocations are linked by the server when they post.
 * A failed pass is not marked done, so selecting the account again retries it. The pass is non-fatal (it never blocks
 * the list), so `failed` is the only way a user learns their transfers were not linked; anything else
 * stays silent (a 403 included: that role may not write). The route writes, so it is called only for a role that may write.
 */
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { canWrite } from '@/lib/auth/writeRoles';

/** What a page-load relink linked, reported when it linked anything (`batchId` names its transfer link log entry). */
export interface RelinkOutcome { linked: number; batchId: string | null }

export function useRelinkTransfers(selectedBank: string, onLinked?: (r: RelinkOutcome) => void): boolean {
  const { companyRole } = useCompany();
  const mayWrite = canWrite(companyRole);
  const [relinkFailed, setRelinkFailed] = useState(false);
  // Accounts already re-linked during this visit to the page (a ref: a re-render must not forget them).
  const done = useRef(new Set<string>());
  // A ref, so a new callback each render is not an effect dependency (that would re-run the write).
  const onLinkedRef = useRef(onLinked);
  useEffect(() => { onLinkedRef.current = onLinked; });

  useEffect(() => {
    setRelinkFailed(false);
    if (!selectedBank || !mayWrite || done.current.has(selectedBank)) return;
    done.current.add(selectedBank);
    let cancelled = false;
    apiFetch('/api/accounting/bank-relink-transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankAccountId: selectedBank }),
    })
      .then(async res => {
        if (cancelled) return;
        // A 403 is a role that may not write (the page also hides this call from them): nothing to say.
        if (!res.ok) { if (res.status !== 403) { done.current.delete(selectedBank); setRelinkFailed(true); } return; }
        const json = await res.json();
        if (json?.data?.failed) { done.current.delete(selectedBank); setRelinkFailed(true); }
        const linked = Number(json?.data?.linked ?? 0);
        if (linked > 0) onLinkedRef.current?.({ linked, batchId: json?.data?.batchId ?? null });
      })
      .catch(() => { if (!cancelled) { done.current.delete(selectedBank); setRelinkFailed(true); } });
    return () => { cancelled = true; };
  }, [selectedBank, mayWrite]);

  return relinkFailed;
}

/**
 * `useRelinkTransfers` plus a counter that moves each time a relink linked something, so the transfer link notice
 * reloads its log and the page can reload its rows (a just-linked line would otherwise still show as New).
 */
export function useRelinkTransfersWithTick(selectedBank: string, onLinked: (r: RelinkOutcome) => void) {
  const [tick, setTick] = useState(0);
  const failed = useRelinkTransfers(selectedBank, (r) => { setTick((t) => t + 1); onLinked(r); });
  return [failed, tick] as const;
}
