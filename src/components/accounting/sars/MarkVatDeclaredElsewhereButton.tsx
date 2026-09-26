/**
 * Single-invoice "Mark VAT declared elsewhere" action for the invoice detail
 * page (customer-invoices/[invoiceId].tsx, supplier-invoices/[invoiceId].tsx).
 * Owner/admin only; shown only for a document with VAT and no live GL
 * journal — the same shape vatUnpostedInvoices.ts blocks on. This is an
 * affordance only: the exceptions panel (VatUnpostedInvoicesSection /
 * VatDeclaredElsewhereSection) is the authoritative list and toggle.
 */
import { useState } from 'react';
import { Loader2, ShieldQuestion } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';

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
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (!OVERRIDE_ROLES.includes(companyRole ?? '')) return null;
  if (glJournalEntryId || !taxAmount) return null;
  if (done) {
    return <p className="text-xs text-emerald-400">Marked VAT declared outside IsaFlow.</p>;
  }

  const mark = async () => {
    const reason = window.prompt('Mark this document "VAT declared outside IsaFlow" — why?');
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await apiFetch('/api/accounting/vat-declared-elsewhere', {
        method: 'POST',
        body: JSON.stringify({ action: 'mark', kind, invoiceIds: [invoiceId], reason: reason.trim() }),
      });
      setDone(true);
      onMarked?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button" disabled={busy} onClick={() => void mark()}
      className="inline-flex items-center gap-1.5 text-xs text-amber-500 hover:text-amber-400 disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldQuestion className="h-3.5 w-3.5" />}
      Mark VAT declared outside IsaFlow
    </button>
  );
}
