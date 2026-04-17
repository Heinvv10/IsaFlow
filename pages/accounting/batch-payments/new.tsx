/**
 * Create Batch Payment Page
 * Phase 1 Sage Alignment: Select suppliers and invoices for bulk payment
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Layers, Plus, Trash2, Loader2, Receipt } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Supplier { id: string; company_name: string }
interface Invoice { id: string; invoice_number: string; total_amount: number; amount_paid: number; supplier_id: string }
interface BatchLine { key: string; supplierId: string; invoiceId: string; amount: number }

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export default function NewBatchPaymentPage() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [lines, setLines] = useState<BatchLine[]>([{ key: crypto.randomUUID(), supplierId: '', invoiceId: '', amount: 0 }]);
  const [method, setMethod] = useState('eft');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/api/accounting/suppliers-list', { credentials: 'include' }).then(r => r.json()).then(res => {
      const d = res.data || res;
      setSuppliers(Array.isArray(d) ? d : d.suppliers || []);
    }).catch(() => {/* non-critical */});
    apiFetch('/api/accounting/supplier-invoices?status=approved&status=partially_paid', { credentials: 'include' }).then(r => r.json()).then(res => {
      const d = res.data || res;
      const list = Array.isArray(d) ? d : d.invoices || d.items || [];
      setInvoices(list.filter((inv: Invoice) => Number(inv.total_amount) - Number(inv.amount_paid) > 0.01));
    }).catch(() => {/* non-critical */});
  }, []);

  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const addLine = () => setLines(p => [...p, { key: crypto.randomUUID(), supplierId: '', invoiceId: '', amount: 0 }]);
  const removeLine = (key: string) => setLines(p => p.filter(l => l.key !== key));

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(''); setBusy(true);
    const grouped: Record<string, { invoiceId: string; amount: number }[]> = {};
    for (const l of lines) {
      if (!l.supplierId || !l.invoiceId || l.amount <= 0) continue;
      if (!grouped[l.supplierId]) grouped[l.supplierId] = [];
      grouped[l.supplierId]!.push({ invoiceId: l.invoiceId, amount: l.amount });
    }
    const payments = Object.entries(grouped).map(([supplierId, allocs]) => ({ supplierId, invoiceAllocations: allocs }));
    if (payments.length === 0) { setError('Add at least one payment'); setBusy(false); return; }
    try {
      const res = await apiFetch('/api/accounting/batch-payments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentMethod: method, notes: notes || undefined, payments }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      void router.push('/accounting/batch-payments');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/batch-payments" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Batches
            </Link>
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white">New Batch Payment</h1>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            {/* Left column */}
            <div className="flex-1 min-w-0 space-y-5">
              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
                  {error}
                </div>
              )}

              {/* Payment Settings */}
              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                  Payment Settings
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Payment Method</label>
                    <select name="paymentMethod" value={method} onChange={e => setMethod(e.target.value)} className={inp}>
                      <option value="eft">EFT</option>
                      <option value="cheque">Cheque</option>
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Notes</label>
                    <input name="notes" value={notes} onChange={e => setNotes(e.target.value)} className={inp} placeholder="Optional batch notes" />
                  </div>
                </div>
              </div>

              {/* Invoices to Pay */}
              <div className={`${card} overflow-hidden`}>
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                    Invoices to Pay
                  </h3>
                  <button type="button" onClick={addLine} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-semibold transition-colors">
                    <Plus className="h-3 w-3" /> Add Line
                  </button>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Supplier</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Invoice</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-36">Amount</th>
                      <th className="w-9" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {lines.map(line => {
                      const supplierInvoices = invoices.filter(i => !line.supplierId || String(i.supplier_id) === line.supplierId);
                      const inv = invoices.find(i => i.id === line.invoiceId);
                      const balance = inv ? Number(inv.total_amount) - Number(inv.amount_paid) : 0;
                      return (
                        <tr key={line.key} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                          <td className="px-3 py-2">
                            <select name="supplierId" value={line.supplierId}
                              onChange={e => setLines(p => p.map(l => l.key === line.key ? { ...l, supplierId: e.target.value, invoiceId: '' } : l))}
                              className={inp}>
                              <option value="">Select Supplier</option>
                              {suppliers.map(s => <option key={s.id} value={s.id}>{s.company_name}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <select name="invoiceId" value={line.invoiceId}
                              onChange={e => {
                                const i = invoices.find(x => x.id === e.target.value);
                                setLines(p => p.map(l => l.key === line.key ? { ...l, invoiceId: e.target.value, amount: i ? Number(i.total_amount) - Number(i.amount_paid) : 0 } : l));
                              }}
                              className={inp}>
                              <option value="">Select Invoice</option>
                              {supplierInvoices.map(i => <option key={i.id} value={i.id}>{i.invoice_number} — {fmt(Number(i.total_amount) - Number(i.amount_paid))}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" step="0.01" min="0" max={balance || undefined} name="amount"
                              value={line.amount || ''}
                              onChange={e => setLines(p => p.map(l => l.key === line.key ? { ...l, amount: Number(e.target.value) } : l))}
                              className={`${inp} text-right`} placeholder="0.00" />
                          </td>
                          <td className="px-2 py-2">
                            {lines.length > 1 && (
                              <button type="button" onClick={() => removeLine(line.key)}
                                className="p-1.5 rounded-lg text-slate-700 dark:text-slate-300 dark:text-slate-700 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Right column — sticky summary */}
            <div className="w-72 shrink-0">
              <div className="sticky top-6">
                <div className={`${card} p-5`}>
                  <div className="flex items-center gap-2 mb-5">
                    <Receipt className="w-4 h-4 text-amber-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Batch Summary</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Lines</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{lines.length}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Method</span>
                      <span className="text-xs font-semibold uppercase text-slate-700 dark:text-slate-300">{method}</span>
                    </div>
                    <div className="h-px bg-slate-100 dark:bg-slate-800" />
                    <div className="flex justify-between">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
                      <span className="font-mono font-bold text-lg text-amber-500">{fmt(total)}</span>
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={busy || total <= 0}
                    className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
                  >
                    {busy ? <><Loader2 className="h-4 w-4 animate-spin" />Processing…</> : <><Layers className="h-4 w-4" />Create Batch</>}
                  </button>
                  <Link href="/accounting/batch-payments" className="block mt-3 text-center text-xs text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                    Cancel
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
