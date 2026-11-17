/**
 * Re-link imported transactions that are the counterpart of an existing allocation (covers 'account'
 * type pointing to a bank GL) the FIRST time each bank is selected on this page (WP4a). It used to run on every selection:
 * a WRITE per card click, repeated for the same account while flicking between cards. Once per account per page visit is
 * enough: the pass is idempotent, the transfers it links come from imports and allocations (a new visit, or the
 * "re-linking failed" retry below, picks those up), and a visit's own allocations are linked by the server when they post.
 * ACCEPTED LIMIT (decided in WP4a): a transfer counterpart that appears after an account's first selection of the visit (one
 * allocated on this page, or imported by someone else meanwhile) is linked on the next visit to the page, not before.
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
  // Accounts whose pass is under way, and accounts whose pass finished. A pass under way is not started twice (leaving an
  // account and coming back, or React StrictMode's second effect run); a finished one is not repeated this visit. Refs: a
  // re-render must not forget them. A pass that failed is in neither, so selecting the account again retries it.
  const inFlight = useRef(new Set<string>()), finished = useRef(new Set<string>());
  // Refs, so a new callback / selection each render is not an effect dependency (that would re-run the write).
  const onLinkedRef = useRef(onLinked);
  const shownBank = useRef(selectedBank);
  useEffect(() => { onLinkedRef.current = onLinked; shownBank.current = selectedBank; });

  useEffect(() => {
    setRelinkFailed(false);
    const bank = selectedBank;
    if (!bank || !mayWrite || inFlight.current.has(bank) || finished.current.has(bank)) return;
    inFlight.current.add(bank);
    // The answer is handled whenever it arrives, even after the user moved on: what it linked is real and the page must
    // reload for it. Only the "re-link failed" notice belongs to the account on screen NOW.
    const failed = () => { inFlight.current.delete(bank); if (shownBank.current === bank) setRelinkFailed(true); };
    apiFetch('/api/accounting/bank-relink-transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankAccountId: bank }),
    })
      .then(async res => {
        // A 403 is a role that may not write (the page also hides this call from them): nothing to say, nothing to retry.
        if (res.status === 403) { inFlight.current.delete(bank); finished.current.add(bank); return; }
        if (!res.ok) { failed(); return; }
        const json = await res.json();
        if (json?.data?.failed) failed();
        else { inFlight.current.delete(bank); finished.current.add(bank); }
        const linked = Number(json?.data?.linked ?? 0);
        if (linked > 0) onLinkedRef.current?.({ linked, batchId: json?.data?.batchId ?? null });
      })
      .catch(failed);
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
