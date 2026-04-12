/**
 * New Supplier Credit Note Page
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2, Plus, Trash2 } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface Supplier { id: string | number; name: string; company_name?: string | null }

const VAT_TYPES = [
  { value: 'standard', label: 'Standard (15%)' },
  { value: 'zero', label: 'Zero Rated (0%)' },
  { value: 'exempt', label: 'Exempt' },
];

interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  vatType: string;
}

const emptyLine = (): LineItem => ({
  description: '',
  quantity: 1,
  unitPrice: 0,
  vatType: 'standard',
});

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
      .catch(() => { /* suppliers list failure is non-fatal */ });
  }, []);

  const subtotal = lineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0);
  const vatAmount = lineItems.reduce((s, li) => {
    const amt = li.quantity * li.unitPrice;
    return s + (li.vatType === 'standard' ? Math.round(amt * 0.15 * 100) / 100 : 0);
  }, 0);
  const total = subtotal + vatAmount;

  const updateLine = (idx: number, patch: Partial<LineItem>) => {
    setLineItems(prev => prev.map((li, i) => i === idx ? { ...li, ...patch } : li));
  };

  const removeLine = (idx: number) => {
    if (lineItems.length === 1) return;
    setLineItems(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e: React.FormEvent) => {
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
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link
              href="/accounting/supplier-credit-notes"
              className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Supplier Credit Notes
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10">
                <FileText className="h-6 w-6 text-orange-500" />
              </div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Supplier Credit Note</h1>
            </div>
          </div>
        </div>

        <form onSubmit={e => { void handleSubmit(e); }} className="p-6 max-w-4xl space-y-6">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          {/* Header details */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Credit Note Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Supplier *</label>
                <select
                  name="supplierId"
                  value={form.supplierId}
                  onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}
                  className="ff-select w-full"
                  required
                >
                  <option value="">Select supplier...</option>
                  {suppliers.map(s => (
                    <option key={String(s.id)} value={String(s.id)}>
                      {s.company_name ?? s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Credit Note Date *</label>
                <input
                  type="date"
                  name="creditDate"
                  value={form.creditDate}
                  onChange={e => setForm(f => ({ ...f, creditDate: e.target.value }))}
                  className="ff-input w-full"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Reference Number</label>
                <input
                  type="text"
                  name="reference"
                  value={form.reference}
                  onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                  className="ff-input w-full"
                  placeholder="Auto-generated if blank"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Description</label>
                <input
                  type="text"
                  name="description"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  className="ff-input w-full"
                  placeholder="Reason for credit note"
                />
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Line Items</h2>
              <button
                type="button"
                onClick={() => setLineItems(prev => [...prev, emptyLine()])}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-primary)]"
              >
                <Plus className="h-3.5 w-3.5" /> Add Line
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left pb-2 text-[var(--ff-text-secondary)] font-medium w-5/12">Description</th>
                    <th className="text-right pb-2 text-[var(--ff-text-secondary)] font-medium w-1/12">Qty</th>
                    <th className="text-right pb-2 text-[var(--ff-text-secondary)] font-medium w-2/12">Unit Price</th>
                    <th className="text-left pb-2 text-[var(--ff-text-secondary)] font-medium w-2/12 px-2">VAT Type</th>
                    <th className="text-right pb-2 text-[var(--ff-text-secondary)] font-medium w-2/12">Total</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {lineItems.map((li, idx) => (
                    <tr key={idx}>
                      <td className="py-2 pr-2">
                        <input
                          type="text"
                          value={li.description}
                          onChange={e => updateLine(idx, { description: e.target.value })}
                          className="ff-input w-full text-sm"
                          placeholder="Item description"
                          required
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          type="number"
                          min="0.001"
                          step="0.001"
                          value={li.quantity}
                          onChange={e => updateLine(idx, { quantity: Number(e.target.value) })}
                          className="ff-input w-full text-sm text-right"
                        />
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={li.unitPrice}
                          onChange={e => updateLine(idx, { unitPrice: Number(e.target.value) })}
                          className="ff-input w-full text-sm text-right"
                        />
                      </td>
                      <td className="py-2 px-2">
                        <select
                          name="vatType" value={li.vatType}
                          onChange={e => updateLine(idx, { vatType: e.target.value })}
                          className="ff-select w-full text-sm"
                        >
                          {VAT_TYPES.map(v => <option key={v.value} value={v.value}>{v.label}</option>)}
                        </select>
                      </td>
                      <td className="py-2 text-right font-mono text-[var(--ff-text-primary)]">
                        {formatCurrency(li.quantity * li.unitPrice)}
                      </td>
                      <td className="py-2 pl-2">
                        <button
                          type="button"
                          onClick={() => removeLine(idx)}
                          disabled={lineItems.length === 1}
                          className="p-1 text-[var(--ff-text-tertiary)] hover:text-red-400 disabled:opacity-30"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="pt-4 border-t border-[var(--ff-border-light)] space-y-1.5 flex flex-col items-end">
              <div className="flex gap-12 text-sm">
                <span className="text-[var(--ff-text-secondary)]">Subtotal (excl. VAT)</span>
                <span className="font-mono text-[var(--ff-text-primary)] w-28 text-right">{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex gap-12 text-sm">
                <span className="text-[var(--ff-text-secondary)]">VAT (15%)</span>
                <span className="font-mono text-[var(--ff-text-primary)] w-28 text-right">{formatCurrency(vatAmount)}</span>
              </div>
              <div className="flex gap-12 text-base font-semibold pt-1 border-t border-[var(--ff-border-light)]">
                <span className="text-[var(--ff-text-primary)]">Total</span>
                <span className="font-mono text-orange-400 w-28 text-right">{formatCurrency(total)}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6">
            <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-2">Notes</label>
            <textarea
              name="notes"
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="ff-input w-full h-24 resize-none"
              placeholder="Internal notes (optional)"
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <Link
              href="/accounting/supplier-credit-notes"
              className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]"
            >
              Cancel
            </Link>
            <button
              type="submit"
              onClick={() => setSubmitAction('draft')}
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 px-5 py-2 border border-orange-600 text-orange-400 rounded-lg hover:bg-orange-600/10 disabled:opacity-50 transition-colors text-sm font-medium"
            >
              {isSubmitting && submitAction === 'draft' && <Loader2 className="h-4 w-4 animate-spin" />}
              Save as Draft
            </button>
            <button
              type="submit"
              onClick={() => setSubmitAction('post')}
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 px-5 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 transition-colors text-sm font-medium"
            >
              {isSubmitting && submitAction === 'post' && <Loader2 className="h-4 w-4 animate-spin" />}
              Post
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
