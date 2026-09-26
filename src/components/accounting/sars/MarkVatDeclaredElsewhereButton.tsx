/**
 * Single-invoice "Mark VAT declared elsewhere" action for the invoice detail
 * page (customer-invoices/[invoiceId].tsx, supplier-invoices/[invoiceId].tsx).
 * Owner/admin only; shown only for a document with VAT and no live GL
 * journal — the same shape vatUnpostedInvoices.ts blocks on. This is an
 * affordance only: the exceptions panel (VatUnpostedInvoicesSection /
 * VatDeclaredElsewhereSection) is the authoritative list and toggle.
 */
import { useState } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { apiFetch, ApiRequestError, assertOk } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { log } from '@/lib/logger';
import { InlineReasonForm } from '@/components/shared/InlineReasonForm';

const OVERRIDE_ROLES = ['owner', 'admin', 'super_admin'];

interface Props {
  kind: 'customer' | 'supplier';
  invoiceId: string;
  glJournalEntryId: string | null;
  taxAmount: number;
  onMarked?: () => void;
}

export function MarkVatDeclaredElsewhereButton({ kind, invoiceId, glJournalEntryId, taxAmount, onMarked }: Props) {
  const { companyRole } = useCompany();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!OVERRIDE_ROLES.includes(companyRole ?? '')) return null;
  if (glJournalEntryId || !taxAmount) return null;
  if (done) {
    return <p className="text-xs text-emerald-400">Marked VAT declared outside IsaFlow.</p>;
  }

  const mark = async (reason: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/vat-declared-elsewhere', {
        method: 'POST',
        body: JSON.stringify({ action: 'mark', kind, invoiceIds: [invoiceId], reason }),
      });
      await assertOk(res, 'Could not mark this document');
      setDone(true);
      setOpen(false);
      onMarked?.();
    } catch (err) {
      log.warn('MarkVatDeclaredElsewhereButton: mark failed', { error: err }, 'MarkVatDeclaredElsewhereButton');
      setError(err instanceof ApiRequestError ? err.message : 'Could not mark this document');
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <div className="space-y-1">
        <InlineReasonForm
          label="Mark this document &quot;VAT declared outside IsaFlow&quot; — why?"
          confirmLabel="Mark"
          busy={busy}
          onConfirm={(reason) => void mark(reason)}
          onCancel={() => setOpen(false)}
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-amber-500 hover:text-amber-400 disabled:opacity-50"
      >
        <ShieldQuestion className="h-3.5 w-3.5" />
        Mark VAT declared outside IsaFlow
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
