/**
 * Supplier Returns / Debit Notes
 * Sage equivalent: Suppliers > Returns
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { TrendingDown, Loader2, AlertCircle, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';

function formatCurrency(n: number) {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
}

interface SupplierReturn {
  id: string; return_number: string; supplier_name: string;
  original_invoice_number?: string; amount: number;
  status: string; return_date: string; reason: string;
}
interface Supplier { id: number; name: string; }
interface Form { supplierId: string; originalInvoiceNumber: string; amount: string; reason: string; }

const EMPTY: Form = { supplierId: '', originalInvoiceNumber: '', amount: '', reason: '' };

export default function SupplierReturnsPage() {
  const [returns, setReturns] = useState<SupplierReturn[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  const loadReturns = useCallback(async () => {
    setIsLoading(true); setError('');
    try {
      const res = await fetch('/api/accounting/supplier-returns');
      const json = await res.json();
      setReturns((json.data || json).returns || []);
    } catch { setError('Failed to load supplier returns'); }
    finally { setIsLoading(false); }
  }, []);

  useEffect(() => { loadReturns(); }, [loadReturns]);

  useEffect(() => {
    fetch('/api/procurement/suppliers').then(r => r.json()).then(json => {
      const data = json.data || json;
      setSuppliers((data.suppliers || []).map((s: Record<string, unknown>) => ({
        id: s.id as number,
        name: (s.company_name || s.name) as string,
      })));
    }).catch(() => { /* non-critical */ });
  }, []);

  function set(field: keyof Form, value: string) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.supplierId) { toast.error('Please select a supplier'); return; }
    if (!form.amount || Number(form.amount) <= 0) { toast.error('Please enter a valid amount'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/accounting/supplier-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: Number(form.supplierId),
          originalInvoiceNumber: form.originalInvoiceNumber || undefined,
          amount: Number(form.amount),
          reason: form.reason || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to create return');
      toast.success('Supplier return created');
      setShowForm(false); setForm(EMPTY);
      await loadReturns();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create return');
    } finally { setSubmitting(false); }
  }

  const inp = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:border-emerald-500';
  const lbl = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-500/10">
                <TrendingDown className="h-6 w-6 text-red-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Supplier Returns</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Debit notes and returns to suppliers</p>
              </div>
            </div>
            <button onClick={() => { setForm(EMPTY); setShowForm(true); }}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-2 text-sm">
              <Plus className="h-4 w-4" /> New Return
            </button>
          </div>
        </div>

        {/* Create form panel */}
        {showForm && (
          <div className="px-6 pt-6">
            <div className="rounded-xl border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-6 mb-4">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-base font-semibold text-[var(--ff-text-primary)]">New Supplier Return</h2>
                <button onClick={() => { setShowForm(false); setForm(EMPTY); }}
                  className="text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <form onSubmit={handleSubmit}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <div>
                    <label className={lbl}>Supplier <span className="text-red-400">*</span></label>
                    <select className={inp} value={form.supplierId}
                      onChange={e => set('supplierId', e.target.value)} required>
                      <option value="">Select supplier…</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Original Invoice #</label>
                    <input type="text" className={inp} placeholder="e.g. INV-00123"
                      value={form.originalInvoiceNumber}
                      onChange={e => set('originalInvoiceNumber', e.target.value)} />
                  </div>
                  <div>
                    <label className={lbl}>Amount <span className="text-red-400">*</span></label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ff-text-secondary)] text-sm">R</span>
                      <input type="number" min="0.01" step="0.01" className={`${inp} pl-7`}
                        placeholder="0.00" value={form.amount}
                        onChange={e => set('amount', e.target.value)} required />
                    </div>
                  </div>
                  <div>
                    <label className={lbl}>Reason</label>
                    <textarea className={`${inp} resize-none h-[42px]`} placeholder="Reason for return…"
                      value={form.reason} onChange={e => set('reason', e.target.value)} />
                  </div>
                </div>
                <div className="flex justify-end gap-3">
                  <button type="button"
                    onClick={() => { setShowForm(false); setForm(EMPTY); }}
                    className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] border border-[var(--ff-border-light)] rounded-lg">
                    Cancel
                  </button>
                  <button type="submit" disabled={submitting}
                    className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2">
                    {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                    Create Return
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* List */}
        <div className="p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-red-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : returns.length === 0 ? (
            <div className="text-center py-12">
              <TrendingDown className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No supplier returns found</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">Create a debit note to process a return to a supplier</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    {['Return #', 'Supplier', 'Original Invoice', 'Date', 'Amount', 'Reason', 'Status'].map(h => (
                      <th key={h} className={`py-3 px-4 text-[var(--ff-text-secondary)] font-medium ${h === 'Amount' ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {returns.map(r => (
                    <tr key={r.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="py-3 px-4 text-[var(--ff-text-primary)] font-mono">{r.return_number}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-primary)]">{r.supplier_name}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{r.original_invoice_number || '-'}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{r.return_date?.split('T')[0]}</td>
                      <td className="py-3 px-4 text-right text-red-400">{formatCurrency(r.amount)}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{r.reason}</td>
                      <td className="py-3 px-4">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${r.status === 'processed' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-yellow-500/10 text-yellow-400'}`}>
                          {r.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
