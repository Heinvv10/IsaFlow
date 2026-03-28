/**
 * Customer Write-Offs Page
 * Phase 1 Sage Alignment: Bad debt write-off management
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { XCircle, Plus, Check, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface WriteOff {
  id: string; writeOffNumber: string; clientId: string; clientName?: string;
  invoiceId: string; invoiceNumber?: string; amount: number; reason: string;
  writeOffDate: string; status: string;
}
interface Client { id: string; company_name: string }
interface Invoice { id: string; invoice_number: string; total_amount: number; amount_paid: number }

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

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
  const [form, setForm] = useState({ clientId: '', invoiceId: '', amount: '', reason: '' });

  const load = useCallback(async () => {
    const res = await apiFetch('/api/accounting/write-offs', { credentials: 'include' });
    const json = await res.json();
    setItems(json.data?.items || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    apiFetch('/api/clients', { credentials: 'include' }).then(r => r.json()).then(res => {
      const d = res.data || res;
      setClients(Array.isArray(d) ? d : d.clients || []);
    });
  }, []);

  useEffect(() => {
    if (!form.clientId) { setInvoices([]); return; }
    apiFetch(`/api/customer-invoices?client_id=${form.clientId}&status=approved&status=sent&status=partially_paid&status=overdue`, { credentials: 'include' })
      .then(r => r.json()).then(res => {
        const d = res.data || res;
        const list = Array.isArray(d) ? d : d.invoices || [];
        setInvoices(list.filter((inv: Invoice) => Number(inv.total_amount) - Number(inv.amount_paid) > 0.01));
      });
  }, [form.clientId]);

  const selectedInv = invoices.find(i => i.id === form.invoiceId);
  const maxAmount = selectedInv ? Number(selectedInv.total_amount) - Number(selectedInv.amount_paid) : 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy('new');
    try {
      const res = await apiFetch('/api/accounting/write-offs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ clientId: form.clientId, invoiceId: form.invoiceId, amount: Number(form.amount), reason: form.reason }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setShowForm(false);
      setForm({ clientId: '', invoiceId: '', amount: '', reason: '' });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(''); }
  };

  const approve = async (id: string) => {
    setBusy(id);
    await apiFetch('/api/accounting/write-offs-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ action: 'approve', id }),
    });
    await load(); setBusy('');
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
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                </select>
                <select value={form.invoiceId} onChange={e => { setForm(f => ({ ...f, invoiceId: e.target.value })); const inv = invoices.find(i => i.id === e.target.value); if (inv) setForm(f => ({ ...f, invoiceId: e.target.value, amount: String(Number(inv.total_amount) - Number(inv.amount_paid)) })); }} className="ff-select" required>
                  <option value="">Select Invoice *</option>
                  {invoices.map(inv => <option key={inv.id} value={inv.id}>{inv.invoice_number} — Balance: {fmt(Number(inv.total_amount) - Number(inv.amount_paid))}</option>)}
                </select>
                <input type="number" step="0.01" min="0.01" max={maxAmount || undefined} value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} className="ff-input" placeholder="Amount *" required />
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
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.writeOffDate?.split('T')[0]}</td>
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
