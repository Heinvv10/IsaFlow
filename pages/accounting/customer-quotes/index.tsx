/**
 * Customer Quotes — redesigned with modal form + elevated table
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { FileText, Plus, Search, Loader2, Send, Check, X, ArrowRight,
  ExternalLink, ClipboardList, Trash2, Download } from 'lucide-react';
import { StatusPill, PageHeader } from '@/components/ui';
import { apiFetch } from '@/lib/apiFetch';

interface Quote { id: string; quoteNumber: string; customerName: string; quoteDate: string; expiryDate: string | null; status: string; total: number; invoiceId?: string }
interface CustomerOption { id: string; name: string }

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const TABS = ['all', 'draft', 'sent', 'accepted', 'declined', 'expired', 'converted'] as const;
const STATUS: Record<string, { label: string; cls: string }> = {
  draft:     { label: 'Draft',     cls: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300' },
  sent:      { label: 'Sent',      cls: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' },
  accepted:  { label: 'Accepted',  cls: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' },
  declined:  { label: 'Declined',  cls: 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400' },
  expired:   { label: 'Expired',   cls: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' },
  converted: { label: 'Converted', cls: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400' },
};

interface ModalProps { customers: CustomerOption[]; onClose: () => void; onCreated: () => void }
function CreateQuoteModal({ customers, onClose, onCreated }: ModalProps) {
  const [form, setForm] = useState({ clientId: '', customerName: '', quoteDate: new Date().toISOString().split('T')[0], expiryDate: '', notes: '' });
  const [lines, setLines] = useState([{ desc: '', qty: 1, price: 0 }]);
  const [saving, setSaving] = useState(false);
  const subtotal = lines.reduce((s, l) => s + l.qty * l.price, 0);

  const handleCreate = async () => {
    if (!form.clientId || lines.every(l => !l.desc)) return;
    setSaving(true);
    await apiFetch('/api/accounting/customer-quotes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: form.clientId, customerName: form.customerName, quoteDate: form.quoteDate, expiryDate: form.expiryDate, notes: form.notes, lines: lines.filter(l => l.desc).map(l => ({ description: l.desc, quantity: l.qty, unitPrice: l.price, taxRate: 15 })) }),
    });
    setSaving(false); onCreated(); onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 pb-8 px-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center"><FileText className="w-4 h-4 text-amber-500" /></div>
            <div><h2 className="text-base font-semibold text-slate-900 dark:text-white">New Quote</h2><p className="text-xs text-slate-500 dark:text-slate-400">Fill in the quote details below</p></div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-3">
              <label className={lbl}>Customer *</label>
              <select value={form.clientId} onChange={e => { const s = customers.find(c => c.id === e.target.value); setForm(p => ({ ...p, clientId: e.target.value, customerName: s?.name ?? '' })); }} className={inp}>
                <option value="">Select a customer…</option>
                {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div><label className={lbl}>Quote Date</label><input type="date" value={form.quoteDate} onChange={e => setForm(p => ({ ...p, quoteDate: e.target.value }))} className={inp} /></div>
            <div><label className={lbl}>Expiry Date</label><input type="date" value={form.expiryDate} onChange={e => setForm(p => ({ ...p, expiryDate: e.target.value }))} className={inp} /></div>
            <div><label className={lbl}>Notes</label><input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Optional" className={inp} /></div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className={lbl}>Line Items</label>
              <button onClick={() => setLines(l => [...l, { desc: '', qty: 1, price: 0 }])} className="text-xs text-amber-500 hover:text-amber-400 flex items-center gap-1 font-semibold transition-colors"><Plus className="w-3 h-3" />Add line</button>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/60"><tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Description</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-20">Qty</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-28">Unit Price</th>
                  <th className="px-3 py-2 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-24">Total</th>
                  <th className="w-8" />
                </tr></thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {lines.map((l, i) => (
                    <tr key={i} className="group">
                      <td className="px-2 py-2"><input value={l.desc} onChange={e => { const n = [...lines]; n[i] = { ...l, desc: e.target.value }; setLines(n); }} placeholder="Item description" className={inp} /></td>
                      <td className="px-2 py-2"><input type="number" value={l.qty} min={1} onChange={e => { const n = [...lines]; n[i] = { ...l, qty: Number(e.target.value) }; setLines(n); }} className={`${inp} text-right`} /></td>
                      <td className="px-2 py-2"><input type="number" value={l.price} min={0} step={0.01} onChange={e => { const n = [...lines]; n[i] = { ...l, price: Number(e.target.value) }; setLines(n); }} className={`${inp} text-right`} /></td>
                      <td className="px-3 py-2 text-right font-mono text-xs font-semibold text-slate-700 dark:text-slate-300">{fmt(l.qty * l.price)}</td>
                      <td className="px-2 py-2"><button onClick={() => lines.length > 1 && setLines(lines.filter((_, j) => j !== i))} className="p-1 rounded text-slate-700 dark:text-slate-300 dark:text-slate-600 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {subtotal > 0 && (
              <div className="mt-3 flex justify-end gap-4 text-sm px-1">
                <span className="text-slate-500 dark:text-slate-400">Subtotal <span className="font-mono text-slate-700 dark:text-slate-200">{fmt(subtotal)}</span></span>
                <span className="text-slate-500 dark:text-slate-400">VAT 15% <span className="font-mono text-slate-700 dark:text-slate-200">{fmt(subtotal * 0.15)}</span></span>
                <span className="font-bold text-amber-500 font-mono">{fmt(subtotal * 1.15)}</span>
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2 bg-slate-50/50 dark:bg-slate-800/20">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
          <button onClick={handleCreate} disabled={saving || !form.clientId || lines.every(l => !l.desc)} className="px-5 py-2 text-sm font-semibold bg-teal-600 hover:bg-teal-700 text-white rounded-lg transition-colors disabled:opacity-40 flex items-center gap-2">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
            {saving ? 'Creating…' : 'Create Quote'}
          </button>
        </div>
      </div>
    </div>
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
  const [converting, setConverting] = useState<string | null>(null);
  const [convertingToSO, setConvertingToSO] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<{ text: string; invoiceId: string } | null>(null);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams();
    if (tab !== 'all') p.set('status', tab);
    if (search) p.set('search', search);
    const res = await apiFetch(`/api/accounting/customer-quotes?${p}`);
    const json = await res.json() as { data?: { quotes?: Quote[]; total?: number }; quotes?: Quote[]; total?: number };
    const d = json.data || json;
    setQuotes(d.quotes || []); setTotal(d.total || 0); setLoading(false);
  }, [tab, search]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    apiFetch('/api/accounting/customers').then(r => r.json()).then((json: { data?: CustomerOption[] }) => {
      const list = Array.isArray(json.data) ? json.data : [];
      setCustomers(list.map((c: CustomerOption) => ({ id: String(c.id), name: String(c.name) })));
    }).catch(() => {/* non-fatal */});
  }, []);

  const handleAction = async (id: string, action: string) => {
    await apiFetch('/api/accounting/customer-quotes-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }) });
    void load();
  };

  const handleConvert = async (q: Quote) => {
    if (!window.confirm(`Convert ${q.quoteNumber} (${fmt(q.total)}) to an invoice?`)) return;
    setConverting(q.id); setSuccessMsg(null);
    const res = await apiFetch('/api/accounting/customer-quotes-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: q.id, action: 'convert' }) });
    const json = await res.json() as { data?: { invoiceId?: string }; invoiceId?: string; error?: { message?: string } };
    if (res.ok) { setSuccessMsg({ text: `${q.quoteNumber} converted.`, invoiceId: json.data?.invoiceId || json.invoiceId || '' }); void load(); }
    else window.alert(json?.error?.message || 'Failed to convert');
    setConverting(null);
  };

  const handleConvertToSO = async (q: Quote) => {
    if (!window.confirm(`Convert ${q.quoteNumber} to a Sales Order?`)) return;
    setConvertingToSO(q.id);
    const res = await apiFetch('/api/accounting/customer-quotes-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: q.id, action: 'convert-to-order' }) });
    const json = await res.json() as { data?: { salesOrderId?: string }; salesOrderId?: string; error?: { message?: string } };
    if (res.ok) await router.push(`/accounting/customer-sales-orders/${json.data?.salesOrderId || json.salesOrderId}`);
    else window.alert(json?.error?.message || 'Failed');
    setConvertingToSO(null);
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={FileText}
          title="Customer Quotes"
          subtitle={`${total} ${total === 1 ? 'quote' : 'quotes'}`}
          actions={
            <button onClick={() => setShowNew(true)} className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors">
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

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {loading ? (
              <div className="p-16 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" /></div>
            ) : quotes.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4"><FileText className="w-7 h-7 text-slate-500 dark:text-slate-400" /></div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No quotes found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Create your first quote to get started</p>
                <button onClick={() => setShowNew(true)} className="mt-5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-lg transition-colors">Create Quote</button>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['Quote #', 'Customer', 'Date', 'Expiry', 'Total', 'Status', ''].map((h, i) => (
                      <th key={i} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 4 ? 'text-right' : i === 6 ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {quotes.map(q => {
                    const sc = STATUS[q.status];
                    return (
                      <tr key={q.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                        <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{q.quoteNumber}</td>
                        <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{q.customerName}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{q.quoteDate?.split('T')[0]}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{q.expiryDate?.split('T')[0] || '—'}</td>
                        <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 dark:text-white">{fmt(q.total)}</td>
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
                    );
                  })}
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
