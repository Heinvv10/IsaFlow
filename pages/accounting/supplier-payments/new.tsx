/**
 * Create Supplier Payment Page
 * PRD-060 Phase 2: Payment with invoice allocation
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Wallet, Loader2, Plus, Trash2 } from 'lucide-react';

interface Supplier { id: number; name: string }
interface OutstandingInvoice {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  balance: number;
}

interface Allocation { key: string; invoiceId: string; amount: number }

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
}

export default function NewSupplierPaymentPage() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [invoices, setInvoices] = useState<OutstandingInvoice[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    supplierId: '',
    paymentDate: new Date().toISOString().split('T')[0],
    paymentMethod: 'eft',
    reference: '',
    description: '',
  });

  const [allocations, setAllocations] = useState<Allocation[]>([
    { key: crypto.randomUUID(), invoiceId: '', amount: 0 },
  ]);

  useEffect(() => {
    fetch('/api/suppliers').then(r => r.json()).then(res => {
      const data = res.data || res;
      setSuppliers(Array.isArray(data) ? data : data.suppliers || []);
    });
  }, []);

  // Load outstanding invoices for selected supplier
  useEffect(() => {
    if (!form.supplierId) { setInvoices([]); return; }
    fetch(`/api/accounting/supplier-invoices?supplier_id=${form.supplierId}&status=approved`)
      .then(r => r.json())
      .then(res => {
        const payload = res.data || res;
        const all = payload.invoices || [];
        setInvoices(all.filter((inv: OutstandingInvoice) => inv.balance > 0));
      });
  }, [form.supplierId]);

  const addAllocation = () => {
    setAllocations(prev => [...prev, { key: crypto.randomUUID(), invoiceId: '', amount: 0 }]);
  };

  const updateAllocation = (key: string, field: keyof Allocation, value: string | number) => {
    setAllocations(prev => prev.map(a => a.key === key ? { ...a, [field]: value } : a));
  };

  const removeAllocation = (key: string) => {
    if (allocations.length <= 1) return;
    setAllocations(prev => prev.filter(a => a.key !== key));
  };

  const totalAmount = allocations.reduce((sum, a) => sum + (a.amount || 0), 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/accounting/supplier-payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: Number(form.supplierId),
          paymentDate: form.paymentDate,
          totalAmount,
          paymentMethod: form.paymentMethod,
          reference: form.reference || undefined,
          description: form.description || undefined,
          allocations: allocations
            .filter(a => a.invoiceId && a.amount > 0)
            .map(a => ({ invoiceId: a.invoiceId, amount: a.amount })),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || 'Failed to create payment');
      }

      const json = await res.json();
      const payment = json.data || json;
      router.push(`/accounting/supplier-payments/${payment.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create payment');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/supplier-payments" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-emerald-600 mb-3">
            <ArrowLeft className="h-4 w-4" /> Back to Payments
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10">
              <Wallet className="h-6 w-6 text-emerald-500" />
            </div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Supplier Payment</h1>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6 max-w-4xl">
          {error && (
            <div className="p-3 bg-red-500/10 rounded-lg text-red-400 text-sm">{error}</div>
          )}

          {/* Payment Details */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
            <h3 className="text-lg font-semibold text-[var(--ff-text-primary)] mb-4">Payment Details</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Supplier *</label>
                <select required value={form.supplierId}
                  onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}
                  className="ff-select w-full">
                  <option value="">Select supplier...</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Payment Date *</label>
                <input type="date" required value={form.paymentDate}
                  onChange={e => setForm(f => ({ ...f, paymentDate: e.target.value }))}
                  className="ff-input w-full" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Method</label>
                <select value={form.paymentMethod}
                  onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))}
                  className="ff-select w-full">
                  <option value="eft">EFT</option>
                  <option value="cheque">Cheque</option>
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Reference</label>
                <input type="text" value={form.reference}
                  onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                  className="ff-input w-full" placeholder="Bank reference" />
              </div>
            </div>
          </div>

          {/* Allocations */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-[var(--ff-text-primary)]">Invoice Allocations</h3>
              <button type="button" onClick={addAllocation}
                className="inline-flex items-center gap-1 text-sm text-emerald-600 hover:text-emerald-700 font-medium">
                <Plus className="h-4 w-4" /> Add Allocation
              </button>
            </div>

            {invoices.length === 0 && form.supplierId && (
              <p className="text-sm text-[var(--ff-text-tertiary)] mb-4">No outstanding invoices for this supplier</p>
            )}

            <div className="space-y-3">
              {allocations.map((alloc, idx) => {
                const selectedInvoice = invoices.find(i => i.id === alloc.invoiceId);
                return (
                  <div key={alloc.key} className="grid grid-cols-12 gap-2 items-end">
                    <div className="col-span-6">
                      {idx === 0 && <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Invoice</label>}
                      <select value={alloc.invoiceId}
                        onChange={e => updateAllocation(alloc.key, 'invoiceId', e.target.value)}
                        className="ff-select w-full text-sm">
                        <option value="">Select invoice...</option>
                        {invoices.map(inv => (
                          <option key={inv.id} value={inv.id}>
                            {inv.invoiceNumber} — Balance: {formatCurrency(inv.balance)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      {idx === 0 && <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Balance</label>}
                      <div className="ff-input w-full text-sm text-right bg-[var(--ff-bg-tertiary)] font-mono">
                        {selectedInvoice ? formatCurrency(selectedInvoice.balance) : '-'}
                      </div>
                    </div>
                    <div className="col-span-3">
                      {idx === 0 && <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Pay Amount</label>}
                      <input type="number" step="0.01" min="0"
                        max={selectedInvoice?.balance || undefined}
                        value={alloc.amount || ''}
                        onChange={e => updateAllocation(alloc.key, 'amount', Number(e.target.value))}
                        className="ff-input w-full text-sm text-right" />
                    </div>
                    <div className="col-span-1 flex justify-center">
                      {allocations.length > 1 && (
                        <button type="button" onClick={() => removeAllocation(alloc.key)}
                          className="p-1 text-red-400 hover:text-red-300">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 pt-4 border-t border-[var(--ff-border-light)] flex justify-end">
              <div className="text-right">
                <p className="text-sm text-[var(--ff-text-secondary)]">Total Payment</p>
                <p className="text-2xl font-bold font-mono text-emerald-500">{formatCurrency(totalAmount)}</p>
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3">
            <Link href="/accounting/supplier-payments"
              className="px-4 py-2 border border-[var(--ff-border-medium)] rounded-lg text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium">
              Cancel
            </Link>
            <button type="submit" disabled={isSubmitting || totalAmount <= 0}
              className="inline-flex items-center gap-2 px-6 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium disabled:opacity-50">
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Payment
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
