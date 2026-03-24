/**
 * VAT Adjustments Page
 * Phase 1 Sage Alignment: Manual VAT corrections
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Percent, Plus, Check, Loader2 } from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';

interface VATAdjustment {
  id: string; adjustmentNumber: string; adjustmentDate: string; vatPeriod?: string;
  adjustmentType: string; amount: number; reason: string; status: string;
}

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  approved: 'bg-emerald-500/10 text-emerald-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

export default function VATAdjustmentsPage() {
  const [items, setItems] = useState<VATAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    adjustmentDate: new Date().toISOString().split('T')[0],
    vatPeriod: '', adjustmentType: 'input', amount: '', reason: '',
  });
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/accounting/vat-adjustments', { credentials: 'include' });
    const json = await res.json();
    setItems(json.data?.items || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy('new');
    try {
      const res = await fetch('/api/accounting/vat-adjustments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          adjustmentDate: form.adjustmentDate,
          vatPeriod: form.vatPeriod || undefined,
          adjustmentType: form.adjustmentType,
          amount: Number(form.amount),
          reason: form.reason,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setShowForm(false);
      setForm({ adjustmentDate: new Date().toISOString().split('T')[0], vatPeriod: '', adjustmentType: 'input', amount: '', reason: '' });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(''); }
  };

  const filteredItems = items.filter(item => {
    const d = item.adjustmentDate?.split('T')[0] || '';
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  });

  const approve = async (id: string) => {
    setBusy(id);
    await fetch('/api/accounting/vat-adjustments-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ action: 'approve', id }),
    });
    await load(); setBusy('');
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10"><Percent className="h-6 w-6 text-orange-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">VAT Adjustments</h1>
            </div>
            <div className="flex items-center gap-2">
              <ExportCSVButton endpoint="/api/accounting/vat-adjustments-export" filenamePrefix="vat-adjustments" label="Export CSV" />
              <button onClick={() => setShowForm(!showForm)} className="inline-flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> New Adjustment
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

          <div className="flex items-center gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">From</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">To</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="ff-input text-sm" />
            </div>
            {(dateFrom || dateTo) && (
              <button onClick={() => { setDateFrom(''); setDateTo(''); }} className="mt-4 text-xs text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-secondary)]">Clear</button>
            )}
            <span className="mt-4 text-sm text-[var(--ff-text-secondary)] ml-auto">{filteredItems.length} adjustments</span>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">New VAT Adjustment</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input type="date" value={form.adjustmentDate} onChange={e => setForm(f => ({ ...f, adjustmentDate: e.target.value }))} className="ff-input" required />
                <input value={form.vatPeriod} onChange={e => setForm(f => ({ ...f, vatPeriod: e.target.value }))} className="ff-input" placeholder="VAT Period (e.g. 2026-01)" />
                <select value={form.adjustmentType} onChange={e => setForm(f => ({ ...f, adjustmentType: e.target.value }))} className="ff-select">
                  <option value="input">Input VAT (Claimable)</option>
                  <option value="output">Output VAT (Payable)</option>
                </select>
                <input type="number" step="0.01" min="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} className="ff-input" placeholder="Amount *" required />
              </div>
              <div>
                <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="ff-input w-full" placeholder="Reason for adjustment *" required />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
                <button type="submit" disabled={busy === 'new'} className="px-6 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Adjustment'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">VA Number</th><th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Period</th><th className="px-4 py-3">Type</th>
                <th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Status</th><th className="px-4 py-3">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && filteredItems.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No VAT adjustments</td></tr>}
                {filteredItems.map(item => (
                  <tr key={item.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{item.adjustmentNumber}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.adjustmentDate?.split('T')[0]}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.vatPeriod || '—'}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${item.adjustmentType === 'input' ? 'bg-blue-500/10 text-blue-400' : 'bg-orange-500/10 text-orange-400'}`}>{item.adjustmentType}</span></td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(item.amount)}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] truncate max-w-[200px]">{item.reason}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[item.status] || ''}`}>{item.status}</span></td>
                    <td className="px-4 py-3">
                      {item.status === 'draft' && (
                        <button onClick={() => approve(item.id)} disabled={busy === item.id} className="p-1 text-emerald-400 hover:text-emerald-300" title="Approve">
                          {busy === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        </button>
                      )}
                    </td>
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
