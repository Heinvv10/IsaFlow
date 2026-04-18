/**
 * New Supplier Return Page
 * Route: /accounting/supplier-returns/new
 * Creates a debit note / return to supplier via the supplier-credit-notes endpoint.
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, TrendingDown, Loader2, Receipt } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';

interface Supplier { id: number; name: string }

const inp = 'w-full px-3 py-2 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-[var(--ff-text-tertiary)] uppercase tracking-wider mb-1.5';

export default function NewSupplierReturnPage() {
  const router = useRouter();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const [form, setForm] = useState({
    supplierId: '',
    originalInvoiceNumber: '',
    returnDate: new Date().toISOString().split('T')[0] ?? '',
    amount: '',
    reason: '',
  });

  const amount = Number(form.amount) || 0;

  useEffect(() => {
    apiFetch('/api/accounting/suppliers-list')
      .then(r => r.json())
      .then(res => {
        const data = res.data || res;
        const list: Array<Record<string, unknown>> = Array.isArray(data) ? data : (data.suppliers ?? []);
        setSuppliers(list.map(s => ({ id: s.id as number, name: (s.company_name ?? s.name) as string })));
      })
      .catch(() => setError('Failed to load suppliers'));
  }, []);

  function setField(field: keyof typeof form, value: string) {
    setForm(f => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.supplierId) { notify.error('Please select a supplier'); return; }
    if (amount <= 0) { notify.error('Please enter a valid amount'); return; }
    setError('');
    setIsSubmitting(true);
    try {
      const res = await apiFetch('/api/accounting/supplier-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId: Number(form.supplierId),
          originalInvoiceNumber: form.originalInvoiceNumber || undefined,
          amount,
          reason: form.reason || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? 'Failed to create return');
      notify.success('Supplier return created');
      router.push('/accounting/supplier-returns');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create return');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link
            href="/accounting/supplier-returns"
            className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-teal-400 mb-3"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Supplier Returns
          </Link>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10">
              <TrendingDown className="h-6 w-6 text-amber-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Supplier Return</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Debit note / return to supplier</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-2xl">
          {error && (
            <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Return Details</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="md:col-span-2">
                  <label className={lbl}>Supplier *</label>
                  <select
                    required
                    className={inp}
                    value={form.supplierId}
                    onChange={e => setField('supplierId', e.target.value)}
                  >
                    <option value="">Select supplier...</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={lbl}>Original Invoice #</label>
                  <input
                    type="text"
                    className={inp}
                    placeholder="e.g. INV-00123"
                    value={form.originalInvoiceNumber}
                    onChange={e => setField('originalInvoiceNumber', e.target.value)}
                  />
                </div>

                <div>
                  <label className={lbl}>Return Date *</label>
                  <input
                    type="date"
                    required
                    className={inp}
                    value={form.returnDate}
                    onChange={e => setField('returnDate', e.target.value)}
                  />
                </div>

                <div>
                  <label className={lbl}>Amount *</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ff-text-secondary)] text-sm font-medium">R</span>
                    <input
                      type="number"
                      required
                      min="0.01"
                      step="0.01"
                      className={`${inp} pl-7`}
                      placeholder="0.00"
                      value={form.amount}
                      onChange={e => setField('amount', e.target.value)}
                    />
                  </div>
                </div>

                <div className="md:col-span-2">
                  <label className={lbl}>Reason</label>
                  <textarea
                    className={`${inp} resize-none`}
                    rows={3}
                    placeholder="Reason for return..."
                    value={form.reason}
                    onChange={e => setField('reason', e.target.value)}
                  />
                </div>
              </div>
            </div>

            {amount > 0 && (
              <div className="bg-[var(--ff-bg-secondary)] rounded-xl border border-[var(--ff-border-light)] p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Receipt className="h-4 w-4 text-amber-500" />
                  <span className="text-sm font-semibold text-[var(--ff-text-primary)]">Return Amount</span>
                </div>
                <p className="font-mono font-bold text-lg text-red-400">{formatCurrency(amount)}</p>
              </div>
            )}

            <div className="flex items-center justify-end gap-3">
              <Link
                href="/accounting/supplier-returns"
                className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] rounded-lg transition-colors"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex items-center gap-2 px-5 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
              >
                {isSubmitting ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Creating...</>
                ) : (
                  'Create Return'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
