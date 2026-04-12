/**
 * Create Customer Payment Page — redesigned with elevated design system
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, CreditCard, Loader2, Plus, Trash2, Info, Receipt } from 'lucide-react';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { fuzzyMatchClient } from '@/modules/accounting/utils/fuzzyMatch';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { apiFetch } from '@/lib/apiFetch';

interface Client { id: string; name: string }
interface OutstandingInvoice {
  id: string; invoice_number: string; total_amount: number; amount_paid: number;
}
interface Allocation { key: string; invoiceId: string; amount: number }

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';
const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function NewCustomerPaymentPage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<OutstandingInvoice[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [scanBanner, setScanBanner] = useState<string | null>(null);
  const [queryParamsApplied, setQueryParamsApplied] = useState(false);

  const [form, setForm] = useState({
    clientId: '',
    paymentDate: new Date().toISOString().split('T')[0],
    paymentMethod: 'eft',
    bankReference: '',
    description: '',
  });

  const [allocations, setAllocations] = useState<Allocation[]>([
    { key: crypto.randomUUID(), invoiceId: '', amount: 0 },
  ]);

  // Pre-populate from URL query params (e.g. navigating from invoice detail page)
  useEffect(() => {
    if (!router.isReady || queryParamsApplied) return;
    const { clientId, invoiceId, amount } = router.query;
    if (clientId && typeof clientId === 'string') {
      setForm(f => ({ ...f, clientId }));
    }
    if (invoiceId && typeof invoiceId === 'string') {
      const parsedAmount = amount && typeof amount === 'string' ? parseFloat(amount) : 0;
      setAllocations([{ key: crypto.randomUUID(), invoiceId, amount: parsedAmount }]);
    }
    setQueryParamsApplied(true);
  }, [router.isReady, router.query, queryParamsApplied]);

  useEffect(() => {
    apiFetch('/api/accounting/customers').then(r => r.json()).then(res => {
      const data = res.data || res;
      setClients(Array.isArray(data) ? data : data.clients || []);
    }).catch(() => setError('Failed to load clients'));
  }, []);

  useEffect(() => {
    if (!form.clientId) { setInvoices([]); return; }
    apiFetch(`/api/accounting/customer-invoices-list?client_id=${form.clientId}&status=approved&status=sent&status=partially_paid&status=overdue&limit=200`)
      .then(r => r.json())
      .then(res => {
        const data = res.data || res;
        const list = Array.isArray(data) ? data : data.invoices || [];
        setInvoices(list.filter((inv: OutstandingInvoice) =>
          Number(inv.total_amount) - Number(inv.amount_paid) > 0.01
        ));
      })
      .catch(() => setInvoices([]));
  }, [form.clientId]);

  const totalAllocated = allocations.reduce((s, a) => s + (a.amount || 0), 0);

  const addAllocation = () => {
    setAllocations(prev => [...prev, { key: crypto.randomUUID(), invoiceId: '', amount: 0 }]);
  };

  const removeAllocation = (key: string) => {
    setAllocations(prev => prev.filter(a => a.key !== key));
  };

  const updateAllocation = (key: string, field: 'invoiceId' | 'amount', value: string | number) => {
    setAllocations(prev => prev.map(a => a.key === key ? { ...a, [field]: value } : a));
  };

  function handleExtracted(data: ExtractedDocument) {
    if (data.date) setForm(f => ({ ...f, paymentDate: data.date! }));
    if (data.referenceNumber) setForm(f => ({ ...f, bankReference: data.referenceNumber! }));
    if (data.customerName && clients.length > 0) {
      const match = fuzzyMatchClient(data.customerName, clients);
      if (match) setForm(f => ({ ...f, clientId: String(match.id) }));
    }
    if (data.totalAmount && invoices.length > 0) {
      const exactMatch = invoices.find(inv =>
        Math.abs((Number(inv.total_amount) - Number(inv.amount_paid)) - data.totalAmount!) < 0.02
      );
      if (exactMatch) {
        setAllocations([{ key: crypto.randomUUID(), invoiceId: exactMatch.id, amount: data.totalAmount }]);
      }
    }
    setScanBanner(`Auto-filled from document (${Math.round(data.confidence * 100)}% confidence). Review all fields.`);
  }

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/customer-payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          clientId: form.clientId,
          paymentDate: form.paymentDate,
          totalAmount: totalAllocated,
          paymentMethod: form.paymentMethod,
          bankReference: form.bankReference || undefined,
          description: form.description || undefined,
          allocations: allocations
            .filter(a => a.invoiceId && a.amount > 0)
            .map(a => ({ invoiceId: a.invoiceId, amount: a.amount })),
        }),
      });
      const json = await res.json() as { error?: { message?: string } };
      if (!res.ok) throw new Error(json?.error?.message || 'Failed to create payment');
      await router.push('/accounting/customer-payments');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create payment');
    } finally { setIsSubmitting(false); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/customer-payments" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Payments
            </Link>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
                <h1 className="text-xl font-bold text-white">Record Customer Payment</h1>
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
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Client *</label>
                    <select name="clientId" value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} className={inp} required>
                      <option value="">Select client…</option>
                      {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Payment Date *</label>
                    <input type="date" name="paymentDate" value={form.paymentDate} onChange={e => setForm(f => ({ ...f, paymentDate: e.target.value }))} className={inp} required />
                  </div>
                  <div>
                    <label className={lbl}>Payment Method</label>
                    <select name="paymentMethod" value={form.paymentMethod} onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))} className={inp}>
                      <option value="eft">EFT</option>
                      <option value="cheque">Cheque</option>
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Bank Reference</label>
                    <input type="text" name="bankReference" value={form.bankReference} onChange={e => setForm(f => ({ ...f, bankReference: e.target.value }))} placeholder="e.g. REF123456" className={inp} />
                  </div>
                </div>
                <div className="mt-4">
                  <label className={lbl}>Description</label>
                  <input type="text" name="description" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional payment description" className={inp} />
                </div>
              </div>

              <div className={`${card} overflow-hidden`}>
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                    Invoice Allocations
                  </h3>
                  <button type="button" onClick={addAllocation} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-white font-semibold transition-colors"><Plus className="h-3 w-3" />Add Line</button>
                </div>
                <div className="p-5 space-y-3">
                  {!form.clientId && <p className="text-sm text-slate-400 dark:text-slate-500 text-center py-4">Select a client to see outstanding invoices</p>}
                  {form.clientId && invoices.length === 0 && <p className="text-sm text-slate-400 dark:text-slate-500">No outstanding invoices for this client</p>}
                  {allocations.map(alloc => {
                    const inv = invoices.find(i => i.id === alloc.invoiceId);
                    const balance = inv ? Number(inv.total_amount) - Number(inv.amount_paid) : 0;
                    return (
                      <div key={alloc.key} className="flex items-center gap-3">
                        <select name="invoiceId" value={alloc.invoiceId} onChange={e => updateAllocation(alloc.key, 'invoiceId', e.target.value)} className={`${inp} flex-1`}>
                          <option value="">Select invoice…</option>
                          {invoices.map(i => (
                            <option key={i.id} value={i.id}>{i.invoice_number} — Balance: {fmt(Number(i.total_amount) - Number(i.amount_paid))}</option>
                          ))}
                        </select>
                        <input type="number" name="amount" step="0.01" min="0" max={balance || undefined} value={alloc.amount || ''} onChange={e => updateAllocation(alloc.key, 'amount', Number(e.target.value))} placeholder="Amount" className={`${inp} w-36`} />
                        {allocations.length > 1 && (
                          <button type="button" onClick={() => removeAllocation(alloc.key)} className="p-1.5 rounded-lg text-slate-300 dark:text-slate-700 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"><Trash2 className="h-4 w-4" /></button>
                        )}
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
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Allocations</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{allocations.filter(a => a.invoiceId && a.amount > 0).length}</span>
                    </div>
                    <div className="h-px bg-slate-100 dark:bg-slate-800" />
                    <div className="flex justify-between">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
                      <span className="font-mono font-bold text-lg text-amber-500">{fmt(totalAllocated)}</span>
                    </div>
                  </div>
                  <button type="submit" disabled={isSubmitting || totalAllocated <= 0} className="w-full mt-6 py-3 bg-amber-500 hover:bg-amber-400 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                    {isSubmitting ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><CreditCard className="h-4 w-4" />Create Payment</>}
                  </button>
                  <Link href="/accounting/customer-payments" className="block w-full mt-2 py-2.5 text-center text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors">Cancel</Link>
                </div>
                <p className="text-xs text-slate-400 dark:text-slate-500 text-center px-2 mt-3">Payment will be recorded and allocations applied to the selected invoices.</p>
              </div>
            </div>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
