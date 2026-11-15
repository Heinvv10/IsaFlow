/**
 * Customer Quotes — redesigned with modal form + elevated table
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { useOpenOnAction } from '@/hooks/useOpenOnAction';
import { AppLayout } from '@/components/layout/AppLayout';
import { Modal } from '@/components/ui/Modal';
import { FileText, Plus, Search, Loader2, Send, Check, X, ArrowRight,
  ExternalLink, ClipboardList, Trash2, Download } from 'lucide-react';
import { StatusPill, PageHeader, DateField } from '@/components/ui';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { localISODate } from '@/lib/dateUtils';
import { formatMoney as fmt } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import { numberLines } from '@/lib/lineNumbers';
import { useDateGate } from '@/hooks/useDateGate';
import { useVatRegistrationOrDefault } from '@/hooks/useVatRegistration';
import type { TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { QuoteVatFields } from '@/components/accounting/customer-quotes/QuoteVatFields';
import { initialQuoteTaxMode, quoteLinePayload, quoteLinesForModeChange, quoteLineTotal, quoteTotals } from '@/components/accounting/customer-quotes/quoteVat';

interface Quote { id: string; quoteNumber: string; customerName: string; quoteDate: string; expiryDate: string | null; status: string; total: number; invoiceId?: string }
interface CustomerOption { id: string; name: string }
const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5';
const TABS = ['all', 'draft', 'sent', 'accepted', 'declined', 'expired', 'converted'] as const;

interface ModalProps { customers: CustomerOption[]; onClose: () => void; onCreated: () => void }
function CreateQuoteModal({ customers, onClose, onCreated }: ModalProps) {
  const [form, setForm] = useState({ clientId: '', customerName: '', quoteDate: localISODate(), expiryDate: '', notes: '' });
  const [lines, setLines] = useState([{ desc: '', qty: 1, price: 0 }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(''); const dates = useDateGate();
  const vat = useVatRegistrationOrDefault(); const [tax, setTax] = useState<{ mode: TaxMode; rate: number }>({ mode: 'exclusive', rate: 15 });
  const mode: TaxMode = initialQuoteTaxMode(vat) === 'none' ? 'none' : tax.mode; // a non-vendor quotes with no VAT
  const pickMode = (to: TaxMode) => { setLines(ls => quoteLinesForModeChange(ls, mode, to, tax.rate)); setTax(t => ({ ...t, mode: to })); };

  const handleCreate = async () => {
    if (dates.blocked || !form.clientId || lines.every(l => !l.desc)) return;
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-quotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: form.clientId, customerName: form.customerName, quoteDate: form.quoteDate, expiryDate: form.expiryDate, notes: form.notes, lines: numberLines(lines, l => !!l.desc).map(l => ({ description: l.desc, quantity: l.qty, ...quoteLinePayload(l, mode, tax.rate), lineNo: l.lineNo })) }),
      });
      await assertOk(res, 'Could not create the quote - try again');
      onCreated();
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not create the quote - try again'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="New Quote" size="xl">
      <Modal.Body className="space-y-5">
        <p className="text-xs text-slate-500 dark:text-slate-400">Fill in the quote details below</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-3">
              <label htmlFor="quote-customer" className={lbl}>Customer *</label>
              <select id="quote-customer" value={form.clientId} onChange={e => { const s = customers.find(c => c.id === e.target.value); setForm(p => ({ ...p, clientId: e.target.value, customerName: s?.name ?? '' })); }} className={inp}>
                <option value="">Select a customer…</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <DateField label="Quote Date" name="quoteDate" value={form.quoteDate || null} onChange={dates.bind('quoteDate', iso => setForm(p => ({ ...p, quoteDate: iso })), form.quoteDate)} />
            <DateField label="Expiry Date" name="expiryDate" value={form.expiryDate || null} onChange={dates.bind('expiryDate', iso => setForm(p => ({ ...p, expiryDate: iso })), form.expiryDate)} />
            <div><label htmlFor="quote-notes" className={lbl}>Notes</label><input id="quote-notes" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional" className={inp} /></div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className={lbl}>Line items</span>
              <button type="button" onClick={() => setLines(l => [...l, { desc: '', qty: 1, price: 0 }])} className="text-xs text-amber-500 hover:text-amber-400 flex items-center gap-1 font-semibold transition-colors"><Plus className="w-3 h-3" />Add line</button>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
              <table className="block md:table w-full text-sm" aria-label="Quote line items">
                <thead className="hidden md:table-header-group bg-slate-50 dark:bg-slate-800/60"><tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Description</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-20">Qty</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-28">Unit Price</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-24">Total</th>
                  <th className="w-8"><span className="sr-only">Remove line</span></th>
                </tr></thead>
                <tbody className="block md:table-row-group divide-y divide-slate-100 dark:divide-slate-800">
                  {lines.map((l, i) => (
                    <tr key={i} className="group grid grid-cols-3 gap-2 p-3 md:table-row md:p-0">
                      <td className="col-span-3 md:table-cell px-0 md:px-2 py-0 md:py-2"><input aria-label={`Description, line ${i + 1}`} value={l.desc} onChange={e => { const n = [...lines]; n[i] = { ...l, desc: e.target.value }; setLines(n); }} placeholder="Item description" className={inp} /></td>
                      <td className="md:table-cell px-0 md:px-2 py-0 md:py-2"><span className="md:hidden block text-xs text-slate-600 dark:text-slate-400 mb-1">Qty</span><input type="number" inputMode="decimal" aria-label={`Quantity, line ${i + 1}`} value={l.qty} min={1} onChange={e => { const n = [...lines]; n[i] = { ...l, qty: Number(e.target.value) }; setLines(n); }} className={`${inp} text-right`} /></td>
                      <td className="md:table-cell px-0 md:px-2 py-0 md:py-2"><span className="md:hidden block text-xs text-slate-600 dark:text-slate-400 mb-1">Unit price</span><input type="number" inputMode="decimal" aria-label={`Unit price, line ${i + 1}`} value={l.price} min={0} step={0.01} onChange={e => { const n = [...lines]; n[i] = { ...l, price: Number(e.target.value) }; setLines(n); }} className={`${inp} text-right`} /></td>
                      <td className="md:table-cell px-0 md:px-3 py-0 md:py-2 text-right tabular-nums text-xs font-semibold text-slate-700 dark:text-slate-300"><span className="md:hidden block text-xs font-normal text-slate-600 dark:text-slate-400 mb-1">Total</span>{fmt(quoteLineTotal(l, mode, tax.rate))}</td>
                      <td className="col-span-3 flex justify-end md:table-cell px-0 md:px-2 py-0 md:py-2"><button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => lines.length > 1 && setLines(lines.filter((_, j) => j !== i))} className="p-1 min-h-11 min-w-11 md:min-h-0 md:min-w-0 inline-flex items-center justify-center rounded text-slate-700 dark:text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <QuoteVatFields registration={vat} mode={mode} rate={tax.rate} totals={quoteTotals(lines, mode, tax.rate)} onModeChange={pickMode} onRateChange={rate => setTax(t => ({ ...t, rate }))} />
          </div>

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </Modal.Body>
      <Modal.Footer>
        <button type="button" onClick={onClose} className="px-4 py-2 min-h-11 sm:min-h-0 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
          <button type="button" onClick={handleCreate} disabled={saving || dates.blocked || !form.clientId || lines.every(l => !l.desc)} className="px-5 py-2 text-sm font-semibold bg-brand-600 hover:bg-brand-700 text-white rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {saving ? 'Creating…' : 'Create Quote'}
          </button>
      </Modal.Footer>
    </Modal>
  );
}

export default function CustomerQuotesPage() {
  const router = useRouter();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  useOpenOnAction('new', () => setShowNew(true));
  const [converting, setConverting] = useState<string | null>(null);
  const [convertingToSO, setConvertingToSO] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<{ text: string; invoiceId: string } | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    const p = new URLSearchParams();
    if (tab !== 'all') p.set('status', tab);
    if (search) p.set('search', search);
    try {
      const res = await apiFetch(`/api/accounting/customer-quotes?${p}`);
      await assertOk(res, 'Could not load quotes - try again');
      const json = await res.json() as { data?: { quotes?: Quote[]; total?: number }; quotes?: Quote[]; total?: number };
      const d = json.data || json;
      setQuotes(d.quotes || []); setTotal(d.total || 0);
    } catch (err) { setQuotes([]); setLoadError(apiErrorMessage(err, 'Could not load quotes - try again')); }
    finally { setLoading(false); }
  }, [tab, search]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    apiFetch('/api/accounting/customers').then(async r => { await assertOk(r, 'Could not load customers - try again'); return r.json(); }).then((json: { data?: CustomerOption[] }) => {
      const list = Array.isArray(json.data) ? json.data : [];
      setCustomers(list.map((c: CustomerOption) => ({ id: String(c.id), name: String(c.name) })));
    }).catch(err => setLoadError(apiErrorMessage(err, 'Could not load customers - try again')));
  }, []);

  const handleAction = async (id: string, action: string) => {
    setLoadError('');
    try {
      const res = await apiFetch('/api/accounting/customer-quotes-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) });
      await assertOk(res, 'Could not update the quote - try again');
      void load();
    } catch (err) { setLoadError(apiErrorMessage(err, 'Could not update the quote - try again')); }
  };

  const handleConvert = async (q: Quote) => {
    if (!window.confirm(`Convert ${q.quoteNumber} (${fmt(q.total)}) to an invoice?`)) return;
    setConverting(q.id); setSuccessMsg(null);
    try {
      const res = await apiFetch('/api/accounting/customer-quotes-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: q.id, action: 'convert' }) });
      await assertOk(res, 'Could not convert the quote - try again');
      const json = await res.json().catch(() => ({})) as { data?: { invoiceId?: string }; invoiceId?: string };
      setSuccessMsg({ text: `${q.quoteNumber} converted.`, invoiceId: json.data?.invoiceId || json.invoiceId || '' }); void load();
    } catch (err) { window.alert(apiErrorMessage(err, 'Could not convert the quote - try again')); }
    finally { setConverting(null); }
  };

  const handleConvertToSO = async (q: Quote) => {
    if (!window.confirm(`Convert ${q.quoteNumber} to a Sales Order?`)) return;
    setConvertingToSO(q.id);
    try {
      const res = await apiFetch('/api/accounting/customer-quotes-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: q.id, action: 'convert-to-order' }) });
      if (!res.ok && res.status !== 409) await assertOk(res, 'Could not convert the quote - try again');
      const json = await res.json().catch(() => ({})) as { data?: { salesOrderId?: string }; salesOrderId?: string; error?: { message?: string; details?: { salesOrderId?: string | null } } };
      // A 409 with an order id is a double-click: the order exists, so open it.
      const orderId = res.ok ? json.data?.salesOrderId || json.salesOrderId : json.error?.details?.salesOrderId;
      if (orderId) { try { await router.push(`/accounting/customer-sales-orders/${orderId}`); } catch (e) { log.warn('navigation failed', { error: e }, 'customer-quotes'); } }
      else window.alert(res.ok ? 'The quote was converted but the order could not be opened - find it under Sales Orders' : json.error?.message || 'Could not convert the quote - try again');
    } catch (err) { window.alert(apiErrorMessage(err, 'Could not convert the quote - try again')); }
    finally { setConvertingToSO(null); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={FileText}
          title="Customer Quotes"
          subtitle={`${total} ${total === 1 ? 'quote' : 'quotes'}`}
          actions={
            <button onClick={() => setShowNew(true)} className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" /> New Quote
            </button>
          }
        />

        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
              {TABS.map(t => (
                <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${tab === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{t}</button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 dark:text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search quotes…" className="pl-9 pr-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 text-slate-900 dark:text-slate-100 transition-colors w-56" />
            </div>
          </div>

          {successMsg && (
            <div className="flex items-center justify-between bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
              <span>{successMsg.text}</span>
              <div className="flex items-center gap-3">
                <button onClick={() => router.push(`/accounting/customer-invoices/${successMsg.invoiceId}`)} className="flex items-center gap-1 font-semibold hover:underline">View Invoice <ExternalLink className="h-3.5 w-3.5" /></button>
                <button onClick={() => setSuccessMsg(null)}><X className="h-4 w-4" /></button>
              </div>
            </div>
          )}

          {loadError && <div className="text-sm text-red-600 dark:text-red-400">{loadError}</div>}

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {loading ? (
              <div className="p-16 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" /></div>
            ) : quotes.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4"><FileText className="w-7 h-7 text-slate-500 dark:text-slate-400" /></div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No quotes found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Create your first quote to get started</p>
                <button onClick={() => setShowNew(true)} className="mt-5 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold rounded-lg transition-colors">Create Quote</button>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['Quote #', 'Customer', 'Date', 'Expiry', 'Total', 'Status', ''].map((h, i) => (
                      <th key={i} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 4 ? 'text-right' : i === 6 ? 'text-right' : 'text-left'}`}>{h || <span className="sr-only">Actions</span>}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {quotes.map(q => (
                      <tr key={q.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                        <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{q.quoteNumber}</td>
                        <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{q.customerName}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{formatDisplayDate(q.quoteDate)}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{formatDisplayDate(q.expiryDate)}</td>
                        <td className="px-5 py-3.5 text-right tabular-nums font-semibold text-slate-900 dark:text-white">{fmt(q.total)}</td>
                        <td className="px-5 py-3.5"><StatusPill status={q.status} /></td>
                        <td className="px-4 py-3.5">
                          <div className="flex justify-end gap-1.5">
                            <a href={`/api/accounting/quote-pdf?quoteId=${q.id}`} target="_blank" rel="noreferrer" title="Download PDF" className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"><Download className="h-3.5 w-3.5" /></a>
                            {q.status === 'draft' && <button onClick={() => handleAction(q.id, 'send')} title="Mark Sent" className="p-1.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 text-slate-500 dark:text-slate-400 hover:text-blue-500 transition-colors"><Send className="h-3.5 w-3.5" /></button>}
                            {q.status === 'sent' && (<>
                              <button onClick={() => handleAction(q.id, 'accept')} className="p-1.5 rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/20 text-slate-500 dark:text-slate-400 hover:text-emerald-500 transition-colors"><Check className="h-3.5 w-3.5" /></button>
                              <button onClick={() => handleAction(q.id, 'decline')} className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-500 dark:text-slate-400 hover:text-red-500 transition-colors"><X className="h-3.5 w-3.5" /></button>
                            </>)}
                            {q.status === 'accepted' && (<>
                              <button onClick={() => handleConvertToSO(q)} disabled={convertingToSO === q.id} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors disabled:opacity-40">
                                {convertingToSO === q.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ClipboardList className="h-3 w-3" />} To SO
                              </button>
                              <button onClick={() => handleConvert(q)} disabled={converting === q.id} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors disabled:opacity-40">
                                {converting === q.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />} Invoice
                              </button>
                            </>)}
                            {q.status === 'converted' && q.invoiceId && (
                              <button onClick={() => router.push(`/accounting/customer-invoices/${q.invoiceId}`)} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
                                <ExternalLink className="h-3 w-3" /> Invoice
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
      {showNew && <CreateQuoteModal customers={customers} onClose={() => setShowNew(false)} onCreated={load} />}
    </AppLayout>
  );
}
