/**
 * Create Customer Invoice — two-column document editor layout
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2, Info, Receipt } from 'lucide-react';
import { ApiEnvelopeError, apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { localISODate } from '@/lib/dateUtils';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { fuzzyMatchClient } from '@/modules/accounting/utils/fuzzyMatch';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { CodingPicker, InvoiceLineItemsTable, type InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { useInvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';

interface Client { id: string; name: string }
interface Currency { code: string; name: string; symbol: string }
type LineItem = InvoiceLine;
const UNCODED = { glAccountId: '', projectId: '', costCenterId: '' };

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export default function NewCustomerInvoicePage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [saveAndNew, setSaveAndNew] = useState(false);
  const [error, setError] = useState('');
  const [scanBanner, setScanBanner] = useState<string | null>(null);
  const today = localISODate();

  const [form, setForm] = useState({ clientId: '', invoiceDate: today, dueDate: '', billingPeriodStart: today, billingPeriodEnd: today, taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
  const [lines, setLines] = useState<LineItem[]>([{ key: '1', description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0, ...UNCODED }]);

  useEffect(() => {
    apiFetch('/api/accounting/customers', { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load clients - try again'); return r.json(); }).then(json => {
      const d = json.data || json; setClients(Array.isArray(d) ? d : d.clients || []);
    }).catch(err => setError(apiErrorMessage(err, 'Could not load clients - try again')));
    apiFetch('/api/accounting/currencies', { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load currencies - try again'); return r.json(); }).then(json => {
      const d = json.data || json; setCurrencies(Array.isArray(d) ? d : []);
    }).catch(err => setError(apiErrorMessage(err, 'Could not load currencies - try again')));
  }, []);

  const updateLine = (key: string, field: string, value: string | number) =>
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  // A new line starts on the invoice's project: a visible default the user can change, not a posting fallback.
  const addLine = () => setLines(prev => [...prev, { key: String(Date.now()), description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0, ...UNCODED, projectId: form.projectId }]);
  const codingOptions = useInvoiceLineCodingOptions();
  const removeLine = (key: string) => setLines(prev => prev.length > 1 ? prev.filter(l => l.key !== key) : prev);

  const lineTotal = (l: LineItem) => l.quantity * l.unitPrice * (1 - (l.discount || 0) / 100);
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const tax = subtotal * (form.taxRate / 100);
  const total = subtotal + tax;
  const isFx = form.currencyCode !== 'ZAR';
  const zarTotal = Math.round(total * form.exchangeRate * 100) / 100;

  function handleExtracted(data: ExtractedDocument) {
    const updates: Partial<typeof form> = {};
    if (data.date) updates.invoiceDate = data.date;
    if (data.dueDate) updates.dueDate = data.dueDate;
    if (data.vatRate !== null) updates.taxRate = data.vatRate;
    setForm(f => ({ ...f, ...updates }));
    if (data.customerName && clients.length > 0) {
      const match = fuzzyMatchClient(data.customerName, clients);
      if (match) setForm(f => ({ ...f, clientId: String(match.id) }));
    }
    if (data.lineItems.length > 0) {
      setLines(data.lineItems.map(li => ({ key: String(Date.now() + Math.random()), description: li.description, quantity: li.quantity ?? 1, unitPrice: li.unitPrice ?? 0, incomeType: 'other', discount: 0, ...UNCODED })));
    }
    setScanBanner(`Auto-filled (${Math.round(data.confidence * 100)}% confidence). Review all fields.`);
  }

  const handleSubmit = async (andNew = false) => {
    if (!form.clientId) return setError('Select a client');
    const validLines = lines.filter(l => l.description && l.unitPrice > 0);
    if (validLines.length === 0) return setError('Add at least one line item');
    if (isFx && form.exchangeRate <= 0) return setError('Exchange rate must be greater than 0');
    setSaveAndNew(andNew);
    setSubmitting(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, items: validLines }) });
      await assertOk(res, 'Could not create the invoice - try again');
      const json = await res.json() as { data?: { id?: string }; id?: string };
      const d = json.data || json;
      if (andNew) {
        const today = localISODate();
        setForm({ clientId: '', invoiceDate: today, dueDate: '', billingPeriodStart: today, billingPeriodEnd: today, taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
        setLines([{ key: '1', description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0, ...UNCODED }]);
        try { await router.push('/accounting/customer-invoices/new'); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-new'); }
      } else {
        if (!d.id) throw new ApiEnvelopeError('The invoice could not be opened - check the invoice list before creating it again');
        try { await router.push(`/accounting/customer-invoices/${d.id}`); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-new'); }
      }
    } catch (e) { setError(apiErrorMessage(e, 'Could not create the invoice - try again')); }
    finally { setSubmitting(false); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Page header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/customer-invoices" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Invoices
            </Link>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center"><FileText className="w-5 h-5 text-amber-400" /></div>
                <div>
                  <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
                  <h1 className="text-xl font-bold text-slate-900 dark:text-white">Customer Invoice</h1>
                </div>
              </div>
              <ScanAndFillButton onExtracted={handleExtracted} label="Scan Invoice" />
            </div>
          </div>
        </div>

        <div className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            {/* Left column — form */}
            <div className="flex-1 min-w-0 space-y-5">
              {/* Alerts */}
              {scanBanner && (
                <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 text-sm flex items-center gap-2">
                  <Info className="h-4 w-4 flex-shrink-0" />{scanBanner}
                  <button onClick={() => setScanBanner(null)} className="ml-auto text-xs font-medium opacity-70 hover:opacity-100">Dismiss</button>
                </div>
              )}
              {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error}</div>}

              {/* Client & Settings */}
              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2"><span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>Client &amp; Settings</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Client *</label>
                    <select name="clientId" value={form.clientId} onChange={e => setForm(p => ({ ...p, clientId: e.target.value }))} className={inp}>
                      <option value="">Select client…</option>
                      {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>VAT Rate %</label>
                    <input type="number" name="taxRate" value={form.taxRate} onChange={e => setForm(p => ({ ...p, taxRate: Number(e.target.value) }))} className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Currency</label>
                    <select name="currencyCode" value={form.currencyCode} onChange={e => setForm(p => ({ ...p, currencyCode: e.target.value, exchangeRate: e.target.value === 'ZAR' ? 1 : p.exchangeRate }))} className={inp}>
                      <option value="ZAR">ZAR — South African Rand</option>
                      {currencies.filter(c => c.code !== 'ZAR').map(c => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Project <span className="normal-case font-normal opacity-60">(display; new lines start on it)</span></label>
                    <CodingPicker label="Invoice project" value={form.projectId} options={codingOptions.projects} all={codingOptions} empty="No project" onChange={v => setForm(p => ({ ...p, projectId: v }))} />
                  </div>
                  {isFx && (
                    <div>
                      <label className={lbl}>Exchange Rate <span className="normal-case font-normal opacity-60">({form.currencyCode} → ZAR)</span></label>
                      <input type="number" name="exchangeRate" min={0.000001} step={0.000001} value={form.exchangeRate} onChange={e => setForm(p => ({ ...p, exchangeRate: Number(e.target.value) }))} placeholder="e.g. 18.5" className={inp} />
                    </div>
                  )}
                </div>
              </div>

              {/* Dates */}
              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2"><span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>Dates &amp; Period</h3>
                <div className="grid grid-cols-4 gap-4">
                  <div><label className={lbl}>Invoice Date</label><input type="date" name="invoiceDate" value={form.invoiceDate} onChange={e => setForm(p => ({ ...p, invoiceDate: e.target.value }))} className={inp} /></div>
                  <div><label className={lbl}>Due Date</label><input type="date" name="dueDate" value={form.dueDate} onChange={e => setForm(p => ({ ...p, dueDate: e.target.value }))} className={inp} /></div>
                  <div><label className={lbl}>Period Start</label><input type="date" name="billingPeriodStart" value={form.billingPeriodStart} onChange={e => setForm(p => ({ ...p, billingPeriodStart: e.target.value }))} className={inp} /></div>
                  <div><label className={lbl}>Period End</label><input type="date" name="billingPeriodEnd" value={form.billingPeriodEnd} onChange={e => setForm(p => ({ ...p, billingPeriodEnd: e.target.value }))} className={inp} /></div>
                </div>
              </div>

              {/* Line Items */}
              <div className={`${card} overflow-hidden`}>
                <InvoiceLineItemsTable lines={lines} currencyCode={form.currencyCode} lineTotal={lineTotal}
                  onUpdate={updateLine} onAdd={addLine} onRemove={removeLine} options={codingOptions} showIncomeType />
              </div>

              {/* Notes */}
              <div className={`${card} p-5`}>
                <label className={lbl}>Notes</label>
                <textarea name="notes" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={3} placeholder="Add any notes or payment instructions…" className={`${inp} resize-none`} />
              </div>
            </div>

            {/* Right column — sticky summary */}
            <div className="w-72 shrink-0">
              <div className="sticky top-6 space-y-4">
                <div className={`${card} p-5`}>
                  <div className="flex items-center gap-2 mb-5">
                    <Receipt className="w-4 h-4 text-amber-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Invoice Summary</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Subtotal</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrencyAmount(subtotal, form.currencyCode)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">VAT ({form.taxRate}%)</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{formatCurrencyAmount(tax, form.currencyCode)}</span>
                    </div>
                    <div className="h-px bg-slate-100 dark:bg-slate-800" />
                    <div className="flex justify-between">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
                      <span className="font-mono font-bold text-lg text-amber-500">{formatCurrencyAmount(total, form.currencyCode)}</span>
                    </div>
                    {isFx && (
                      <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                        <p className="text-xs text-slate-500 dark:text-slate-400 flex justify-between">
                          <span>ZAR equivalent</span>
                          <span className="font-mono text-amber-600 dark:text-amber-400 font-semibold">{formatCurrencyAmount(zarTotal, 'ZAR')}</span>
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">@ {form.exchangeRate} {form.currencyCode}/ZAR</p>
                      </div>
                    )}
                  </div>

                  <button onClick={() => handleSubmit(false)} disabled={submitting} className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                    {submitting && !saveAndNew ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><FileText className="h-4 w-4" />Create Invoice</>}
                  </button>
                  <button onClick={() => handleSubmit(true)} disabled={submitting} className="w-full mt-2 py-2.5 border border-amber-500 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 font-semibold rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                    {submitting && saveAndNew ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : <><FileText className="h-4 w-4" />Save &amp; New</>}
                  </button>
                </div>

                <p className="text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500 text-center px-2">Invoice will be saved as a draft. You can email it from the invoice detail page.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
