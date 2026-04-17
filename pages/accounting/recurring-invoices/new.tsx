/**
 * New Recurring Invoice — redesigned with ISAFlow design system
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, RefreshCw, Loader2, AlertCircle, Receipt } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { LineItemsSection, type LineItem } from '@/components/accounting/recurringInvoices/LineItemsSection';

interface Customer { id: string; name?: string; company_name?: string }

const FREQ_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
];

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

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
      .catch(err => { log.error('Failed to load customers', { error: err }, 'recurring-new'); });
  }, []);

  const updateLine = (key: string, field: keyof Omit<LineItem, 'key'>, value: string | number) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  };
  const addLine = () => setLines(prev => [...prev, newLine()]);
  const removeLine = (key: string) => { if (lines.length > 1) setLines(prev => prev.filter(l => l.key !== key)); };

  const subtotal = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  const tax = Math.round(subtotal * (form.taxRate / 100) * 100) / 100;
  const total = subtotal + tax;
  const fmtR = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    if (!form.clientId) { setError('Please select a customer'); return; }
    if (lines.some(l => !l.description)) { setError('All line items must have a description'); return; }
    if (lines.some(l => l.unitPrice <= 0)) { setError('All line items must have a unit price > 0'); return; }
    setSubmitting(true);
    try {
      const selectedCustomer = customers.find(c => c.id === form.clientId);
      const payload = {
        templateName: form.templateName || `Recurring - ${selectedCustomer?.company_name ?? selectedCustomer?.name ?? 'Invoice'}`,
        clientId: form.clientId,
        frequency: form.frequency,
        nextRunDate: form.nextRunDate,
        endDate: form.endDate || undefined,
        description: form.description || undefined,
        taxRate: form.taxRate,
        paymentTerms: form.paymentTerms,
        lineItems: lines.map(l => ({
          description: l.description, quantity: l.quantity,
          unitPrice: l.unitPrice, glAccountId: l.glAccountId || undefined,
        })),
      };
      const res = await apiFetch('/api/accounting/recurring-invoices', {
        method: 'POST', body: JSON.stringify(payload),
      });
      const json = await res.json() as { error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? 'Create failed');
      await router.push('/accounting/recurring-invoices');
    } catch (err) {
      log.error('Failed to create recurring invoice', { error: err }, 'recurring-new');
      setError(err instanceof Error ? err.message : 'Failed to create recurring invoice');
    } finally { setSubmitting(false); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/recurring-invoices" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Recurring Invoices
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                <RefreshCw className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
                <h1 className="text-xl font-bold text-slate-900 dark:text-white">Recurring Invoice</h1>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 xl:p-8">
          <form onSubmit={e => void handleSubmit(e)}>
            <div className="max-w-6xl mx-auto flex gap-6 items-start">
              <div className="flex-1 min-w-0 space-y-5">
                {error && (
                  <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 flex-shrink-0" />{error}
                  </div>
                )}

                <div className={`${card} p-5`}>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                    Template Details
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={lbl}>Template Name</label>
                      <input name="templateName" className={inp} value={form.templateName} onChange={e => setForm(f => ({ ...f, templateName: e.target.value }))} placeholder="e.g. Monthly Retainer — Acme Corp" />
                    </div>
                    <div>
                      <label className={lbl}>Customer *</label>
                      <select name="clientId" className={inp} value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} required>
                        <option value="">Select customer…</option>
                        {customers.map(c => <option key={c.id} value={c.id}>{c.company_name ?? c.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={lbl}>Description</label>
                      <input name="description" className={inp} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Shown on generated invoices" />
                    </div>
                    <div>
                      <label className={lbl}>Payment Terms</label>
                      <select name="paymentTerms" className={inp} value={form.paymentTerms} onChange={e => setForm(f => ({ ...f, paymentTerms: e.target.value }))}>
                        <option value="7 days">7 days</option>
                        <option value="14 days">14 days</option>
                        <option value="30 days">30 days</option>
                        <option value="60 days">60 days</option>
                        <option value="COD">COD</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className={`${card} p-5`}>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                    Schedule
                  </h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className={lbl}>Frequency *</label>
                      <select name="frequency" className={inp} value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))} required>
                        {FREQ_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={lbl}>First Run Date *</label>
                      <input type="date" name="nextRunDate" className={inp} value={form.nextRunDate} onChange={e => setForm(f => ({ ...f, nextRunDate: e.target.value }))} required />
                    </div>
                    <div>
                      <label className={lbl}>End Date (optional)</label>
                      <input type="date" name="endDate" className={inp} value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} min={form.nextRunDate} />
                    </div>
                  </div>
                  <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800">
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <input type="checkbox" name="autoSendEmail" checked={form.autoSendEmail} onChange={e => setForm(f => ({ ...f, autoSendEmail: e.target.checked }))} className="w-4 h-4 rounded border-slate-300 dark:border-slate-600 text-amber-500 focus:ring-amber-500/30" />
                      <span className="text-sm text-slate-600 dark:text-slate-400">Auto-send email to customer on each invoice generation</span>
                    </label>
                  </div>
                </div>

                <div className={`${card} overflow-hidden`}>
                  <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                      <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">3</span>
                      Line Items
                    </h3>
                  </div>
                  <div className="p-5">
                    <LineItemsSection
                      lines={lines}
                      taxRate={form.taxRate}
                      onTaxRateChange={rate => setForm(f => ({ ...f, taxRate: rate }))}
                      onUpdateLine={updateLine}
                      onAddLine={addLine}
                      onRemoveLine={removeLine}
                      inputCls={inp}
                    />
                  </div>
                </div>
              </div>

              <div className="w-72 shrink-0">
                <div className="sticky top-6">
                  <div className={`${card} p-5`}>
                    <div className="flex items-center gap-2 mb-5">
                      <Receipt className="w-4 h-4 text-amber-500" />
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Template Summary</h3>
                    </div>
                    <div className="space-y-3">
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 dark:text-slate-400">Subtotal</span>
                        <span className="font-mono text-slate-900 dark:text-slate-100">{fmtR(subtotal)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 dark:text-slate-400">VAT ({form.taxRate}%)</span>
                        <span className="font-mono text-slate-900 dark:text-slate-100">{fmtR(tax)}</span>
                      </div>
                      <div className="h-px bg-slate-100 dark:bg-slate-800" />
                      <div className="flex justify-between">
                        <span className="text-sm font-semibold text-slate-900 dark:text-white">Total per Run</span>
                        <span className="font-mono font-bold text-lg text-amber-500">{fmtR(total)}</span>
                      </div>
                      {form.frequency && (
                        <p className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500 capitalize">{form.frequency} billing starting {form.nextRunDate || '—'}</p>
                      )}
                    </div>
                    <button type="submit" disabled={submitting} className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                      {submitting ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><RefreshCw className="h-4 w-4" />Create Recurring Invoice</>}
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500 text-center px-2 mt-3">Template will be active immediately and generate invoices on each run date.</p>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
