/**
 * New Recurring Invoice Page
 * Create a recurring invoice template with full line items.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Repeat, Loader2, AlertCircle,
} from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  LineItemsSection,
  type LineItem,
} from '@/components/accounting/recurringInvoices/LineItemsSection';

interface Customer { id: string; name?: string; company_name?: string }

const FREQ_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
];

const newLine = (): LineItem => ({
  key: String(Date.now() + Math.random()),
  description: '', quantity: 1, unitPrice: 0, glAccountId: '',
});

export default function NewRecurringInvoicePage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const today = new Date().toISOString().split('T')[0]!;
  const [form, setForm] = useState({
    templateName: '',
    clientId: '',
    frequency: 'monthly',
    nextRunDate: today,
    endDate: '',
    description: '',
    taxRate: 15,
    paymentTerms: '30 days',
    autoSendEmail: false,
  });
  const [lines, setLines] = useState<LineItem[]>([newLine()]);

  useEffect(() => {
    apiFetch('/api/accounting/customers')
      .then(r => r.json())
      .then((json: { data?: unknown }) => {
        const d = json.data;
        const list = Array.isArray(d) ? d : (d as { clients?: Customer[] })?.clients ?? [];
        setCustomers(list as Customer[]);
      })
      .catch(err => {
        log.error('Failed to load customers for recurring invoice form', { error: err }, 'recurring-new');
      });
  }, []);

  const updateLine = (key: string, field: keyof Omit<LineItem, 'key'>, value: string | number) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  };
  const addLine = () => setLines(prev => [...prev, newLine()]);
  const removeLine = (key: string) => {
    if (lines.length > 1) setLines(prev => prev.filter(l => l.key !== key));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!form.clientId) { setError('Please select a customer'); return; }
    if (lines.some(l => !l.description)) { setError('All line items must have a description'); return; }
    if (lines.some(l => l.unitPrice <= 0)) { setError('All line items must have a unit price > 0'); return; }

    setSubmitting(true);
    try {
      const payload = {
        templateName: form.templateName || `Recurring - ${customers.find(c => c.id === form.clientId)?.company_name ?? customers.find(c => c.id === form.clientId)?.name ?? 'Invoice'}`,
        clientId: form.clientId,
        frequency: form.frequency,
        nextRunDate: form.nextRunDate,
        endDate: form.endDate || undefined,
        description: form.description || undefined,
        taxRate: form.taxRate,
        paymentTerms: form.paymentTerms,
        lineItems: lines.map(l => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          glAccountId: l.glAccountId || undefined,
        })),
      };

      const res = await apiFetch('/api/accounting/recurring-invoices', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const json = await res.json() as { error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Create failed');

      await router.push('/accounting/recurring-invoices');
    } catch (err) {
      log.error('Failed to create recurring invoice', { error: err }, 'recurring-new');
      setError(err instanceof Error ? err.message : 'Failed to create recurring invoice');
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-1 focus:ring-violet-500';
  const labelCls = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-4">
            <Link
              href="/accounting/recurring-invoices"
              className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)] transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-500/10">
                <Repeat className="h-6 w-6 text-violet-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Recurring Invoice</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Set up a repeating invoice template</p>
              </div>
            </div>
          </div>
        </div>

        <form onSubmit={e => void handleSubmit(e)} className="px-6 py-6 max-w-4xl space-y-6">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
            </div>
          )}

          {/* Template Details */}
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide">Template Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Template Name</label>
                <input
                  className={inputCls}
                  value={form.templateName}
                  onChange={e => setForm(f => ({ ...f, templateName: e.target.value }))}
                  placeholder="e.g. Monthly Retainer — Acme Corp"
                />
              </div>
              <div>
                <label className={labelCls}>Customer *</label>
                <select
                  className={inputCls}
                  value={form.clientId}
                  onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
                  required
                >
                  <option value="">Select customer…</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.company_name ?? c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <input
                  className={inputCls}
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Optional description shown on generated invoices"
                />
              </div>
              <div>
                <label className={labelCls}>Payment Terms</label>
                <select
                  className={inputCls}
                  value={form.paymentTerms}
                  onChange={e => setForm(f => ({ ...f, paymentTerms: e.target.value }))}
                >
                  <option value="7 days">7 days</option>
                  <option value="14 days">14 days</option>
                  <option value="30 days">30 days</option>
                  <option value="60 days">60 days</option>
                  <option value="COD">COD</option>
                </select>
              </div>
            </div>
          </div>

          {/* Schedule */}
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide">Schedule</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className={labelCls}>Frequency *</label>
                <select
                  className={inputCls}
                  value={form.frequency}
                  onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}
                  required
                >
                  {FREQ_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>First Run Date *</label>
                <input
                  type="date"
                  className={inputCls}
                  value={form.nextRunDate}
                  onChange={e => setForm(f => ({ ...f, nextRunDate: e.target.value }))}
                  required
                />
              </div>
              <div>
                <label className={labelCls}>End Date (optional)</label>
                <input
                  type="date"
                  className={inputCls}
                  value={form.endDate}
                  onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))}
                  min={form.nextRunDate}
                />
              </div>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.autoSendEmail}
                  onChange={e => setForm(f => ({ ...f, autoSendEmail: e.target.checked }))}
                  className="w-4 h-4 rounded border-[var(--ff-border-light)] text-violet-600 focus:ring-violet-500"
                />
                <span className="text-sm text-[var(--ff-text-secondary)]">
                  Auto-send email to customer on each invoice generation
                </span>
              </label>
            </div>
          </div>

          {/* Line Items */}
          <LineItemsSection
            lines={lines}
            taxRate={form.taxRate}
            onTaxRateChange={rate => setForm(f => ({ ...f, taxRate: rate }))}
            onUpdateLine={updateLine}
            onAddLine={addLine}
            onRemoveLine={removeLine}
            inputCls={inputCls}
          />

          {/* Actions */}
          <div className="flex justify-end gap-3 pb-8">
            <Link
              href="/accounting/recurring-invoices"
              className="px-5 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-6 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors text-sm font-medium disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Recurring Invoice
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
