/**
 * Create Credit Note Page
 * PRD-060 Phase 3: Customer & Supplier credit notes
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2 } from 'lucide-react';

import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface Client { id: string; company_name: string }
interface Supplier { id: number; name: string }

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
    });
    apiFetch('/api/accounting/suppliers-list').then(r => r.json()).then(res => {
      const data = res.data || res;
      setSuppliers(Array.isArray(data) ? data : data.suppliers || []);
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

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
      if (!res.ok) throw new Error(json.message || json.error || 'Failed to create credit note');
      router.push('/accounting/credit-notes');
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
            <Link href="/accounting/credit-notes" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
              <ArrowLeft className="h-4 w-4" /> Back to Credit Notes
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <FileText className="h-6 w-6 text-teal-500" />
              </div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Credit Note</h1>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 max-w-3xl space-y-6">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Credit Note Details</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Type *</label>
                <select
                  value={form.type}
                  onChange={e => setForm(f => ({ ...f, type: e.target.value as 'customer' | 'supplier', clientId: '', supplierId: '' }))}
                  className="ff-select w-full"
                >
                  <option value="customer">Customer Credit Note</option>
                  <option value="supplier">Supplier Credit Note</option>
                </select>
              </div>

              {form.type === 'customer' ? (
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
              ) : (
                <div>
                  <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Supplier *</label>
                  <select
                    value={form.supplierId}
                    onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}
                    className="ff-select w-full"
                    required
                  >
                    <option value="">Select supplier...</option>
                    {suppliers.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Credit Date *</label>
                <input
                  type="date"
                  value={form.creditDate}
                  onChange={e => setForm(f => ({ ...f, creditDate: e.target.value }))}
                  className="ff-input w-full"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Reason</label>
                <input
                  type="text"
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  className="ff-input w-full"
                  placeholder="Reason for credit note"
                />
              </div>
            </div>
          </div>

          {/* Amounts */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
            <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">Amounts</h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">Subtotal (excl. VAT) *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.subtotal || ''}
                  onChange={e => setForm(f => ({ ...f, subtotal: Number(e.target.value) }))}
                  className="ff-input w-full"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">VAT Rate (%)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.taxRate}
                  onChange={e => setForm(f => ({ ...f, taxRate: Number(e.target.value) }))}
                  className="ff-input w-full"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--ff-text-secondary)] mb-1">VAT Amount</label>
                <div className="ff-input w-full bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">
                  {formatCurrency(taxAmount)}
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-[var(--ff-border-light)] flex justify-between items-center">
              <span className="text-sm font-medium text-[var(--ff-text-secondary)]">Total Amount</span>
              <span className="text-xl font-bold text-[var(--ff-text-primary)]">{formatCurrency(totalAmount)}</span>
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3">
            <Link href="/accounting/credit-notes" className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
              Cancel
            </Link>
            <button
              type="submit"
              disabled={isSubmitting || form.subtotal <= 0}
              className="inline-flex items-center gap-2 px-6 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:opacity-50 transition-colors text-sm font-medium"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Credit Note
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
