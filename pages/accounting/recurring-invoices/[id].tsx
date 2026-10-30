/**
 * Edit Recurring Invoice Page
 * Dedicated edit form for an existing recurring invoice template.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, Repeat, Loader2, AlertCircle, Save,
} from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  LineItemsSection,
  type LineItem,
} from '@/components/accounting/recurringInvoices/LineItemsSection';
import { DateField } from '@/components/ui'; import { useDateGate } from '@/hooks/useDateGate';
import { datePayload, endBeforeNextRefused } from '@/components/accounting/recurringInvoices/recurringEditDates';
import { useRecurringTemplateLoad, newLine } from '@/components/accounting/recurringInvoices/useRecurringTemplateLoad';

interface Customer { id: string; name?: string; company_name?: string }

const FREQ_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
];

export default function EditRecurringInvoicePage() {
  const router = useRouter();
  const { id } = router.query as { id: string };

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [customersError, setCustomersError] = useState('');
  const dates = useDateGate();
  const { form, setForm, lines, setLines, loading, loadedId, loadError, loadedDates } = useRecurringTemplateLoad(id);
  const isLoaded = loadedId === id;

  useEffect(() => {
    apiFetch('/api/accounting/customers')
      .then(async r => { await assertOk(r, 'Could not load customers - try again'); return r.json(); })
      .then((json: { data?: unknown }) => {
        const d = json.data;
        const list = Array.isArray(d) ? d : (d as { clients?: Customer[] })?.clients ?? [];
        setCustomers(list as Customer[]);
      })
      .catch(err => {
        log.error('Failed to load customers', { error: err }, 'recurring-edit');
        setCustomersError(apiErrorMessage(err, 'Could not load customers - try again'));
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
    if (!isLoaded) return;
    if (dates.blocked) { setError('Fix the date marked in red before saving.'); return; }
    setError(''); if (!form.nextRunDate) { setError('Enter the next run date.'); return; }
    if (endBeforeNextRefused(form, loadedDates.current)) { setError('The end date cannot be before the next run date.'); return; }
    if (lines.some(l => !l.description)) { setError('All line items must have a description'); return; }
    setSubmitting(true);
    try {
      const payload = {
        id,
        templateName: form.templateName,
        frequency: form.frequency,
        ...datePayload(form, loadedDates.current),
        description: form.description || undefined,
        lineItems: lines.map(l => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          glAccountId: l.glAccountId || undefined,
        })),
      };
      const res = await apiFetch('/api/accounting/recurring-invoices', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      await assertOk(res, 'Could not save the recurring invoice - try again');
      loadedDates.current = { nextRunDate: form.nextRunDate, endDate: form.endDate };
      try { await router.push('/accounting/recurring-invoices'); } catch (navErr) { log.warn('navigation failed', { error: navErr }, 'recurring-invoices-id'); }
    } catch (err) {
      log.error('Failed to update recurring invoice', { id, error: err }, 'recurring-edit');
      setError(apiErrorMessage(err, 'Could not save the recurring invoice - try again'));
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'w-full px-3 py-2 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-light)] rounded-lg text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-1 focus:ring-violet-500';
  const labelCls = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

  if (loading) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
        </div>
      </AppLayout>
    );
  }

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
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Edit Recurring Invoice</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">{form.templateName || 'Loading…'}</p>
              </div>
            </div>
          </div>
        </div>

        <form onSubmit={e => void handleSubmit(e)} className="px-6 py-6 max-w-4xl space-y-6">
          {(error || loadError || customersError) && (
            <div role="alert" className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error || loadError || customersError}
            </div>
          )}

          {/* Template Details */}
          <div className="bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide">Template Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Template Name</label>
                <input
                  name="templateName"
                  className={inputCls}
                  value={form.templateName}
                  onChange={e => setForm(f => ({ ...f, templateName: e.target.value }))}
                  placeholder="e.g. Monthly Retainer"
                />
              </div>
              <div>
                <label className={labelCls}>Customer</label>
                <select
                  name="clientId"
                  className={inputCls}
                  value={form.clientId}
                  onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))}
                  disabled
                >
                  <option value="">Select customer…</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>{c.company_name ?? c.name}</option>
                  ))}
                </select>
                <p className="text-xs text-[var(--ff-text-secondary)] mt-1">Customer cannot be changed after creation</p>
              </div>
              <div>
                <label className={labelCls}>Description</label>
                <input
                  name="description"
                  className={inputCls}
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Optional description"
                />
              </div>
              <div>
                <label className={labelCls}>Payment Terms</label>
                <select
                  name="paymentTerms"
                  className={inputCls}
                  value={form.paymentTerms}
                  onChange={e => setForm(f => ({ ...f, paymentTerms: e.target.value }))}
                  disabled
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
                  name="frequency"
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
                <DateField label="Next Run Date" required name="nextRunDate" value={form.nextRunDate || null}
                  onChange={dates.bind('nextRunDate', iso => setForm(f => ({ ...f, nextRunDate: iso })), form.nextRunDate)} />
              </div>
              <div>
                <DateField label="End Date (optional)" name="endDate" value={form.endDate || null} minDate={form.nextRunDate || undefined}
                  onChange={dates.bind('endDate', iso => setForm(f => ({ ...f, endDate: iso })), form.endDate)} />
              </div>
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
              disabled={submitting || !isLoaded}
              className="inline-flex items-center gap-2 px-6 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors text-sm font-medium disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              <Save className="h-4 w-4" />
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
