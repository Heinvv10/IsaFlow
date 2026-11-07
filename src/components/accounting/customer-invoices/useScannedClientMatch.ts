/**
 * The new-invoice page's scanned-customer lookup (pages/accounting/customer-invoices/new.tsx), moved out to keep the
 * page under 300 lines. The page owns the form; this owns the scanned client, the lookup sequence and the lookup state.
 */
import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { fuzzyMatchClient } from '@/modules/accounting/utils/fuzzyMatch';
import type { InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';

export interface Client { id: string; name: string }
const SCAN_LOOKUP_TIMEOUT = 'Could not find the scanned customer in time - pick the client yourself';

export function useScannedClientMatch(setForm: Dispatch<SetStateAction<InvoiceHeaderForm>>, setError: (message: string) => void) {
  const [scanned, setScanned] = useState<Client | null>(null); // the client a scan matched, so the picker need not look it up

  // The picker searches for itself; the full list is only needed here, to match a scanned name, so it is fetched on demand.
  // Bumped by every scan, every client the user picks and every form reset: a lookup answers only if none of them happened since.
  const lookupSeq = useRef(0);
  // Create and Approve & email wait for a scan's lookup (it must not land on a created invoice's form, or the next one),
  // saying so, for 15 s at most, and not once the user picked a customer themselves (which also voids the lookup).
  const [scanLookup, setScanLookup] = useState<number | null>(null);
  async function matchScannedClient(name: string, seq: number) {
    setScanLookup(seq);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const res = await Promise.race([
        apiFetch('/api/accounting/customers', { credentials: 'include' }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('scan lookup timed out')); }, 15_000); }),
      ]);
      await assertOk(res, 'Could not load clients - try again');
      const json = await res.json();
      if (lookupSeq.current !== seq) return;
      const d = json.data || json;
      const clients: Client[] = Array.isArray(d) ? d : d.clients || [];
      const match = fuzzyMatchClient(name, clients);
      const hit = match ? clients.find(c => String(c.id) === String(match.id)) : undefined;
      if (hit) { setForm(f => ({ ...f, clientId: String(hit.id) })); setScanned({ id: String(hit.id), name: hit.name }); }
    } catch (err) { if (lookupSeq.current === seq) setError(timedOut ? SCAN_LOOKUP_TIMEOUT : apiErrorMessage(err, 'Could not load clients - try again')); }
    finally { clearTimeout(timer); setScanLookup(s => (s === seq ? null : s)); }
  }
  return { scanned, lookupSeq, scanLookup, setScanLookup, matchScannedClient };
}
