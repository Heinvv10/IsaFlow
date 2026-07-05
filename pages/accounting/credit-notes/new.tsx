/**
 * Create Credit Note Page — redesigned to match ISAFlow design system
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2, Receipt } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface Client { id: string; company_name: string }
interface Supplier { id: number; name: string }

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export default function NewCreditNotePage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    type: 'customer' as 'customer' | 'supplier',
    clientId: '',
    supplierId: '',
    creditDate: new Date().toISOString().split('T')[0],
    reason: '',
    subtotal: 0,
    taxRate: 15,
  });

  const taxAmount = Math.round(form.subtotal * form.taxRate / 100 * 100) / 100;
  const totalAmount = form.subtotal + taxAmount;

  useEffect(() => {
    apiFetch('/api/accounting/customers').then(r => r.json()).then(res => {
      const data = res.data || res;
      setClients(Array.isArray(data) ? data : data.clients || []);
    }).catch(() => {
      setError('Failed to load clients');
    });
    apiFetch('/api/accounting/suppliers-list').then(r => r.json()).then(res => {
      const data = res.data || res;
      setSuppliers(Array.isArray(data) ? data : data.suppliers || []);
    }).catch(() => {
      setError('Failed to load suppliers');
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(''); setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/credit-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          type: form.type,
          clientId: form.type === 'customer' ? form.clientId : undefined,
          supplierId: form.type === 'supplier' ? form.supplierId : undefined,
          creditDate: form.creditDate,
          reason: form.reason || undefined,
          subtotal: form.subtotal,
          taxRate: form.taxRate,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message || 'Failed to create credit note');
      void router.push('/accounting/credit-notes');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create credit note');
    } finally { setIsSubmitting(false); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/credit-notes" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Credit Notes
            </Link>
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white">New Credit Note</h1>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            <div className="flex-1 min-w-0 space-y-5">
              {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error}</div>}

              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                  Credit Note Details
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Type *</label>
                    <select name="type" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as 'customer' | 'supplier', clientId: '', supplierId: '' }))} className={inp}>
                      <option value="customer">Customer Credit Note</option>
                      <option value="supplier">Supplier Credit Note</option>
                    </select>
                  </div>

                  {form.type === 'customer' ? (
                    <div>
                      <label className={lbl}>Client *</label>
                      <select name="clientId" value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} className={inp} required>
                        <option value="">Select client…</option>
                        {clients.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className={lbl}>Supplier *</label>
                      <select name="supplierId" value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))} className={inp} required>
                        <option value="">Select supplier…</option>
                        {suppliers.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className={lbl}>Credit Date *</label>
                    <input type="date" name="creditDate" value={form.creditDate} onChange={e => setForm(f => ({ ...f, creditDate: e.target.value }))} className={inp} required />
                  </div>
                  <div>
                    <label className={lbl}>Reason</label>
                    <input type="text" name="reason" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="Reason for credit note" className={inp} />
                  </div>
                </div>
              </div>

              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                  Amounts
                </h3>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className={lbl}>Subtotal (excl. VAT) *</label>
                    <input type="number" name="subtotal" step="0.01" min="0" value={form.subtotal || ''} onChange={e => setForm(f => ({ ...f, subtotal: Number(e.target.value) }))} className={inp} required />
                  </div>
                  <div>
                    <label className={lbl}>VAT Rate (%)</label>
                    <input type="number" name="taxRate" step="0.01" min="0" value={form.taxRate} onChange={e => setForm(f => ({ ...f, taxRate: Number(e.target.value) }))} className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>VAT Amount</label>
                    <div className={`${inp} bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400`}>{formatCurrency(taxAmount)}</div>
                  </div>
                </div>
              </div>
            </div>

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
                      <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrency(form.subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">VAT ({form.taxRate}%)</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrency(taxAmount)}</span>
                    </div>
                    <div className="h-px bg-slate-100 dark:bg-slate-800" />
                    <div className="flex justify-between">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
                      <span className="font-mono font-bold text-lg text-amber-500">{formatCurrency(totalAmount)}</span>
                    </div>
                  </div>
                  <button type="submit" disabled={isSubmitting || form.subtotal <= 0} className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                    {isSubmitting ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><FileText className="h-4 w-4" />Create Credit Note</>}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
