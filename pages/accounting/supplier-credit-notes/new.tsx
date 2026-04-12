/**
 * New Supplier Credit Note Page
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Plus, Trash2, Loader2, Receipt } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface Supplier { id: string | number; name: string; company_name?: string | null }
interface LineItem { description: string; quantity: number; unitPrice: number; vatType: string }

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

const VAT_TYPES = [
  { value: 'standard', label: 'Standard (15%)' },
  { value: 'zero', label: 'Zero Rated (0%)' },
  { value: 'exempt', label: 'Exempt' },
];

const emptyLine = (): LineItem => ({ description: '', quantity: 1, unitPrice: 0, vatType: 'standard' });

export default function NewSupplierCreditNotePage() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitAction, setSubmitAction] = useState<'draft' | 'post'>('draft');
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    supplierId: '',
    creditDate: new Date().toISOString().split('T')[0],
    reference: '',
    description: '',
    notes: '',
  });
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine()]);

  useEffect(() => {
    apiFetch('/api/accounting/suppliers-list')
      .then(r => r.json())
      .then((res: { data?: Supplier[] | { suppliers?: Supplier[] } } | Supplier[]) => {
        const data = (res as { data?: unknown }).data ?? res;
        setSuppliers(Array.isArray(data) ? (data as Supplier[]) : ((data as { suppliers?: Supplier[] }).suppliers ?? []));
      })
      .catch(() => {/* non-fatal */});
  }, []);

  const subtotal = lineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0);
  const vatAmount = lineItems.reduce((s, li) => {
    const amt = li.quantity * li.unitPrice;
    return s + (li.vatType === 'standard' ? Math.round(amt * 0.15 * 100) / 100 : 0);
  }, 0);
  const total = subtotal + vatAmount;

  const updateLine = (idx: number, patch: Partial<LineItem>) =>
    setLineItems(prev => prev.map((li, i) => i === idx ? { ...li, ...patch } : li));
  const removeLine = (idx: number) => {
    if (lineItems.length === 1) return;
    setLineItems(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!form.supplierId) { setError('Please select a supplier'); return; }
    if (lineItems.some(li => !li.description.trim())) { setError('All line items need a description'); return; }
    if (lineItems.some(li => li.quantity <= 0 || li.unitPrice <= 0)) {
      setError('All line items need a positive quantity and unit price');
      return;
    }
    setError('');
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/supplier-credit-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: form.supplierId,
          creditDate: form.creditDate,
          reference: form.reference || undefined,
          description: form.description || undefined,
          lineItems,
          notes: form.notes || undefined,
          submitAction,
        }),
      });
      const json = await res.json() as { error?: { message?: string }; data?: { id?: string } };
      if (!res.ok) throw new Error(json?.error?.message ?? 'Failed to create credit note');
      await router.push('/accounting/supplier-credit-notes');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create credit note');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Hero header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/supplier-credit-notes" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back
            </Link>
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
              <h1 className="text-xl font-bold text-white">Supplier Credit Note</h1>
            </div>
          </div>
        </div>

        <form onSubmit={e => { void handleSubmit(e); }} className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            {/* Left column */}
            <div className="flex-1 min-w-0 space-y-5">
              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error}</div>
              )}

              {/* Section 1 — Details */}
              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                  Credit Note Details
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Supplier *</label>
                    <select name="supplierId" value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))} className={inp} required>
                      <option value="">Select supplier…</option>
                      {suppliers.map(s => (
                        <option key={String(s.id)} value={String(s.id)}>{s.company_name ?? s.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Credit Note Date *</label>
                    <input type="date" name="creditDate" value={form.creditDate} onChange={e => setForm(f => ({ ...f, creditDate: e.target.value }))} className={inp} required />
                  </div>
                  <div>
                    <label className={lbl}>Reference Number</label>
                    <input type="text" name="reference" value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} className={inp} placeholder="Auto-generated if blank" />
                  </div>
                  <div>
                    <label className={lbl}>Description</label>
                    <input type="text" name="description" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className={inp} placeholder="Reason for credit note" />
                  </div>
                </div>
              </div>

              {/* Section 2 — Line Items */}
              <div className={`${card} overflow-hidden`}>
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                    Line Items
                  </h3>
                  <button type="button" onClick={() => setLineItems(prev => [...prev, emptyLine()])} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-white font-semibold transition-colors">
                    <Plus className="h-3 w-3" /> Add Line
                  </button>
                </div>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden m-3">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/60">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Description</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-20">Qty</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-28">Unit Price</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 w-36">VAT Type</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-28">Total</th>
                        <th className="w-9" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {lineItems.map((li, idx) => (
                        <tr key={idx} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                          <td className="px-2 py-2"><input type="text" value={li.description} onChange={e => updateLine(idx, { description: e.target.value })} placeholder="Item description" className={inp} required /></td>
                          <td className="px-2 py-2"><input type="number" min="0.001" step="0.001" value={li.quantity} onChange={e => updateLine(idx, { quantity: Number(e.target.value) })} className={`${inp} text-right`} /></td>
                          <td className="px-2 py-2"><input type="number" min="0" step="0.01" value={li.unitPrice} onChange={e => updateLine(idx, { unitPrice: Number(e.target.value) })} className={`${inp} text-right`} /></td>
                          <td className="px-2 py-2">
                            <select name="vatType" value={li.vatType} onChange={e => updateLine(idx, { vatType: e.target.value })} className={inp}>
                              {VAT_TYPES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                            </select>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-700 dark:text-slate-300">
                            {formatCurrency(li.quantity * li.unitPrice)}
                          </td>
                          <td className="px-2 py-2">
                            <button type="button" onClick={() => removeLine(idx)} disabled={lineItems.length === 1} className="p-1.5 rounded-lg text-slate-300 dark:text-slate-700 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-20">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Section 3 — Notes */}
              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">3</span>
                  Notes
                </h3>
                <textarea name="notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} placeholder="Internal notes (optional)" className={`${inp} resize-none`} />
              </div>
            </div>

            {/* Right column — sticky summary */}
            <div className="w-72 shrink-0">
              <div className="sticky top-6">
                <div className={`${card} p-5`}>
                  <div className="flex items-center gap-2 mb-5">
                    <Receipt className="w-4 h-4 text-amber-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Summary</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Subtotal</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrency(subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">VAT</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrency(vatAmount)}</span>
                    </div>
                    <div className="h-px bg-slate-100 dark:bg-slate-800" />
                    <div className="flex justify-between">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
                      <span className="font-mono font-bold text-lg text-amber-500">{formatCurrency(total)}</span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 mt-6">
                    <button type="submit" onClick={() => setSubmitAction('post')} disabled={isSubmitting} className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                      {isSubmitting && submitAction === 'post' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Post Credit Note
                    </button>
                    <button type="submit" onClick={() => setSubmitAction('draft')} disabled={isSubmitting} className="w-full py-2.5 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 font-medium rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                      {isSubmitting && submitAction === 'draft' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Save as Draft
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
