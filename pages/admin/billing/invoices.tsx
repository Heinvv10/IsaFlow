/** Admin — Invoice List: filter by status/date, paginate, send drafts, mark paid, create invoices. */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2, Search, ChevronLeft, ChevronRight, Plus, X, Check, Send, CreditCard } from 'lucide-react';

interface Invoice {
  id: string; invoiceNumber: string; companyId: string; companyName: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled' | 'credited';
  subtotalCents: number; taxCents: number; totalCents: number;
  dueDate: string | null; paidAt: string | null; createdAt: string;
}

interface PagedResponse {
  items: Invoice[];
  total: number;
  page: number;
  limit: number;
}

interface InvForm {
  company_id: string;
  subtotal: string;
  tax: string;
  total: string;
  due_date: string;
  notes: string;
}

const EMPTY_FORM: InvForm = { company_id: '', subtotal: '', tax: '0', total: '', due_date: '', notes: '' };

const STATUS_BADGE: Record<string, string> = {
  draft:      'bg-gray-500/10 text-gray-500',
  sent:       'bg-blue-500/10 text-blue-400',
  paid:       'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  overdue:    'bg-red-500/10 text-red-500',
  cancelled:  'bg-gray-500/10 text-gray-500',
  credited:   'bg-purple-500/10 text-purple-400',
};

function fmtZAR(cents: number) {
  return (cents / 100).toLocaleString('en-ZA', { style: 'currency', currency: 'ZAR' });
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-ZA');
}

export default function InvoicesPage() {
  const [rows, setRows]           = useState<Invoice[]>([]);
  const [total, setTotal]         = useState(0);
  const [page, setPage]           = useState(1);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [search, setSearch]       = useState('');
  const [status, setStatus]       = useState('');
  const [dateFrom, setDateFrom]   = useState('');
  const [dateTo, setDateTo]       = useState('');
  const [showForm, setShowForm]   = useState(false);
  const [form, setForm]           = useState<InvForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving]       = useState(false);
  const [actionId, setActionId]   = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LIMIT = 25;

  const load = useCallback(async (q: string, st: string, from: string, to: string, pg: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(pg), limit: String(LIMIT) });
      if (q)    params.set('search',    q);
      if (st)   params.set('status',    st);
      if (from) params.set('date_from', from);
      if (to)   params.set('date_to',   to);
      const res  = await apiFetch(`/api/admin/billing/invoices?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load invoices');
      const d = json.data as PagedResponse;
      setRows(d.items);
      setTotal(d.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      void load(search, status, dateFrom, dateTo, 1);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search, status, dateFrom, dateTo, load]);

  useEffect(() => { void load(search, status, dateFrom, dateTo, page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));

  async function handleAction(id: string, action: 'send' | 'mark_paid') {
    setActionId(id);
    try {
      const res  = await apiFetch(`/api/admin/billing/invoices/${id}/${action}`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Action failed');
      void load(search, status, dateFrom, dateTo, page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionId(null);
    }
  }

  async function handleCreate() {
    setFormError('');
    if (!form.company_id.trim()) { setFormError('Company ID is required'); return; }
    if (!form.subtotal)          { setFormError('Subtotal is required'); return; }
    if (!form.total)             { setFormError('Total is required'); return; }
    setSaving(true);
    try {
      const res  = await apiFetch('/api/admin/billing/invoices', {
        method: 'POST',
        body: JSON.stringify({
          company_id:     form.company_id,
          subtotal_cents: Math.round(parseFloat(form.subtotal) * 100),
          tax_cents:      Math.round(parseFloat(form.tax || '0') * 100),
          total_cents:    Math.round(parseFloat(form.total) * 100),
          due_date:       form.due_date || null,
          notes:          form.notes || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to create invoice');
      setShowForm(false);
      setForm(EMPTY_FORM);
      void load(search, status, dateFrom, dateTo, 1);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  }

  const inputCls = 'px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500';

  return (
    <AdminLayout title="Invoices">
      {/* Toolbar */}
      <div className="flex gap-3 flex-wrap mb-5">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input type="text" placeholder="Search company or invoice #…" value={search} onChange={e => setSearch(e.target.value)}
            className={`w-full pl-9 pr-3 ${inputCls}`} />
        </div>
        <select value={status} onChange={e => { setStatus(e.target.value); setPage(1); }} className={inputCls}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="sent">Sent</option>
          <option value="paid">Paid</option>
          <option value="overdue">Overdue</option>
          <option value="cancelled">Cancelled</option>
          <option value="credited">Credited</option>
        </select>
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} className={inputCls} title="From date" />
        <input type="date" value={dateTo}   onChange={e => { setDateTo(e.target.value);   setPage(1); }} className={inputCls} title="To date" />
        <span className="text-sm text-gray-500 dark:text-gray-400 self-center ml-auto">{total} total</span>
        <button onClick={() => { setShowForm(true); setFormError(''); setForm(EMPTY_FORM); }}
          className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg transition-colors">
          <Plus className="w-4 h-4" /> Create Invoice
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Create Invoice Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Create Invoice</h3>
              <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-5 space-y-4">
              {formError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-xs">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" /> {formError}
                </div>
              )}
              {(['company_id', 'subtotal', 'tax', 'total', 'due_date'] as const).map((key, i) => {
                const labels = ['Company ID', 'Subtotal (R)', 'Tax (R)', 'Total (R)', 'Due Date'];
                const types  = ['text', 'number', 'number', 'number', 'date'];
                return (
                  <div key={key}>
                    <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{labels[i]}</label>
                    <input type={types[i]} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} className={`w-full ${inputCls}`} />
                  </div>
                );
              })}
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  className={`w-full ${inputCls}`} />
              </div>
            </div>
            <div className="px-5 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors">Cancel</button>
              <button onClick={() => void handleCreate()} disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                {['Invoice #','Company','Status','Subtotal','Tax','Total','Due Date','Paid At','Created','Actions'].map(h => (
                  <th key={h} className="px-4 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-12 text-center"><Loader2 className="w-5 h-5 animate-spin text-teal-500 mx-auto" /></td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">No invoices found</td></tr>
              )}
              {rows.map(inv => (
                <tr key={inv.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">{inv.invoiceNumber}</td>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{inv.companyName}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[inv.status] ?? 'bg-gray-500/10 text-gray-500'}`}>{inv.status}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs">{fmtZAR(inv.subtotalCents)}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs">{fmtZAR(inv.taxCents)}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs font-semibold">{fmtZAR(inv.totalCents)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtDate(inv.dueDate)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtDate(inv.paidAt)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{fmtDate(inv.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {inv.status === 'draft' && (
                        <button onClick={() => void handleAction(inv.id, 'send')} disabled={actionId === inv.id}
                          className="p-1.5 rounded text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-40" title="Send">
                          {actionId === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      {(inv.status === 'sent' || inv.status === 'overdue') && (
                        <button onClick={() => void handleAction(inv.id, 'mark_paid')} disabled={actionId === inv.id}
                          className="p-1.5 rounded text-gray-400 hover:text-teal-400 hover:bg-teal-500/10 transition-colors disabled:opacity-40" title="Mark Paid">
                          {actionId === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CreditCard className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
          <span className="text-gray-500 dark:text-gray-400">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
              className="p-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
              className="p-1.5 rounded border border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}
