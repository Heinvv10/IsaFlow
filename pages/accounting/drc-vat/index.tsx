/**
 * DRC (Domestic Reverse Charge) VAT Page
 * Phase 5: Self-account VAT on eligible supplier invoices
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowRightLeft, Loader2, Check } from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';

interface Invoice {
  id: string; invoiceNumber: string; supplierName: string;
  totalAmount: number; vatAmount: number; invoiceDate: string;
}

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function DRCVatPage() {
  const [eligible, setEligible] = useState<Invoice[]>([]);
  const [history, setHistory] = useState<Invoice[]>([]);
  const [tab, setTab] = useState<'eligible' | 'history'>('eligible');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const [eligRes, histRes] = await Promise.all([
      fetch('/api/accounting/drc-vat', { credentials: 'include' }),
      fetch('/api/accounting/drc-vat?tab=history', { credentials: 'include' }),
    ]);
    const eligJson = await eligRes.json();
    const histJson = await histRes.json();
    setEligible(eligJson.data?.items || []);
    setHistory(histJson.data?.items || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const applyDRC = async (invoiceId: string) => {
    setBusy(invoiceId); setError(''); setSuccess('');
    try {
      const res = await fetch('/api/accounting/drc-vat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ supplierInvoiceId: invoiceId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setSuccess(`DRC VAT applied: ${fmt(json.data?.vatAmount || 0)}`);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(''); }
  };

  const items = tab === 'eligible' ? eligible : history;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-rose-500/10"><ArrowRightLeft className="h-6 w-6 text-rose-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">DRC VAT</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Domestic Reverse Charge — self-account VAT on supplier invoices</p>
              </div>
            </div>
            <ExportCSVButton endpoint="/api/accounting/drc-vat-export" filenamePrefix="drc-vat" label="Export CSV" />
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          {success && <div className="p-3 rounded-lg bg-emerald-500/10 text-emerald-400 text-sm">{success}</div>}

          {/* Info box */}
          <div className="bg-rose-500/5 border border-rose-500/20 rounded-lg p-4 text-sm text-[var(--ff-text-secondary)]">
            <strong className="text-rose-400">How DRC works:</strong> When a supplier doesn&apos;t charge VAT on their invoice,
            FibreFlow self-accounts both Input VAT (claimable) and Output VAT (payable). The net effect is zero,
            but both sides are recorded for SARS compliance. Select invoices below to apply DRC VAT at 15%.
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-[var(--ff-bg-secondary)] rounded-lg p-1 w-fit border border-[var(--ff-border-light)]">
            <button onClick={() => setTab('eligible')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === 'eligible' ? 'bg-rose-600 text-white' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
              Eligible ({eligible.length})
            </button>
            <button onClick={() => setTab('history')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === 'history' ? 'bg-rose-600 text-white' : 'text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'}`}>
              Processed ({history.length})
            </button>
          </div>

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Invoice</th><th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3 text-right">Amount (excl)</th>
                <th className="px-4 py-3 text-right">VAT (15%)</th>
                {tab === 'eligible' && <th className="px-4 py-3">Action</th>}
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && items.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                    {tab === 'eligible' ? 'No eligible invoices for DRC VAT.' : 'No DRC VAT history.'}
                  </td></tr>
                )}
                {items.map(inv => (
                  <tr key={inv.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{inv.invoiceNumber}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{inv.supplierName}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{inv.invoiceDate}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(inv.totalAmount)}</td>
                    <td className="px-4 py-3 text-right text-rose-400 font-medium">{fmt(inv.vatAmount || inv.totalAmount * 0.15)}</td>
                    {tab === 'eligible' && (
                      <td className="px-4 py-3">
                        <button onClick={() => applyDRC(inv.id)} disabled={busy === inv.id}
                          className="inline-flex items-center gap-1 px-3 py-1.5 bg-rose-600 text-white rounded-md text-xs font-medium hover:bg-rose-700 disabled:opacity-50">
                          {busy === inv.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          Apply DRC
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
