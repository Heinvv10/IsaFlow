/**
 * Supplier Returns / Debit Notes — redesigned to match ISAFlow design system
 */
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { TrendingDown, Loader2, Plus, X, Trash2, Receipt } from 'lucide-react';
import { notify } from '@/utils/toast';
import { formatCurrency } from '@/utils/formatters';
import { StatusPill, PageHeader } from '@/components/ui';
import { apiFetch } from '@/lib/apiFetch';

interface SupplierReturn {
  id: string; return_number: string; supplier_name: string;
  original_invoice_number?: string; amount: number;
  status: string; return_date: string; reason: string;
}
interface Supplier { id: number; name: string }
interface Form { supplierId: string; originalInvoiceNumber: string; amount: string; reason: string }

const EMPTY: Form = { supplierId: '', originalInvoiceNumber: '', amount: '', reason: '' };

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export default function SupplierReturnsPage() {
  const [returns, setReturns] = useState<SupplierReturn[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  const loadReturns = useCallback(async () => {
    setIsLoading(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/supplier-returns');
      const json = await res.json();
      setReturns((json.data || json).returns || []);
    } catch { setError('Failed to load supplier returns'); }
    finally { setIsLoading(false); }
  }, []);

  useEffect(() => { loadReturns(); }, [loadReturns]);

  useEffect(() => {
    apiFetch('/api/accounting/suppliers-list').then(r => r.json()).then(json => {
      const data = json.data || json;
      setSuppliers((data.suppliers || []).map((s: Record<string, unknown>) => ({ id: s.id as number, name: (s.company_name || s.name) as string })));
    }).catch(() => { /* non-critical */ });
  }, []);

  function setField(field: keyof Form, value: string) { setForm(f => ({ ...f, [field]: value })); }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.supplierId) { notify.error('Please select a supplier'); return; }
    if (!form.amount || Number(form.amount) <= 0) { notify.error('Please enter a valid amount'); return; }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/supplier-returns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplierId: Number(form.supplierId), originalInvoiceNumber: form.originalInvoiceNumber || undefined, amount: Number(form.amount), reason: form.reason || undefined }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || 'Failed to create return');
      notify.success('Supplier return created');
      setShowModal(false); setForm(EMPTY);
      await loadReturns();
    } catch (err) { notify.error(err instanceof Error ? err.message : 'Failed to create return'); }
    finally { setSubmitting(false); }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={TrendingDown}
          title="Supplier Returns"
          subtitle={`${returns.length} ${returns.length === 1 ? 'return' : 'returns'}`}
          actions={
            <button onClick={() => { setForm(EMPTY); setShowModal(true); }} className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" /> New Return
            </button>
          }
        />

        <div className="p-6">
          {error && <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error}</div>}

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {isLoading ? (
              <div className="p-16 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" /></div>
            ) : returns.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4"><TrendingDown className="w-7 h-7 text-slate-500 dark:text-slate-400" /></div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No supplier returns found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Create a debit note to process a return to a supplier</p>
                <button onClick={() => setShowModal(true)} className="mt-5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-lg transition-colors">New Return</button>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['Return #', 'Supplier', 'Original Invoice', 'Date', 'Amount', 'Reason', 'Status'].map((h, i) => (
                      <th key={i} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 4 ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {returns.map(r => {
                    return (
                      <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                        <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{r.return_number}</td>
                        <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{r.supplier_name}</td>
                        <td className="px-5 py-3.5 font-mono text-xs text-slate-500 dark:text-slate-400">{r.original_invoice_number || '—'}</td>
                        <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-400">{r.return_date?.split('T')[0]}</td>
                        <td className="px-5 py-3.5 text-right font-mono font-semibold text-red-500 dark:text-red-400">{formatCurrency(r.amount)}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs max-w-[200px] truncate">{r.reason}</td>
                        <td className="px-5 py-3.5"><StatusPill status={r.status} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 pb-8 px-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto" onClick={e => e.target === e.currentTarget && setShowModal(false)}>
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center"><Trash2 className="w-4 h-4 text-amber-500" /></div>
                <div><h2 className="text-base font-semibold text-slate-900 dark:text-white">New Supplier Return</h2><p className="text-xs text-slate-500 dark:text-slate-400">Debit note / return to supplier</p></div>
              </div>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors"><X className="w-4 h-4" /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="p-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Supplier *</label>
                    <select className={inp} value={form.supplierId} onChange={e => setField('supplierId', e.target.value)} required>
                      <option value="">Select supplier…</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Original Invoice #</label>
                    <input type="text" className={inp} placeholder="e.g. INV-00123" value={form.originalInvoiceNumber} onChange={e => setField('originalInvoiceNumber', e.target.value)} />
                  </div>
                  <div>
                    <label className={lbl}>Amount *</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 text-sm font-medium">R</span>
                      <input type="number" min="0.01" step="0.01" className={`${inp} pl-7`} placeholder="0.00" value={form.amount} onChange={e => setField('amount', e.target.value)} required />
                    </div>
                  </div>
                  <div>
                    <label className={lbl}>Reason</label>
                    <textarea className={`${inp} resize-none`} rows={1} placeholder="Reason for return…" value={form.reason} onChange={e => setField('reason', e.target.value)} />
                  </div>
                </div>
                {form.amount && Number(form.amount) > 0 && (
                  <div className={`${card} p-4`}>
                    <div className="flex items-center gap-2 mb-2"><Receipt className="w-4 h-4 text-amber-500" /><span className="text-sm font-semibold text-slate-900 dark:text-white">Return Amount</span></div>
                    <p className="font-mono font-bold text-lg text-red-500 dark:text-red-400">{formatCurrency(Number(form.amount))}</p>
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2 bg-slate-50/50 dark:bg-slate-800/20">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
                <button type="submit" disabled={submitting} className="px-5 py-2 text-sm font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2">
                  {submitting ? <><Loader2 className="w-4 h-4 animate-spin" />Creating…</> : 'Create Return'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppLayout>
  );
}
