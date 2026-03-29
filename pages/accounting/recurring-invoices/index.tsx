/**
 * Recurring Invoices Page
 * Phase 1 Sage Alignment: Manage recurring invoice templates
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Repeat, Plus, Pause, Play, XCircle, Zap, Loader2, Pencil, Save, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface RecurringInvoice {
  id: string; templateName: string; clientId: string; clientName?: string;
  frequency: string; nextRunDate: string; lastRunDate?: string; runCount: number;
  status: string; totalAmount: number;
}
interface Client { id: string; company_name: string }

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-teal-500/10 text-teal-400',
  paused: 'bg-yellow-500/10 text-yellow-400',
  completed: 'bg-blue-500/10 text-blue-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

export default function RecurringInvoicesPage() {
  const [items, setItems] = useState<RecurringInvoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editId, setEditId] = useState('');
  const [form, setForm] = useState({
    templateName: '', clientId: '', frequency: 'monthly',
    nextRunDate: '', description: '', lineDesc: '', lineQty: '1', linePrice: '',
  });

  const load = useCallback(async () => {
    const res = await apiFetch('/api/accounting/recurring-invoices', { credentials: 'include' });
    const json = await res.json();
    setItems(json.data?.items || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    apiFetch('/api/accounting/customers', { credentials: 'include' }).then(r => r.json()).then(res => {
      const d = res.data || res;
      setClients(Array.isArray(d) ? d : d.clients || []);
    });
  }, []);

  const doAction = async (action: string, id: string) => {
    setBusy(id);
    await apiFetch('/api/accounting/recurring-invoices-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ action, id }),
    });
    await load();
    setBusy('');
  };

  const startEdit = (item: RecurringInvoice) => {
    setEditId(item.id);
    setForm({
      templateName: item.templateName, clientId: item.clientId,
      frequency: item.frequency, nextRunDate: item.nextRunDate?.split('T')[0] || '',
      description: '', lineDesc: '', lineQty: '1', linePrice: '',
    });
    setShowForm(true);
  };

  const resetForm = () => {
    setEditId('');
    setShowForm(false);
    setForm({ templateName: '', clientId: '', frequency: 'monthly', nextRunDate: '', description: '', lineDesc: '', lineQty: '1', linePrice: '' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy('new');
    try {
      const method = editId ? 'PUT' : 'POST';
      const payload = editId
        ? { id: editId, templateName: form.templateName, frequency: form.frequency, nextRunDate: form.nextRunDate, description: form.description }
        : {
            templateName: form.templateName, clientId: form.clientId,
            frequency: form.frequency, nextRunDate: form.nextRunDate,
            description: form.description,
            lineItems: [{ description: form.lineDesc, quantity: Number(form.lineQty), unitPrice: Number(form.linePrice) }],
          };
      const res = await apiFetch('/api/accounting/recurring-invoices', {
        method, headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally { setBusy(''); }
  };

  const exportCSV = () => {
    const headers = ['Template', 'Client', 'Frequency', 'Next Run', 'Amount', 'Status', 'Run Count'];
    const rows = items.map(i => [i.templateName, i.clientName || '', i.frequency, i.nextRunDate?.split('T')[0] || '', i.totalAmount, i.status, i.runCount]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `recurring-invoices-${new Date().toISOString().split('T')[0]}.csv`; a.click();
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-500/10"><Repeat className="h-6 w-6 text-violet-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Recurring Invoices</h1>
            </div>
            <div className="flex items-center gap-2">
              {items.length > 0 && (
                <button onClick={exportCSV} className="inline-flex items-center gap-2 px-3 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-primary)] text-sm">
                  <Download className="h-4 w-4" /> CSV
                </button>
              )}
              <button onClick={() => { resetForm(); setShowForm(true); }} className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> New Template
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

          {showForm && (
            <form onSubmit={handleSubmit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">{editId ? 'Edit Recurring Invoice' : 'New Recurring Invoice'}</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <input value={form.templateName} onChange={e => setForm(f => ({ ...f, templateName: e.target.value }))} className="ff-input" placeholder="Template Name *" required />
                <select value={form.clientId} onChange={e => setForm(f => ({ ...f, clientId: e.target.value }))} className="ff-select" required>
                  <option value="">Select Client *</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                </select>
                <select value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))} className="ff-select">
                  <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option><option value="annually">Annually</option>
                </select>
                <input type="date" value={form.nextRunDate} onChange={e => setForm(f => ({ ...f, nextRunDate: e.target.value }))} className="ff-input" required />
                <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="ff-input" placeholder="Description" />
              </div>
              {!editId && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <input value={form.lineDesc} onChange={e => setForm(f => ({ ...f, lineDesc: e.target.value }))} className="ff-input" placeholder="Line Item Description *" required />
                  <input type="number" value={form.lineQty} onChange={e => setForm(f => ({ ...f, lineQty: e.target.value }))} className="ff-input" placeholder="Qty" min="1" />
                  <input type="number" step="0.01" value={form.linePrice} onChange={e => setForm(f => ({ ...f, linePrice: e.target.value }))} className="ff-input" placeholder="Unit Price *" required />
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={resetForm} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
                <button type="submit" disabled={busy === 'new'} className="px-6 py-2 bg-violet-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : editId ? <><Save className="h-4 w-4 inline mr-1" />Save</> : 'Create'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Template</th><th className="px-4 py-3">Client</th>
                <th className="px-4 py-3">Frequency</th><th className="px-4 py-3">Next Run</th>
                <th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && items.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No recurring invoices</td></tr>}
                {items.map(item => (
                  <tr key={item.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{item.templateName}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.clientName || '—'}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] capitalize">{item.frequency}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.nextRunDate?.split('T')[0]}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(item.totalAmount)}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[item.status] || ''}`}>{item.status}</span></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {item.status === 'active' && <>
                          <button onClick={() => doAction('pause', item.id)} disabled={busy === item.id} className="p-1 text-yellow-400 hover:text-yellow-300" title="Pause"><Pause className="h-4 w-4" /></button>
                          <button onClick={() => doAction('generate', item.id)} disabled={busy === item.id} className="p-1 text-teal-400 hover:text-teal-300" title="Generate Now"><Zap className="h-4 w-4" /></button>
                        </>}
                        {item.status === 'paused' && <button onClick={() => doAction('resume', item.id)} disabled={busy === item.id} className="p-1 text-teal-400 hover:text-teal-300" title="Resume"><Play className="h-4 w-4" /></button>}
                        {(item.status === 'active' || item.status === 'paused') && <>
                          <button onClick={() => startEdit(item)} disabled={busy === item.id} className="p-1 text-blue-400 hover:text-blue-300" title="Edit"><Pencil className="h-4 w-4" /></button>
                          <button onClick={() => doAction('cancel', item.id)} disabled={busy === item.id} className="p-1 text-red-400 hover:text-red-300" title="Cancel"><XCircle className="h-4 w-4" /></button>
                        </>}
                      </div>
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
