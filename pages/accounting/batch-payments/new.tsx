/**
 * Create Batch Payment Page
 * Phase 1 Sage Alignment: Select suppliers and invoices for bulk payment
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, Layers, Plus, Trash2, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Supplier { id: string; company_name: string }
interface Invoice { id: string; invoice_number: string; total_amount: number; amount_paid: number; supplier_id: string }
interface BatchLine { key: string; supplierId: string; invoiceId: string; amount: number }

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

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
    });
    apiFetch('/api/accounting/supplier-invoices?status=approved&status=partially_paid', { credentials: 'include' }).then(r => r.json()).then(res => {
      const d = res.data || res;
      const list = Array.isArray(d) ? d : d.invoices || d.items || [];
      setInvoices(list.filter((inv: Invoice) => Number(inv.total_amount) - Number(inv.amount_paid) > 0.01));
    });
  }, []);

  const total = lines.reduce((s, l) => s + (l.amount || 0), 0);

  const addLine = () => setLines(p => [...p, { key: crypto.randomUUID(), supplierId: '', invoiceId: '', amount: 0 }]);
  const removeLine = (key: string) => setLines(p => p.filter(l => l.key !== key));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true);

    // Group by supplier
    const grouped: Record<string, { invoiceId: string; amount: number }[]> = {};
    for (const l of lines) {
      if (!l.supplierId || !l.invoiceId || l.amount <= 0) continue;
      if (!grouped[l.supplierId]) grouped[l.supplierId] = [];
      grouped[l.supplierId]!.push({ invoiceId: l.invoiceId, amount: l.amount });
    }

    const payments = Object.entries(grouped).map(([supplierId, allocs]) => ({
      supplierId,
      invoiceAllocations: allocs,
    }));

    if (payments.length === 0) { setError('Add at least one payment'); setBusy(false); return; }

    try {
      const res = await apiFetch('/api/accounting/batch-payments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ paymentMethod: method, notes: notes || undefined, payments }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      router.push('/accounting/batch-payments');
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/batch-payments" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Batches
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-500/10"><Layers className="h-6 w-6 text-indigo-500" /></div>
            <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Batch Payment</h1>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 max-w-5xl space-y-6">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Payment Settings</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Payment Method</label>
                <select value={method} onChange={e => setMethod(e.target.value)} className="ff-select w-full">
                  <option value="eft">EFT</option><option value="cheque">Cheque</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Notes</label>
                <input value={notes} onChange={e => setNotes(e.target.value)} className="ff-input w-full" placeholder="Optional batch notes" />
              </div>
            </div>
          </div>

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Invoices to Pay</h2>
              <button type="button" onClick={addLine} className="inline-flex items-center gap-1 text-sm text-indigo-500 hover:text-indigo-400">
                <Plus className="h-4 w-4" /> Add Line
              </button>
            </div>

            <div className="space-y-3">
              {lines.map(line => {
                const supplierInvoices = invoices.filter(i => !line.supplierId || String(i.supplier_id) === line.supplierId);
                const inv = invoices.find(i => i.id === line.invoiceId);
                const balance = inv ? Number(inv.total_amount) - Number(inv.amount_paid) : 0;
                return (
                  <div key={line.key} className="flex items-center gap-3">
                    <select value={line.supplierId} onChange={e => setLines(p => p.map(l => l.key === line.key ? { ...l, supplierId: e.target.value, invoiceId: '' } : l))} className="ff-select flex-1">
                      <option value="">Select Supplier</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.company_name}</option>)}
                    </select>
                    <select value={line.invoiceId} onChange={e => { const i = invoices.find(x => x.id === e.target.value); setLines(p => p.map(l => l.key === line.key ? { ...l, invoiceId: e.target.value, amount: i ? Number(i.total_amount) - Number(i.amount_paid) : 0 } : l)); }} className="ff-select flex-1">
                      <option value="">Select Invoice</option>
                      {supplierInvoices.map(i => <option key={i.id} value={i.id}>{i.invoice_number} — {fmt(Number(i.total_amount) - Number(i.amount_paid))}</option>)}
                    </select>
                    <input type="number" step="0.01" min="0" max={balance || undefined} value={line.amount || ''} onChange={e => setLines(p => p.map(l => l.key === line.key ? { ...l, amount: Number(e.target.value) } : l))} className="ff-input w-36" placeholder="Amount" />
                    {lines.length > 1 && <button type="button" onClick={() => removeLine(line.key)} className="p-2 text-red-400 hover:text-red-300"><Trash2 className="h-4 w-4" /></button>}
                  </div>
                );
              })}
            </div>

            <div className="pt-3 border-t border-[var(--ff-border-light)] flex justify-between">
              <span className="text-sm font-medium text-[var(--ff-text-secondary)]">Batch Total</span>
              <span className="text-lg font-bold text-[var(--ff-text-primary)]">{fmt(total)}</span>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Link href="/accounting/batch-payments" className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</Link>
            <button type="submit" disabled={busy || total <= 0} className="inline-flex items-center gap-2 px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 text-sm font-medium">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create Batch
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
