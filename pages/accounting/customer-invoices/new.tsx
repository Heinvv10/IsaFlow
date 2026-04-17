/**
 * Create Customer Invoice — two-column document editor layout
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Plus, Trash2, Loader2, Info, SlidersHorizontal, Receipt } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { fuzzyMatchClient } from '@/modules/accounting/utils/fuzzyMatch';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

interface Client { id: string; name: string }
interface Currency { code: string; name: string; symbol: string }
interface LineItem { key: string; description: string; quantity: number; unitPrice: number; incomeType: string; discount: number }

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
  const [showDiscount, setShowDiscount] = useState(false);
  const today = new Date().toISOString().split('T')[0];

  const [form, setForm] = useState({ clientId: '', invoiceDate: today, dueDate: '', billingPeriodStart: today, billingPeriodEnd: today, taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1 });
  const [lines, setLines] = useState<LineItem[]>([{ key: '1', description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0 }]);

  useEffect(() => {
    apiFetch('/api/accounting/customers', { credentials: 'include' }).then(r => r.json()).then(json => {
      const d = json.data || json; setClients(Array.isArray(d) ? d : d.clients || []);
    }).catch(() => {/* non-critical */});
    apiFetch('/api/accounting/currencies', { credentials: 'include' }).then(r => r.json()).then(json => {
      const d = json.data || json; setCurrencies(Array.isArray(d) ? d : []);
    }).catch(() => {/* non-critical */});
  }, []);

  const updateLine = (key: string, field: string, value: string | number) =>
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  const addLine = () => setLines(prev => [...prev, { key: String(Date.now()), description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0 }]);
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
      setLines(data.lineItems.map(li => ({ key: String(Date.now() + Math.random()), description: li.description, quantity: li.quantity ?? 1, unitPrice: li.unitPrice ?? 0, incomeType: 'other', discount: 0 })));
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
      const json = await res.json() as { data?: { id?: string }; id?: string; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message || 'Failed to create');
      const d = json.data || json;
      if (andNew) {
        const today = new Date().toISOString().split('T')[0];
        setForm({ clientId: '', invoiceDate: today, dueDate: '', billingPeriodStart: today, billingPeriodEnd: today, taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1 });
        setLines([{ key: '1', description: '', quantity: 1, unitPrice: 0, incomeType: 'other', discount: 0 }]);
        await router.push('/accounting/customer-invoices/new');
      } else {
        await router.push(`/accounting/customer-invoices/${d.id}`);
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); setSubmitting(false); }
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
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2"><span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">3</span>Line Items</h3>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setShowDiscount(v => !v)} className={`inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border font-medium transition-colors ${showDiscount ? 'border-teal-400/60 text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-900/20' : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-amber-400/50 hover:text-amber-500'}`}>
                      <SlidersHorizontal className="h-3 w-3" />{showDiscount ? 'Hide Disc.' : 'Disc. %'}
                    </button>
                    <button onClick={addLine} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-semibold transition-colors"><Plus className="h-3 w-3" />Add Line</button>
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Description</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 w-32">Type</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-20">Qty</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-32">Unit Price</th>
                      {showDiscount && <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-20">Disc.%</th>}
                      <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-32">Total</th>
                      <th className="w-9" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {lines.map(l => (
                      <tr key={l.key} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                        <td className="px-3 py-2"><input name="description" value={l.description} onChange={e => updateLine(l.key, 'description', e.target.value)} placeholder="Item description" className={inp} /></td>
                        <td className="px-3 py-2"><select name="incomeType" value={l.incomeType} onChange={e => updateLine(l.key, 'incomeType', e.target.value)} className={inp}>
                          <option value="activation">Activation</option><option value="bonus">Bonus</option><option value="adjustment">Adjustment</option><option value="other">Other</option>
                        </select></td>
                        <td className="px-3 py-2"><input type="number" name="quantity" value={l.quantity} onChange={e => updateLine(l.key, 'quantity', Number(e.target.value))} className={`${inp} text-right`} /></td>
                        <td className="px-3 py-2"><input type="number" name="unitPrice" value={l.unitPrice} step={0.01} onChange={e => updateLine(l.key, 'unitPrice', Number(e.target.value))} className={`${inp} text-right`} /></td>
                        {showDiscount && <td className="px-3 py-2"><input type="number" min={0} max={100} step={0.1} value={l.discount || ''} onChange={e => updateLine(l.key, 'discount', e.target.value === '' ? 0 : Number(e.target.value))} placeholder="0" className={`${inp} text-right`} /></td>}
                        <td className="px-4 py-2 text-right">
                          <span className="font-mono text-sm font-semibold text-slate-800 dark:text-slate-200">{formatCurrencyAmount(lineTotal(l), form.currencyCode)}</span>
                          {showDiscount && l.discount > 0 && <span className="block text-xs text-teal-600 dark:text-teal-400 font-medium">-{l.discount}%</span>}
                        </td>
                        <td className="px-2 py-2"><button onClick={() => removeLine(l.key)} className="p-1.5 rounded-lg text-slate-700 dark:text-slate-300 dark:text-slate-700 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
