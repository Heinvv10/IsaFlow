/**
 * Supplier Payment Allocation
 * Sage Parity: Transactions > Allocate Payments
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowLeftRight, Loader2, AlertCircle, Check } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import { fetchAllPayments, fetchSupplierOpenBills } from '@/components/accounting/allocations/openInvoiceFetch';
import { supplierOpenRows, type OpenInvoiceRow } from '@/components/accounting/allocations/openInvoiceRows';
import { AmountInput } from '@/components/ui/AmountInput';
import { blockOnInvalidAmount } from '@/components/ui/amountInputText';

const fmt = (n: number) => formatMoney(n);

interface Payment { id: string; paymentNumber: string; supplierName: string; supplierId: string; date: string; amount: number; allocatedAmount: number; }
type Invoice = OpenInvoiceRow;

export default function SupplierAllocationsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selected, setSelected] = useState<Payment | null>(null);
  const [allocs, setAllocs] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadingInv, setLoadingInv] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [paymentCut, setPaymentCut] = useState<{ shown: number; total: number } | null>(null);
  const loadSeq = useRef(0); // the latest invoice load wins; an older one that finishes later is ignored
  const [cutOff, setCutOff] = useState<{ shown: number; total: number } | null>(null);
  const invoicesRef = useRef<HTMLDivElement>(null);

  const loadPayments = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const all = await fetchAllPayments('supplier', 'Could not load the unallocated payments - try again');
      setPaymentCut(all.truncated ? { shown: all.rows.length, total: all.total } : null);
      // API mapper returns `totalAmount` / `paymentDate`; `?unallocated=true` is not honoured server-side, so filter here.
      const mapped: Payment[] = all.rows.map(p => ({
        id: String(p.id), paymentNumber: String(p.paymentNumber ?? ''), supplierName: String(p.supplierName ?? ''), supplierId: String(p.supplierId ?? ''),
        date: String(p.paymentDate ?? p.date ?? ''),
        amount: Number(p.totalAmount ?? p.amount ?? 0),
        allocatedAmount: Number(p.allocatedAmount ?? 0),
      }));
      setPayments(mapped.filter(p => (p.amount - p.allocatedAmount) > 0.01));
    } catch (err: unknown) {
      setPayments([]);
      setError(apiErrorMessage(err, 'Could not load the unallocated payments - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadPayments(); }, [loadPayments]);

  const selectPayment = async (p: Payment) => {
    setSelected(p); setAllocs({}); setMsg(''); setCutOff(null); setLoadingInv(true);
    const seq = ++loadSeq.current;
    try {
      const all = await fetchSupplierOpenBills(p.supplierId);
      if (seq !== loadSeq.current) return;
      setInvoices(supplierOpenRows(all.rows));
      setCutOff(all.truncated ? { shown: all.rows.length, total: all.total } : null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setInvoices([]);
      setError(apiErrorMessage(err, 'Could not load the supplier invoices - try again'));
    } finally {
      if (seq === loadSeq.current) setLoadingInv(false);
    }
  };

  const toggleAlloc = (inv: Invoice) => {
    setAllocs(prev => {
      const next = { ...prev };
      if (next[inv.id] !== undefined) { delete next[inv.id]; } else { next[inv.id] = inv.outstanding; }
      return next;
    });
  };

  const totalAlloc = Object.values(allocs).reduce((s, a) => s + a, 0);
  const unallocTotal = payments.reduce((s, p) => s + (p.amount - p.allocatedAmount), 0);

  const doAllocate = async () => {
    if (blockOnInvalidAmount(invoicesRef.current)) return;
    if (!selected || totalAlloc <= 0) return;
    setSaving(true); setMsg(''); setError('');
    const allocations = Object.entries(allocs).filter(([, a]) => a > 0).map(([invoiceId, amount]) => ({ invoiceId, amount }));
    try {
      const res = await apiFetch('/api/accounting/supplier-allocations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ paymentId: selected.id, allocations }),
      });
      await assertOk(res, 'Could not allocate the payment - try again');
      ++loadSeq.current; setLoadingInv(false); // an invoice load still in flight predates this allocation: drop it, and its finally no longer clears the spinner
      setMsg('Allocated successfully'); setSelected(null); setAllocs({});
      await loadPayments();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not allocate the payment - try again'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-orange-500/10"><ArrowLeftRight className="h-6 w-6 text-orange-500" /></div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Allocate Payments</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Match supplier payments to outstanding invoices</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}
          {!loading && payments.length > 0 && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)] uppercase">Total Unallocated</p>
              <p className="text-xl font-bold text-amber-400 tabular-nums">{fmt(unallocTotal)}</p>
              <p className="text-xs text-[var(--ff-text-tertiary)]">{payments.length} payment(s)</p>
            </div>
          )}
          {msg && <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm"><Check className="h-4 w-4" />{msg}</div>}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Unallocated Payments */}
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--ff-border-light)] text-sm font-medium text-[var(--ff-text-secondary)]">Unallocated Payments</div>
              {paymentCut && <div role="status" className="px-4 py-2 text-xs text-amber-400 border-b border-[var(--ff-border-light)]">Showing {paymentCut.shown} of {paymentCut.total} payments. The rest are not listed here.</div>}
              {loading ? (
                <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
              ) : payments.length === 0 ? (
                <div className="p-8 text-center text-[var(--ff-text-tertiary)]">All payments allocated</div>
              ) : (
                <div className="divide-y divide-[var(--ff-border-light)] max-h-[60vh] overflow-y-auto">
                  {payments.map(p => (
                    <button key={p.id} onClick={() => selectPayment(p)}
                      className={`w-full text-left px-4 py-3 hover:bg-[var(--ff-bg-tertiary)] transition-colors ${selected?.id === p.id ? 'bg-orange-500/10 border-l-2 border-orange-500' : ''}`}>
                      <div className="flex justify-between">
                        <span className="text-sm font-medium text-[var(--ff-text-primary)]">{p.paymentNumber}</span>
                        <span className="text-sm tabular-nums text-amber-400">{fmt(p.amount - p.allocatedAmount)}</span>
                      </div>
                      <div className="text-xs text-[var(--ff-text-tertiary)]">{p.supplierName} &middot; {formatDisplayDate(p.date)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Outstanding Invoices */}
            <div ref={invoicesRef} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--ff-border-light)] text-sm font-medium text-[var(--ff-text-secondary)]">
                {selected ? `Invoices for ${selected.supplierName}` : 'Select a payment'}
              </div>
              {!selected ? (
                <div className="p-8 text-center text-[var(--ff-text-tertiary)]"><AlertCircle className="h-6 w-6 mx-auto mb-2" />Select a payment to allocate</div>
              ) : loadingInv ? (
                <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
              ) : invoices.length === 0 ? (
                <div className="p-8 text-center text-[var(--ff-text-tertiary)]">No outstanding invoices</div>
              ) : (
                <>
                  {cutOff && <div role="alert" className="px-4 py-2 text-xs text-amber-400 border-b border-[var(--ff-border-light)]">Showing {cutOff.shown} of {cutOff.total} invoices. The rest are not listed here: narrow it down in the invoice list.</div>}
                  <div className="divide-y divide-[var(--ff-border-light)] max-h-[50vh] overflow-y-auto">
                    {invoices.map(inv => (
                      <label key={inv.id} className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--ff-bg-tertiary)] cursor-pointer">
                        <input type="checkbox" checked={allocs[inv.id] !== undefined} onChange={() => toggleAlloc(inv)}
                          className="rounded border-[var(--ff-border-light)]" />
                        <div className="flex-1">
                          <div className="flex justify-between">
                            <span className="text-sm text-[var(--ff-text-primary)]">{inv.invoiceNumber}</span>
                            <span className="text-sm tabular-nums text-[var(--ff-text-primary)]">{fmt(inv.outstanding)}</span>
                          </div>
                          <p className="text-xs text-[var(--ff-text-tertiary)]">{formatDisplayDate(inv.date)} &middot; Total: {fmt(inv.total)}</p>
                        </div>
                        {allocs[inv.id] !== undefined && (
                          <AmountInput value={allocs[inv.id] ?? 0} min={0} max={inv.outstanding} aria-label={`Allocate to ${inv.invoiceNumber}`}
                            onValueChange={n => setAllocs(prev => ({ ...prev, [inv.id]: n }))}
                            onClick={e => e.stopPropagation()}
                            className="w-28 px-2 py-1 text-right bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] rounded text-sm tabular-nums text-[var(--ff-text-primary)]" />
                        )}
                      </label>
                    ))}
                  </div>
                  {totalAlloc > 0 && (
                    <div className="px-4 py-3 border-t border-[var(--ff-border-light)] flex items-center justify-between">
                      <span className="text-sm text-[var(--ff-text-secondary)]">Allocating: <strong className="text-[var(--ff-text-primary)]">{fmt(totalAlloc)}</strong></span>
                      <button onClick={doAllocate} disabled={saving}
                        className="flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-sm font-medium">
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Allocate
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
