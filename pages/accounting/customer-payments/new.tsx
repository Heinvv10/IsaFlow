/**
 * Create Customer Payment Page
 * PRD-060 Phase 3: Payment with invoice allocation
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Wallet, Loader2, Plus, Trash2, Info } from 'lucide-react';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { fuzzyMatchClient } from '@/modules/accounting/utils/fuzzyMatch';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

interface Client { id: string; company_name: string }
interface OutstandingInvoice {
  id: string;
  invoice_number: string;
  total_amount: number;
  amount_paid: number;
}

import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface Allocation { key: string; invoiceId: string; amount: number }

export default function NewCustomerPaymentPage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<OutstandingInvoice[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [scanBanner, setScanBanner] = useState<string | null>(null);

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

  useEffect(() => {
    apiFetch('/api/accounting/customers').then(r => r.json()).then(res => {
      const data = res.data || res;
      setClients(Array.isArray(data) ? data : data.clients || []);
    });
  }, []);

  // Load outstanding invoices when client changes
  useEffect(() => {
    if (!form.clientId) { setInvoices([]); return; }
    apiFetch(`/api/customer-invoices?client_id=${form.clientId}&status=approved&status=sent&status=partially_paid&status=overdue`)
      .then(r => r.json())
      .then(res => {
        const data = res.data || res;
        const list = Array.isArray(data) ? data : data.invoices || [];
        setInvoices(list.filter((inv: OutstandingInvoice) =>
          Number(inv.total_amount) - Number(inv.amount_paid) > 0.01
        ));
      });
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

  const handleSubmit = async (e: React.FormEvent) => {
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

      const json = await res.json();
      if (!res.ok) throw new Error(json.message || json.error || 'Failed to create payment');
      router.push('/accounting/customer-payments');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create payment');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link href="/accounting/customer-payments" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
              <ArrowLeft className="h-4 w-4" /> Back to Payments
            </Link>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-teal-500/10">
                  <Wallet className="h-6 w-6 text-teal-500" />
                </div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Record Customer Payment</h1>
              </div>
              <ScanAndFillButton onExtracted={handleExtracted} label="Scan Document" />
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 max-w-4xl space-y-6">
          {scanBanner && (
            <div className="p-3 bg-teal-500/10 rounded-lg text-teal-400 text-sm flex items-center gap-2">
              <Info className="h-4 w-4 flex-shrink-0" />{scanBanner}
              <button type="button" onClick={() => setScanBanner(null)} className="ml-auto text-teal-500 hover:text-teal-300 text-xs">Dismiss</button>
            </div>
          )}
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          {/* Payment Details */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Payment Details</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Client *</label>
                <select
                  value={form.clientId}
                  onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
                  className="ff-select w-full"
                  required
                >
                  <option value="">Select client...</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Payment Date *</label>
                <input
                  type="date"
                  value={form.paymentDate}
                  onChange={e => setForm(f => ({ ...f, paymentDate: e.target.value }))}
                  className="ff-input w-full"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Payment Method</label>
                <select
                  value={form.paymentMethod}
                  onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))}
                  className="ff-select w-full"
                >
                  <option value="eft">EFT</option>
                  <option value="cheque">Cheque</option>
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Bank Reference</label>
                <input
                  type="text"
                  value={form.bankReference}
                  onChange={e => setForm(f => ({ ...f, bankReference: e.target.value }))}
                  className="ff-input w-full"
                  placeholder="e.g. REF123456"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Description</label>
              <input
                type="text"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="ff-input w-full"
                placeholder="Optional payment description"
              />
            </div>
          </div>

          {/* Invoice Allocations */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Invoice Allocations</h2>
              <button
                type="button"
                onClick={addAllocation}
                className="inline-flex items-center gap-1 text-sm text-teal-500 hover:text-teal-400"
              >
                <Plus className="h-4 w-4" /> Add Line
              </button>
            </div>

            {invoices.length === 0 && form.clientId && (
              <p className="text-sm text-[var(--ff-text-tertiary)]">No outstanding invoices for this client</p>
            )}

            <div className="space-y-3">
              {allocations.map(alloc => {
                const inv = invoices.find(i => i.id === alloc.invoiceId);
                const balance = inv ? Number(inv.total_amount) - Number(inv.amount_paid) : 0;
                return (
                  <div key={alloc.key} className="flex items-center gap-3">
                    <select
                      value={alloc.invoiceId}
                      onChange={e => updateAllocation(alloc.key, 'invoiceId', e.target.value)}
                      className="ff-select flex-1"
                    >
                      <option value="">Select invoice...</option>
                      {invoices.map(inv => (
                        <option key={inv.id} value={inv.id}>
                          {inv.invoice_number} — Balance: {formatCurrency(Number(inv.total_amount) - Number(inv.amount_paid))}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max={balance || undefined}
                      value={alloc.amount || ''}
                      onChange={e => updateAllocation(alloc.key, 'amount', Number(e.target.value))}
                      className="ff-input w-40"
                      placeholder="Amount"
                    />
                    {allocations.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeAllocation(alloc.key)}
                        className="p-2 text-red-400 hover:text-red-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="pt-3 border-t border-[var(--ff-border-light)] flex justify-between">
              <span className="text-sm font-medium text-[var(--ff-text-secondary)]">Total Allocated</span>
              <span className="text-lg font-bold text-[var(--ff-text-primary)]">{formatCurrency(totalAllocated)}</span>
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3">
            <Link href="/accounting/customer-payments" className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
              Cancel
            </Link>
            <button
              type="submit"
              disabled={isSubmitting || totalAllocated <= 0}
              className="inline-flex items-center gap-2 px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 transition-colors text-sm font-medium"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Payment
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
