/**
 * Customer Write-Offs Page
 * Phase 1 Sage Alignment: Bad debt write-off management
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { XCircle, Plus, Check, Loader2 } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import { fetchCustomerOpenInvoices } from '@/components/accounting/allocations/openInvoiceFetch';
import { AmountInput } from '@/components/ui/AmountInput';

interface WriteOff {
  id: string; writeOffNumber: string; clientId: string; clientName?: string;
  invoiceId: string; invoiceNumber?: string; amount: number; reason: string;
  writeOffDate: string; status: string;
}
interface Client { id: string; name: string }
/** `balanceCents` is total - paid in whole cents: decimal subtraction gave R100.10 - R100 = 0.0999…, below the R0.10 shown. */
interface Invoice { id: string; invoice_number: string; balanceCents: number; currencyCode: string }

const fmt = (n: number) => formatMoney(n);
/** One /customer-invoices-list row (snake_case, string amounts) as the picker's invoice. */
const toInvoice = (r: Record<string, unknown>): Invoice => ({
  id: String(r.id), invoice_number: String(r.invoice_number ?? r.id),
  balanceCents: Math.round(Number(r.total_amount) * 100) - Math.round(Number(r.amount_paid) * 100),
  currencyCode: String(r.currency_code ?? '').trim().toUpperCase(),
});
/** Write-offs post in Rand and approval refuses a foreign-currency invoice, so only Rand (or unset) invoices are offered. */
const writeOffable = (inv: Invoice) => inv.balanceCents > 0 && (inv.currencyCode === '' || inv.currencyCode === 'ZAR');
const balanceStr = (inv: Invoice) => (inv.balanceCents / 100).toFixed(2);

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  approved: 'bg-teal-500/10 text-teal-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

export default function WriteOffsPage() {
  const [items, setItems] = useState<WriteOff[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [invoiceNote, setInvoiceNote] = useState('');
  const [form, setForm] = useState({ clientId: '', invoiceId: '', amount: '', reason: '' });

  // Resolves to a load error message ('' when fine): a failed load clears the rows, never throws into a write's flow.
  const load = useCallback(async (): Promise<string> => {
    try {
      const res = await apiFetch('/api/accounting/write-offs', { credentials: 'include' });
      await assertOk(res, 'Could not load write-offs - try again');
      const json = await res.json();
      setItems(json.data?.items || []);
      return '';
    } catch (err) {
      setItems([]);
      return apiErrorMessage(err, 'Could not load write-offs - try again');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load().then(msg => { if (msg) setError(msg); }); }, [load]);
  useEffect(() => {
    apiFetch('/api/accounting/customers', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load clients - try again'); return r.json(); }).then(res => {
      const d = res.data || res;
      setClients(Array.isArray(d) ? d : d.clients || []);
    }).catch(err => setError(apiErrorMessage(err, 'Could not load clients - try again')));
  }, []);

  useEffect(() => {
    setInvoices([]); setInvoiceNote('');
    if (!form.clientId) return;
    let stale = false; // picking another client before this answers: ignore this one
    fetchCustomerOpenInvoices(form.clientId)
      .then(all => {
        if (stale) return;
        setInvoices(all.rows.map(toInvoice).filter(writeOffable));
        setInvoiceNote(all.truncated ? `Showing ${all.rows.length} of ${all.total} invoices; the rest are not listed here.` : '');
      }).catch(err => { if (!stale) setError(apiErrorMessage(err, 'Could not load invoices - try again')); });
    return () => { stale = true; };
  }, [form.clientId]);

  const selectedInv = invoices.find(i => i.id === form.invoiceId);
  const maxAmount = selectedInv ? balanceStr(selectedInv) : undefined;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(''); setBusy('new');
    try {
      const res = await apiFetch('/api/accounting/write-offs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ clientId: form.clientId, invoiceId: form.invoiceId, amount: Number(form.amount), reason: form.reason }),
      });
      await assertOk(res, 'Could not save the write-off - try again');
      setShowForm(false);
      setForm({ clientId: '', invoiceId: '', amount: '', reason: '' });
      if (await load()) setError('The write-off was saved, but the list could not be refreshed - reload the page');
    } catch (err) { setError(apiErrorMessage(err, 'Could not save the write-off - try again')); }
    finally { setBusy(''); }
  };

  const approve = async (id: string) => {
    setBusy(id);
    try {
      const res = await apiFetch('/api/accounting/write-offs-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify({ action: 'approve', id }),
      });
      await assertOk(res, 'Could not approve the write-off - try again');
      if (await load()) setError('The write-off was approved, but the list could not be refreshed - reload the page');
    } catch (err) { setError(apiErrorMessage(err, 'Could not approve the write-off - try again')); }
    finally { setBusy(''); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-500/10"><XCircle className="h-6 w-6 text-red-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Customer Write-Offs</h1>
            </div>
            <button onClick={() => setShowForm(!showForm)} className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium">
              <Plus className="h-4 w-4" /> New Write-Off
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

          {showForm && (
            <form onSubmit={handleSubmit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">New Write-Off</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <select value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value, invoiceId: '', amount: '' }))} className="ff-select" required>
                  <option value="">Select Client *</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select value={form.invoiceId} onChange={e => { setForm(f => ({ ...f, invoiceId: e.target.value })); const inv = invoices.find(i => i.id === e.target.value); if (inv) setForm(f => ({ ...f, invoiceId: e.target.value, amount: balanceStr(inv) })); }} className="ff-select" required>
                  <option value="">Select Invoice *</option>
                  {invoices.map(inv => <option key={inv.id} value={inv.id}>{inv.invoice_number} — Balance: {fmt(inv.balanceCents / 100)}</option>)}
                </select>
                {invoiceNote && <p role="status" className="text-xs text-amber-400 md:col-span-2">{invoiceNote}</p>}
                <AmountInput min={0.01} max={maxAmount === undefined ? undefined : Number(maxAmount)} value={form.amount} onValueChange={(_n, t) => setForm(f => ({ ...f, amount: t }))} className="ff-input" placeholder="Amount *" required />
                <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="ff-input" placeholder="Reason *" required />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
                <button type="submit" disabled={busy === 'new'} className="px-6 py-2 bg-red-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Write-Off'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">WO Number</th><th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Invoice</th><th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Date</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && items.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No write-offs</td></tr>}
                {items.map(item => (
                  <tr key={item.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{item.writeOffNumber}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.clientName || '—'}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.invoiceNumber || '—'}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(item.amount)}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{formatDisplayDate(item.writeOffDate)}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[item.status] || ''}`}>{item.status}</span></td>
                    <td className="px-4 py-3">
                      {item.status === 'draft' && (
                        <button onClick={() => approve(item.id)} disabled={busy === item.id} className="p-1 text-teal-400 hover:text-teal-300" title="Approve">
                          {busy === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
