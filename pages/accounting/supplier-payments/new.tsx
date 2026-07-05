/**
 * Create Supplier Payment Page — redesigned to match ISAFlow design system
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Wallet, Loader2, Plus, Trash2, Info, Receipt } from 'lucide-react';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { fuzzyMatchSupplier } from '@/modules/accounting/utils/fuzzyMatch';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface Supplier { id: string; name: string }
interface OutstandingInvoice { id: string; invoiceNumber: string; totalAmount: number; balance: number }
interface Allocation { key: string; invoiceId: string; amount: number }

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export default function NewSupplierPaymentPage() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [invoices, setInvoices] = useState<OutstandingInvoice[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [scanBanner, setScanBanner] = useState<string | null>(null);

  const [form, setForm] = useState({
    supplierId: '',
    paymentDate: new Date().toISOString().split('T')[0],
    paymentMethod: 'eft',
    reference: '',
    description: '',
  });

  const [allocations, setAllocations] = useState<Allocation[]>([{ key: crypto.randomUUID(), invoiceId: '', amount: 0 }]);

  useEffect(() => {
    apiFetch('/api/accounting/suppliers-list').then(r => r.json()).then(res => {
      const data = res.data || res;
      setSuppliers(Array.isArray(data) ? data : data.suppliers || []);
    }).catch(() => setError('Failed to load suppliers'));
  }, []);

  useEffect(() => {
    if (!form.supplierId) { setInvoices([]); return; }
    apiFetch(`/api/accounting/supplier-invoices?supplier_id=${form.supplierId}&status=approved`).then(r => r.json()).then(res => {
      const payload = res.data || res;
      const all = payload.invoices || [];
      setInvoices(all.filter((inv: OutstandingInvoice) => inv.balance > 0));
    }).catch(() => setInvoices([]));
  }, [form.supplierId]);

  const addAllocation = () => setAllocations(prev => [...prev, { key: crypto.randomUUID(), invoiceId: '', amount: 0 }]);
  const updateAllocation = (key: string, field: keyof Allocation, value: string | number) =>
    setAllocations(prev => prev.map(a => a.key === key ? { ...a, [field]: value } : a));
  const removeAllocation = (key: string) => {
    if (allocations.length <= 1) return;
    setAllocations(prev => prev.filter(a => a.key !== key));
  };

  const totalAmount = allocations.reduce((sum, a) => sum + (a.amount || 0), 0);

  function handleExtracted(data: ExtractedDocument) {
    if (data.date) setForm(f => ({ ...f, paymentDate: data.date! }));
    if (data.referenceNumber) setForm(f => ({ ...f, reference: data.referenceNumber! }));
    if (data.vendorName && suppliers.length > 0) {
      const match = fuzzyMatchSupplier(data.vendorName, suppliers.map(s => ({ id: String(s.id), name: s.name })));
      if (match) setForm(f => ({ ...f, supplierId: String(match.id) }));
    }
    if (data.totalAmount && invoices.length > 0) {
      const exactMatch = invoices.find(inv => Math.abs(inv.balance - data.totalAmount!) < 0.02);
      if (exactMatch) setAllocations([{ key: crypto.randomUUID(), invoiceId: exactMatch.id, amount: data.totalAmount }]);
    }
    setScanBanner(`Auto-filled from document (${Math.round(data.confidence * 100)}% confidence). Review all fields.`);
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/supplier-payments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: form.supplierId, paymentDate: form.paymentDate, totalAmount,
          paymentMethod: form.paymentMethod, reference: form.reference || undefined,
          description: form.description || undefined,
          allocations: allocations.filter(a => a.invoiceId && a.amount > 0).map(a => ({ invoiceId: a.invoiceId, amount: a.amount })),
        }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error?.message || 'Failed to create payment'); }
      const json = await res.json();
      const payment = json.data || json;
      void router.push(`/accounting/supplier-payments/${payment.id}`);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to create payment'); }
    finally { setIsSubmitting(false); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/supplier-payments" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Payments
            </Link>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center"><Wallet className="w-5 h-5 text-amber-400" /></div>
                <div>
                  <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
                  <h1 className="text-xl font-bold text-slate-900 dark:text-white">New Supplier Payment</h1>
                </div>
              </div>
              <ScanAndFillButton onExtracted={handleExtracted} label="Scan Document" />
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            <div className="flex-1 min-w-0 space-y-5">
              {scanBanner && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 text-sm flex items-center gap-2">
                  <Info className="h-4 w-4 flex-shrink-0" />{scanBanner}
                  <button type="button" onClick={() => setScanBanner(null)} className="ml-auto text-xs font-medium opacity-70 hover:opacity-100">Dismiss</button>
                </div>
              )}
              {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error}</div>}

              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                  Payment Details
                </h3>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className={lbl}>Supplier *</label>
                    <select name="supplierId" required value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))} className={inp}>
                      <option value="">Select supplier…</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Payment Date *</label>
                    <input type="date" name="paymentDate" required value={form.paymentDate} onChange={e => setForm(f => ({ ...f, paymentDate: e.target.value }))} className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Method</label>
                    <select name="paymentMethod" value={form.paymentMethod} onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))} className={inp}>
                      <option value="eft">EFT</option>
                      <option value="cheque">Cheque</option>
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className={lbl}>Reference</label>
                    <input type="text" name="reference" value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))} placeholder="Bank reference" className={inp} />
                  </div>
                </div>
              </div>

              <div className={`${card} p-5`}>
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                    Invoice Allocations
                  </h3>
                  <button type="button" onClick={addAllocation} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-semibold transition-colors">
                    <Plus className="h-3 w-3" /> Add Allocation
                  </button>
                </div>

                {invoices.length === 0 && form.supplierId && (
                  <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">No outstanding invoices for this supplier</p>
                )}

                <div className="space-y-3">
                  {allocations.map((alloc, idx) => {
                    const selectedInvoice = invoices.find(i => i.id === alloc.invoiceId);
                    return (
                      <div key={alloc.key} className="grid grid-cols-12 gap-2 items-end">
                        <div className="col-span-6">
                          {idx === 0 && <label className={lbl}>Invoice</label>}
                          <select name="invoiceId" value={alloc.invoiceId} onChange={e => updateAllocation(alloc.key, 'invoiceId', e.target.value)} className={inp}>
                            <option value="">Select invoice…</option>
                            {invoices.map(inv => <option key={inv.id} value={inv.id}>{inv.invoiceNumber} — Balance: {formatCurrency(inv.balance)}</option>)}
                          </select>
                        </div>
                        <div className="col-span-2">
                          {idx === 0 && <label className={lbl}>Balance</label>}
                          <div className={`${inp} bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400 text-right font-mono`}>{selectedInvoice ? formatCurrency(selectedInvoice.balance) : '—'}</div>
                        </div>
                        <div className="col-span-3">
                          {idx === 0 && <label className={lbl}>Pay Amount</label>}
                          <input type="number" step="0.01" min="0" max={selectedInvoice?.balance || undefined} value={alloc.amount || ''} onChange={e => updateAllocation(alloc.key, 'amount', Number(e.target.value))} className={`${inp} text-right`} />
                        </div>
                        <div className="col-span-1 flex justify-center">
                          {allocations.length > 1 && (
                            <button type="button" onClick={() => removeAllocation(alloc.key)} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-500 dark:text-slate-400 hover:text-red-500 transition-colors"><Trash2 className="h-4 w-4" /></button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="w-72 shrink-0">
              <div className="sticky top-6">
                <div className={`${card} p-5`}>
                  <div className="flex items-center gap-2 mb-5">
                    <Receipt className="w-4 h-4 text-amber-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Payment Summary</h3>
                  </div>
                  <div className="space-y-3">
                    {allocations.filter(a => a.invoiceId && a.amount > 0).map(a => {
                      const inv = invoices.find(i => i.id === a.invoiceId);
                      return inv ? (
                        <div key={a.key} className="flex justify-between text-sm">
                          <span className="text-slate-500 dark:text-slate-400 font-mono text-xs">{inv.invoiceNumber}</span>
                          <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrency(a.amount)}</span>
                        </div>
                      ) : null;
                    })}
                    <div className="h-px bg-slate-100 dark:bg-slate-800" />
                    <div className="flex justify-between">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
                      <span className="font-mono font-bold text-lg text-amber-500">{formatCurrency(totalAmount)}</span>
                    </div>
                  </div>
                  <button type="submit" disabled={isSubmitting || totalAmount <= 0} className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                    {isSubmitting ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><Wallet className="h-4 w-4" />Create Payment</>}
                  </button>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500 text-center px-2 mt-3">Payment will be recorded and allocated to the selected invoices.</p>
              </div>
            </div>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
