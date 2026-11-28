/**
 * Customer Quotes — the list and its New Quote modal (CreateQuoteModal: a VAT type per line) + elevated table
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { useOpenOnAction } from '@/hooks/useOpenOnAction';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Plus, Search, Loader2, Send, Check, X, ArrowRight,
  ExternalLink, ClipboardList, Download } from 'lucide-react';
import { StatusPill, PageHeader } from '@/components/ui';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { formatMoney as fmt } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import { CreateQuoteModal, type CustomerOption } from '@/components/accounting/customer-quotes/CreateQuoteModal';

interface Quote { id: string; quoteNumber: string; customerName: string; quoteDate: string; expiryDate: string | null; status: string; total: number; invoiceId?: string }
const TABS = ['all', 'draft', 'sent', 'accepted', 'declined', 'expired', 'converted'] as const;

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
      setCustomers(list.map((c: CustomerOption) => ({ id: String(c.id), name: String(c.name), default_vat_type: c.default_vat_type ?? null })));
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
      const json = await res.json().catch(() => ({})) as { data?: { invoiceId?: string; warnings?: { message: string }[] }; invoiceId?: string };
      // A total that moved (the VAT rate changed since the quote's date) is said, not only logged.
      const warned = (json.data?.warnings ?? []).map((w) => w.message).join(' ');
      setSuccessMsg({ text: `${q.quoteNumber} converted.${warned ? ` ${warned}` : ''}`, invoiceId: json.data?.invoiceId || json.invoiceId || '' }); void load();
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
            <button onClick={() => setShowNew(true)} className="inline-flex items-center gap-2 px-4 py-2 max-lg:min-h-11 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" /> New Quote
            </button>
          }
        />

        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-1 p-1 max-lg:flex-wrap bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
              {TABS.map(t => (
                <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 max-lg:min-h-11 max-lg:min-w-11 text-xs font-medium rounded-lg capitalize transition-colors ${tab === t ? 'bg-amber-700 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{t}</button>
              ))}
            </div>
            <div className="relative max-lg:w-full">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 dark:text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search quotes…" className="pl-9 pr-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm max-lg:min-h-11 max-lg:w-full focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 text-slate-900 dark:text-slate-100 transition-colors w-56" />
            </div>
          </div>

          {successMsg && (
            <div className="flex items-center justify-between bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-xl px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
              <span>{successMsg.text}</span>
              <div className="flex items-center gap-3">
                <button onClick={() => router.push(`/accounting/customer-invoices/${successMsg.invoiceId}`)} className="flex items-center gap-1 max-lg:min-h-11 font-semibold hover:underline">View Invoice <ExternalLink className="h-3.5 w-3.5" /></button>
                <button onClick={() => setSuccessMsg(null)} aria-label="Dismiss" className="max-lg:inline-flex max-lg:h-11 max-lg:w-11 max-lg:items-center max-lg:justify-center"><X className="h-4 w-4" /></button>
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
                <button onClick={() => setShowNew(true)} className="mt-5 px-4 py-2 max-lg:min-h-11 bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold rounded-lg transition-colors">Create Quote</button>
              </div>
            ) : (
              <table className="table-cards w-full text-sm">
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
                        <td data-label="Quote #" className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{q.quoteNumber}</td>
                        <td data-label="Customer" className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{q.customerName}</td>
                        <td data-label="Date" className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{formatDisplayDate(q.quoteDate)}</td>
                        <td data-label="Expiry" className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{formatDisplayDate(q.expiryDate)}</td>
                        <td data-label="Total" className="px-5 py-3.5 text-right tabular-nums font-semibold text-slate-900 dark:text-white">{fmt(q.total)}</td>
                        <td data-label="Status" className="px-5 py-3.5"><StatusPill status={q.status} /></td>
                        <td className="px-4 py-3.5">
                          <div className="flex justify-end gap-1.5 max-lg:flex-wrap">
                            <a href={`/api/accounting/quote-pdf?quoteId=${q.id}`} target="_blank" rel="noreferrer" title="Download PDF" aria-label={`Download PDF ${q.quoteNumber}`} className="p-1.5 max-lg:inline-flex max-lg:h-11 max-lg:w-11 max-lg:items-center max-lg:justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"><Download className="h-3.5 w-3.5" /></a>
                            {q.status === 'draft' && <button onClick={() => handleAction(q.id, 'send')} title="Mark Sent" aria-label={`Mark ${q.quoteNumber} sent`} className="p-1.5 max-lg:inline-flex max-lg:h-11 max-lg:w-11 max-lg:items-center max-lg:justify-center rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 text-slate-500 dark:text-slate-400 hover:text-blue-500 transition-colors"><Send className="h-3.5 w-3.5" /></button>}
                            {q.status === 'sent' && (<>
                              <button onClick={() => handleAction(q.id, 'accept')} aria-label={`Accept quote ${q.quoteNumber}`} title="Accept" className="p-1.5 max-lg:inline-flex max-lg:h-11 max-lg:w-11 max-lg:items-center max-lg:justify-center rounded-lg hover:bg-emerald-50 dark:hover:bg-emerald-900/20 text-slate-500 dark:text-slate-400 hover:text-emerald-500 transition-colors"><Check className="h-3.5 w-3.5" /></button>
                              <button onClick={() => handleAction(q.id, 'decline')} aria-label={`Decline quote ${q.quoteNumber}`} title="Decline" className="p-1.5 max-lg:inline-flex max-lg:h-11 max-lg:w-11 max-lg:items-center max-lg:justify-center rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-500 dark:text-slate-400 hover:text-red-500 transition-colors"><X className="h-3.5 w-3.5" /></button>
                            </>)}
                            {q.status === 'accepted' && (<>
                              <button onClick={() => handleConvertToSO(q)} disabled={convertingToSO === q.id} className="flex items-center gap-1 px-2.5 py-1 max-lg:min-h-11 rounded-lg text-xs font-semibold bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors disabled:opacity-40">
                                {convertingToSO === q.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ClipboardList className="h-3 w-3" />} To SO
                              </button>
                              <button onClick={() => handleConvert(q)} disabled={converting === q.id} className="flex items-center gap-1 px-2.5 py-1 max-lg:min-h-11 rounded-lg text-xs font-semibold bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors disabled:opacity-40">
                                {converting === q.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />} Invoice
                              </button>
                            </>)}
                            {q.status === 'converted' && q.invoiceId && (
                              <button onClick={() => router.push(`/accounting/customer-invoices/${q.invoiceId}`)} className="flex items-center gap-1 px-2.5 py-1 max-lg:min-h-11 rounded-lg text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors">
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
