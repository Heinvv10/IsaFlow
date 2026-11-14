/** Admin — Invoice List: filter by status/date, paginate, email drafts to the billing email, mark paid, create invoices. */

import { useState, useEffect, useCallback, useRef } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { AlertCircle, Loader2, Search, ChevronLeft, ChevronRight, Plus, Send, CreditCard } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';

import { ConfirmModal } from '@/components/admin/ConfirmModal';
import { CreateInvoiceModal } from '@/components/admin/billing/CreateInvoiceModal';
import { type Invoice, type PagedResponse } from '@/components/admin/billing/invoiceModel';

type InvoiceAction = 'send' | 'mark_paid';

const STATUS_BADGE: Record<string, string> = {
  draft:      'bg-gray-500/10 text-gray-500',
  sent:       'bg-blue-500/10 text-blue-400',
  paid:       'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  overdue:    'bg-red-500/10 text-red-500',
  cancelled:  'bg-gray-500/10 text-gray-500',
  credited:   'bg-purple-500/10 text-purple-400',
};

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
  const [actionId, setActionId]   = useState<string | null>(null);
  // The action waiting for the admin to confirm it: Send emails the customer, Mark Paid closes the invoice.
  const [pending, setPending]     = useState<{ invoice: Invoice; action: InvoiceAction } | null>(null);
  const [notice, setNotice]       = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LIMIT = 25;

  const load = useCallback(async (q: string, st: string, from: string, to: string, pg: number) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(pg), limit: String(LIMIT) });
      if (q)    params.set('search',    q);
      if (st)   params.set('status',    st);
      if (from) params.set('from_date', from);
      if (to)   params.set('to_date',   to);
      const res  = await apiFetch(`/api/admin/billing/invoices?${params}`);
      await assertOk(res, 'Could not load invoices - try again');
      const json = await res.json();
      const d = json.data as PagedResponse;
      setRows(d.items);
      setTotal(d.total);
    } catch (err) {
      setRows([]); setTotal(0);
      setError(apiErrorMessage(err, 'Could not load invoices - try again'));
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

  async function handleAction(id: string, action: InvoiceAction) {
    setActionId(id);
    setNotice('');
    const failure = action === 'send' ? 'Could not send the invoice - try again' : 'Could not mark the invoice as paid - try again';
    try {
      // Route files use hyphens; mark_paid → mark-paid
      const route = action === 'mark_paid' ? 'mark-paid' : action;
      const body  = action === 'mark_paid' ? JSON.stringify({ payment_method: 'manual' }) : undefined;
      const res   = await apiFetch(`/api/admin/billing/invoices/${id}/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body,
      });
      await assertOk(res, failure);
      if (action === 'send') {
        const json = await res.json() as { data?: { recipient?: string } };
        setNotice(json.data?.recipient ? `Invoice emailed to ${json.data.recipient}` : 'Invoice emailed');
      }
      void load(search, status, dateFrom, dateTo, page);
    } catch (err) {
      setError(apiErrorMessage(err, failure));
    } finally {
      setActionId(null);
    }
  }

  function confirmPending() {
    if (!pending) return;
    const { invoice, action } = pending;
    setPending(null);
    void handleAction(invoice.id, action);
  }

  const inputCls = 'px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500';

  return (
    <AdminLayout title="Invoices">
      {/* Toolbar */}
      <div className="flex gap-3 flex-wrap mb-5">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600 dark:text-gray-400" />
          <input type="text" placeholder="Search company or invoice #..." value={search} onChange={e => setSearch(e.target.value)}
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
        <div className="w-40"><DateField label="From date" value={dateFrom || null} onChange={(iso, v) => { if (v.valid) { setDateFrom(iso ?? ''); setPage(1); } }} /></div>
        <div className="w-40"><DateField label="To date" value={dateTo || null} onChange={(iso, v) => { if (v.valid) { setDateTo(iso ?? ''); setPage(1); } }} /></div>
        <span className="text-sm text-gray-500 dark:text-gray-400 self-center ml-auto">{total} total</span>
        <button onClick={() => setShowForm(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg transition-colors">
          <Plus className="w-4 h-4" /> Create Invoice
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-4">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {notice && (
        <div role="status" className="p-3 rounded-lg bg-teal-500/10 text-teal-700 dark:text-teal-300 text-sm mb-4">{notice}</div>
      )}

      {showForm && (
        <CreateInvoiceModal onClose={() => setShowForm(false)}
          onCreated={() => { setShowForm(false); void load(search, status, dateFrom, dateTo, 1); }} />
      )}

      <ConfirmModal
        open={pending !== null}
        title={pending?.action === 'send' ? 'Send invoice?' : 'Mark invoice paid?'}
        message={pending?.action === 'send'
          ? (pending.invoice.billing_email
            ? `Email ${pending.invoice.invoice_number} (${formatCurrency(pending.invoice.total_cents / 100)}) to ${pending.invoice.billing_email}, ${pending.invoice.company_name}'s billing email? It is then marked sent.`
            : `${pending.invoice.company_name} has no billing email, so this send will be refused. Add one on the company first.`)
          : `Mark ${pending?.invoice.invoice_number ?? ''} (${formatCurrency((pending?.invoice.total_cents ?? 0) / 100)}) as paid? Use this only once the payment has arrived.`}
        confirmLabel={pending?.action === 'send' ? 'Send invoice' : 'Mark as paid'}
        confirmClass="bg-brand-600 hover:bg-brand-700 text-white"
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />

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
                <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-600 dark:text-gray-400">No invoices found</td></tr>
              )}
              {rows.map(inv => (
                <tr key={inv.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">{inv.invoice_number}</td>
                  <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{inv.company_name}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${STATUS_BADGE[inv.status] ?? 'bg-gray-500/10 text-gray-500'}`}>{inv.status}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 tabular-nums text-xs">{formatCurrency(inv.subtotal_cents / 100)}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 tabular-nums text-xs">{formatCurrency(inv.tax_cents / 100)}</td>
                  <td className="px-4 py-3 text-gray-600 dark:text-gray-300 tabular-nums text-xs font-semibold">{formatCurrency(inv.total_cents / 100)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(inv.due_date)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(inv.paid_at)}</td>
                  <td className="px-4 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">{formatDate(inv.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {inv.status === 'draft' && (
                        <button onClick={() => setPending({ invoice: inv, action: 'send' })} disabled={actionId === inv.id}
                          className="p-1.5 rounded text-gray-600 dark:text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-40" title="Send">
                          {actionId === inv.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      {(inv.status === 'sent' || inv.status === 'overdue') && (
                        <button onClick={() => setPending({ invoice: inv, action: 'mark_paid' })} disabled={actionId === inv.id}
                          className="p-1.5 rounded text-gray-600 dark:text-gray-400 hover:text-teal-400 hover:bg-teal-500/10 transition-colors disabled:opacity-40" title="Mark Paid">
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
