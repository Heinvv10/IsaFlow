/**
 * Edit Customer Invoice — only allowed while status === 'draft'.
 * Mirrors the new.tsx layout but loads the existing invoice and submits PUT.
 */
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, FileText, Loader2, AlertCircle, Receipt } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import { CodingPicker, InvoiceLineItemsTable, type InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { useInvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';

interface Client { id: string; name: string }
interface Currency { code: string; name: string; symbol: string }
// CC2 / BU are edited here; CC1 follows its CC2 — re-sent only while the line's CC2 is the one it loaded with,
// otherwise left to derivation (the project's FNO, else the customer's: dimensionKeepStored).
type LineItem = InvoiceLine & { cc1Id?: string | null; cc2AtLoad?: string };
const UNCODED = { glAccountId: '', projectId: '', cc2Id: '', buId: '' };
type InvoiceItemRow = {
  description?: string; unit_price?: number | string; quantity?: number | string;
  amount?: number | string; tax_rate?: number | string;
  gl_account_id?: string | null; project_id?: string | null; cc1_id?: string | null; cc2_id?: string | null; bu_id?: string | null;
};
type InvoiceDetail = {
  id: string; status: string; invoice_number: string;
  client_id?: string | null; customer_id?: string | null;
  invoice_date: string; due_date?: string | null;
  billing_period_start?: string | null; billing_period_end?: string | null;
  tax_rate: number | string; notes?: string | null;
  currency_code?: string | null; exchange_rate?: number | string | null; project_id?: string | null;
  items?: InvoiceItemRow[];
};

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

export default function EditCustomerInvoicePage() {
  const router = useRouter();
  const { invoiceId } = router.query;
  const [clients, setClients] = useState<Client[]>([]);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');

  const [form, setForm] = useState({ clientId: '', invoiceDate: '', dueDate: '', billingPeriodStart: '', billingPeriodEnd: '', taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' });
  const [lines, setLines] = useState<LineItem[]>([]);

  useEffect(() => {
    if (!invoiceId) return;
    const id = String(invoiceId);
    void Promise.all([
      apiFetch('/api/accounting/customers', { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load clients - try again'); return r.json(); }),
      apiFetch('/api/accounting/currencies', { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load currencies - try again'); return r.json(); }),
      apiFetch(`/api/accounting/customer-invoices-detail?id=${id}`, { credentials: 'include' }).then(async r => { await assertOk(r, 'Could not load the invoice - try again'); return r.json(); }),
    ]).then(([cRes, curRes, invRes]) => {
      const cData = cRes.data || cRes; setClients(Array.isArray(cData) ? cData : cData.clients || []);
      const curData = curRes.data || curRes; setCurrencies(Array.isArray(curData) ? curData : []);
      const invoice: InvoiceDetail = invRes.data || invRes;
      if (!invoice || !invoice.id) { setError('Invoice not found'); setLoading(false); return; }
      if (invoice.status !== 'draft') {
        setError(`This invoice is "${invoice.status}" and can no longer be edited. Only draft invoices are editable.`);
        setLoading(false);
        return;
      }
      setInvoiceNumber(invoice.invoice_number);
      setForm({
        clientId: String(invoice.client_id || invoice.customer_id || ''),
        invoiceDate: String(invoice.invoice_date || '').slice(0, 10),
        dueDate: invoice.due_date ? String(invoice.due_date).slice(0, 10) : '',
        billingPeriodStart: invoice.billing_period_start ? String(invoice.billing_period_start).slice(0, 10) : '',
        billingPeriodEnd: invoice.billing_period_end ? String(invoice.billing_period_end).slice(0, 10) : '',
        taxRate: Number(invoice.tax_rate ?? 15),
        notes: invoice.notes || '',
        currencyCode: invoice.currency_code || 'ZAR',
        exchangeRate: Number(invoice.exchange_rate ?? 1),
        projectId: invoice.project_id ?? '',
      });
      const items = invoice.items || [];
      // The schema has no `discount` column — it is folded into `amount`.
      // Reverse-engineer percent discount from amount vs (qty × unitPrice) so a
      // saved-then-reopened invoice round-trips without silently zeroing it.
      setLines(items.length > 0 ? items.map((it, i) => {
        const qty = Number(it.quantity || 1);
        const unitPrice = Number(it.unit_price || 0);
        const amount = Number(it.amount ?? qty * unitPrice);
        const base = qty * unitPrice;
        const discount = base > 0 && amount < base
          ? Math.round((1 - amount / base) * 1000) / 10
          : 0;
        return {
          key: String(i),
          description: String(it.description || ''),
          quantity: qty,
          unitPrice,
          discount,
          glAccountId: it.gl_account_id ?? '',
          projectId: it.project_id ?? '',
          cc2Id: it.cc2_id ?? '',
          buId: it.bu_id ?? '',
          cc1Id: it.cc1_id ?? null,
          cc2AtLoad: it.cc2_id ?? '',
        };
      }) : [{ key: '1', description: '', quantity: 1, unitPrice: 0, discount: 0, ...UNCODED, projectId: invoice.project_id ?? '' }]);
      setLoading(false);
    }).catch((err: unknown) => {
      setError(apiErrorMessage(err, 'Could not load the invoice - try again'));
      setLoading(false);
    });
  }, [invoiceId]);

  const updateLine = (key: string, field: keyof LineItem, value: string | number) =>
    setLines(prev => prev.map(l => l.key === key ? { ...l, [field]: value } : l));
  // A new line starts on the invoice's project: a visible default the user can change, not a posting fallback.
  const addLine = () => setLines(prev => [...prev, { key: String(Date.now()), description: '', quantity: 1, unitPrice: 0, discount: 0, ...UNCODED, projectId: form.projectId }]);
  const codingOptions = useInvoiceLineCodingOptions([form.projectId, ...lines.map(l => l.projectId)]);
  const removeLine = (key: string) => setLines(prev => prev.length > 1 ? prev.filter(l => l.key !== key) : prev);

  const lineTotal = (l: LineItem) => l.quantity * l.unitPrice * (1 - (l.discount || 0) / 100);
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const tax = subtotal * (form.taxRate / 100);
  const total = subtotal + tax;
  const isFx = form.currencyCode !== 'ZAR';

  const handleSubmit = async () => {
    if (!form.clientId) return setError('Select a client');
    const validLines = lines.filter(l => l.description && l.unitPrice >= 0 && l.quantity > 0);
    if (validLines.length === 0) return setError('Add at least one line item');
    setSubmitting(true); setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-invoices-detail', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: String(invoiceId),
          clientId: form.clientId,
          invoiceDate: form.invoiceDate,
          dueDate: form.dueDate || undefined,
          billingPeriodStart: form.billingPeriodStart || undefined,
          billingPeriodEnd: form.billingPeriodEnd || undefined,
          taxRate: form.taxRate,
          notes: form.notes || undefined,
          currencyCode: form.currencyCode,
          exchangeRate: form.exchangeRate,
          projectId: form.projectId || null,
          items: validLines.map(l => ({
            description: l.description, quantity: l.quantity,
            unitPrice: l.unitPrice, taxRate: form.taxRate,
            discount: l.discount || 0,
            glAccountId: l.glAccountId || null,
            projectId: l.projectId || null,
            cc2Id: l.cc2Id || null,
            buId: l.buId || null,
            ...(l.cc1Id && l.cc2Id === (l.cc2AtLoad ?? '') ? { cc1Id: l.cc1Id } : {}),
          })),
        }),
      });
      await assertOk(res, 'Could not save the invoice - try again');
      try { await router.push(`/accounting/customer-invoices/${String(invoiceId)}`); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-invoices-edit-invoiceId'); }
    } catch (e) { setError(apiErrorMessage(e, 'Could not save the invoice - try again')); }
    finally { setSubmitting(false); }
  };

  if (loading) return <AppLayout><div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="h-8 w-8 animate-spin text-amber-500" /></div></AppLayout>;

  if (error && !invoiceNumber) {
    return (
      <AppLayout>
        <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4 px-6">
          <AlertCircle className="h-10 w-10 text-red-400" />
          <p className="text-center text-sm text-slate-600 dark:text-slate-300 max-w-md">{error}</p>
          <Link
            href={`/accounting/customer-invoices/${String(invoiceId)}`}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Invoice
          </Link>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="relative z-10">
            <Link href={`/accounting/customer-invoices/${String(invoiceId)}`} className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Invoice
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center"><FileText className="w-5 h-5 text-amber-400" /></div>
              <div>
                <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">Edit Draft</p>
                <h1 className="text-xl font-bold text-white">{invoiceNumber}</h1>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            <div className="flex-1 min-w-0 space-y-5">
              {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm flex items-center gap-2"><AlertCircle className="h-4 w-4" />{error}</div>}

              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2"><span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>Client &amp; Settings</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Client *</label>
                    <select value={form.clientId} onChange={e => setForm(p => ({ ...p, clientId: e.target.value }))} className={inp}>
                      <option value="">Select client…</option>
                      {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>VAT Rate %</label>
                    <input type="number" value={form.taxRate} onChange={e => setForm(p => ({ ...p, taxRate: Number(e.target.value) }))} className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Currency</label>
                    <select value={form.currencyCode} onChange={e => setForm(p => ({ ...p, currencyCode: e.target.value, exchangeRate: e.target.value === 'ZAR' ? 1 : p.exchangeRate }))} className={inp}>
                      <option value="ZAR">ZAR — South African Rand</option>
                      {currencies.filter(c => c.code !== 'ZAR').map(c => <option key={c.code} value={c.code}>{c.code} — {c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Job <span className="normal-case font-normal opacity-60">(display; new lines start on it)</span></label>
                    <CodingPicker label="Invoice job" value={form.projectId} options={codingOptions.projects} all={codingOptions} empty="No job" onChange={v => setForm(p => ({ ...p, projectId: v }))} />
                  </div>
                  {isFx && (
                    <div>
                      <label className={lbl}>Exchange Rate ({form.currencyCode} → ZAR)</label>
                      <input type="number" min={0.000001} step={0.000001} value={form.exchangeRate} onChange={e => setForm(p => ({ ...p, exchangeRate: Number(e.target.value) }))} className={inp} />
                    </div>
                  )}
                </div>
              </div>

              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2"><span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>Dates &amp; Period</h3>
                <div className="grid grid-cols-4 gap-4">
                  <div><label className={lbl}>Invoice Date</label><input type="date" value={form.invoiceDate} onChange={e => setForm(p => ({ ...p, invoiceDate: e.target.value }))} className={inp} /></div>
                  <div><label className={lbl}>Due Date</label><input type="date" value={form.dueDate} onChange={e => setForm(p => ({ ...p, dueDate: e.target.value }))} className={inp} /></div>
                  <div><label className={lbl}>Period Start</label><input type="date" value={form.billingPeriodStart} onChange={e => setForm(p => ({ ...p, billingPeriodStart: e.target.value }))} className={inp} /></div>
                  <div><label className={lbl}>Period End</label><input type="date" value={form.billingPeriodEnd} onChange={e => setForm(p => ({ ...p, billingPeriodEnd: e.target.value }))} className={inp} /></div>
                </div>
              </div>

              <div className={`${card} overflow-hidden`}>
                <InvoiceLineItemsTable lines={lines} currencyCode={form.currencyCode} lineTotal={lineTotal}
                  onUpdate={updateLine} onAdd={addLine} onRemove={removeLine} options={codingOptions} />
              </div>

              <div className={`${card} p-5`}>
                <label className={lbl}>Notes</label>
                <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={3} placeholder="Notes or payment instructions…" className={`${inp} resize-none`} />
              </div>
            </div>

            <div className="w-72 shrink-0">
              <div className="sticky top-6 space-y-4">
                <div className={`${card} p-5`}>
                  <div className="flex items-center gap-2 mb-5">
                    <Receipt className="w-4 h-4 text-amber-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Invoice Summary</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Subtotal</span><span className="font-mono">{formatCurrencyAmount(subtotal, form.currencyCode)}</span></div>
                    <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">VAT ({form.taxRate}%)</span><span className="font-mono">{formatCurrencyAmount(tax, form.currencyCode)}</span></div>
                    <div className="h-px bg-slate-100 dark:bg-slate-800" />
                    <div className="flex justify-between"><span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span><span className="font-mono font-bold text-lg text-amber-500">{formatCurrencyAmount(total, form.currencyCode)}</span></div>
                  </div>
                  <button onClick={handleSubmit} disabled={submitting} className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors shadow-lg disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                    {submitting ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</> : <><FileText className="h-4 w-4" />Save Changes</>}
                  </button>
                  <Link href={`/accounting/customer-invoices/${String(invoiceId)}`} className="block w-full mt-2 py-2.5 text-center border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 font-semibold rounded-xl transition-colors text-sm">Cancel</Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
