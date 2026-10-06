/**
 * Prev / Next between customer invoices on the invoice detail page — the
 * neighbours customer-invoices-adjacent names. Moved out of
 * pages/accounting/customer-invoices/[invoiceId].tsx unchanged, for the
 * 300-line cap, when R-035 PR4 added the approval panel there.
 */
import { useCallback, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export function useAdjacentInvoices() {
  const [prevId, setPrevId] = useState<string | null>(null);
  const [nextId, setNextId] = useState<string | null>(null);

  const clear = useCallback(() => { setPrevId(null); setNextId(null); }, []);

  const loadAdjacent = useCallback(async (id: string) => {
    try {
      const res = await apiFetch(`/api/accounting/customer-invoices-adjacent?id=${id}`);
      await assertOk(res, 'Could not load the neighbouring invoices');
      const json = await res.json() as { data: { prevId: string | null; nextId: string | null } };
      setPrevId(json.data?.prevId ?? null);
      setNextId(json.data?.nextId ?? null);
    } catch (err) {
      // non-critical — navigation stays disabled
      setPrevId(null);
      setNextId(null);
      log.warn('Adjacent invoices unavailable', { error: err }, 'customer-invoice-detail');
    }
  }, []);

  return { prevId, nextId, loadAdjacent, clear };
}

export function InvoiceAdjacentNav({ prevId, nextId, onGo }: {
  prevId: string | null; nextId: string | null; onGo: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button onClick={() => prevId && onGo(prevId)} disabled={!prevId} title="Previous invoice" className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
        <ArrowLeft className="h-3.5 w-3.5" /> Prev
      </button>
      <button onClick={() => nextId && onGo(nextId)} disabled={!nextId} title="Next invoice" className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-[var(--ff-text-secondary)] border border-[var(--ff-border-light)] rounded-lg hover:bg-[var(--ff-bg-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
        Next <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
