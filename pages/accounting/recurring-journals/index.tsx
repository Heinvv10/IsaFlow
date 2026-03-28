/**
 * Recurring Journals Page
 * Phase 1 Sage Alignment: Manage recurring journal entry templates
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { RotateCcw, Plus, Pause, Play, XCircle, Zap, Loader2, Trash2, Pencil, Save, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface RecurringJournal {
  id: string; templateName: string; description?: string; frequency: string;
  nextRunDate: string; lastRunDate?: string; runCount: number; status: string;
  totalAmount: number; lines: Line[];
}
interface Line { glAccountId: string; debit: number; credit: number; description?: string }
interface Account { id: string; accountCode: string; accountName: string }

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_BADGE: Record<string, string> = {
  active: 'bg-teal-500/10 text-teal-400',
  paused: 'bg-yellow-500/10 text-yellow-400',
  completed: 'bg-blue-500/10 text-blue-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

export default function RecurringJournalsPage() {
  const [items, setItems] = useState<RecurringJournal[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [editId, setEditId] = useState('');
  const [form, setForm] = useState({ templateName: '', description: '', frequency: 'monthly', nextRunDate: '' });
  const [statusFilter, setStatusFilter] = useState('');
  const [formLines, setFormLines] = useState([{ key: crypto.randomUUID(), glAccountId: '', debit: 0, credit: 0, description: '' }]);

  const load = useCallback(async () => {
    const res = await apiFetch('/api/accounting/recurring-journals', { credentials: 'include' });
    const json = await res.json();
    setItems(json.data?.items || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' }).then(r => r.json()).then(res => {
      const d = res.data || res;
      const list = Array.isArray(d) ? d : d.accounts || d.items || [];
      setAccounts(list.map((a: Record<string, unknown>) => ({
        id: String(a.id), accountCode: String(a.accountCode || a.account_code || ''),
        accountName: String(a.accountName || a.account_name || ''),
      })));
    });
  }, []);

  const totalDebit = formLines.reduce((s, l) => s + (l.debit || 0), 0);
  const totalCredit = formLines.reduce((s, l) => s + (l.credit || 0), 0);

  const doAction = async (action: string, id: string) => {
    setBusy(id);
    await apiFetch('/api/accounting/recurring-journals-action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ action, id }),
    });
    await load(); setBusy('');
  };

  const startEdit = (item: RecurringJournal) => {
    setEditId(item.id);
    setForm({ templateName: item.templateName, description: item.description || '', frequency: item.frequency, nextRunDate: item.nextRunDate?.split('T')[0] || '' });
    setShowForm(true);
  };

  const resetForm = () => {
    setEditId('');
    setShowForm(false);
    setForm({ templateName: '', description: '', frequency: 'monthly', nextRunDate: '' });
    setFormLines([{ key: crypto.randomUUID(), glAccountId: '', debit: 0, credit: 0, description: '' }]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!editId && Math.abs(totalDebit - totalCredit) > 0.01) { setError('Lines must balance (DR = CR)'); return; }
    setBusy('new');
    try {
      const method = editId ? 'PUT' : 'POST';
      const payload = editId
        ? { id: editId, templateName: form.templateName, description: form.description, frequency: form.frequency, nextRunDate: form.nextRunDate }
        : {
            templateName: form.templateName, description: form.description,
            frequency: form.frequency, nextRunDate: form.nextRunDate,
            lines: formLines.filter(l => l.glAccountId && (l.debit > 0 || l.credit > 0)).map(l => ({
              glAccountId: l.glAccountId, debit: l.debit || 0, credit: l.credit || 0, description: l.description,
            })),
          };
      const res = await apiFetch('/api/accounting/recurring-journals', {
        method, headers: { 'Content-Type': 'application/json' },
        credentials: 'include', body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      resetForm();
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setBusy(''); }
  };

  const filteredItems = items.filter(i => !statusFilter || i.status === statusFilter);

  const exportCSV = () => {
    const headers = ['Template', 'Frequency', 'Next Run', 'Amount', 'Runs', 'Status'];
    const rows = items.map(i => [i.templateName, i.frequency, i.nextRunDate?.split('T')[0] || '', i.totalAmount, i.runCount, i.status]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `recurring-journals-${new Date().toISOString().split('T')[0]}.csv`; a.click();
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><RotateCcw className="h-6 w-6 text-teal-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Recurring Journals</h1>
            </div>
            <div className="flex items-center gap-2">
              {items.length > 0 && (
                <button onClick={exportCSV} className="inline-flex items-center gap-2 px-3 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-primary)] text-sm">
                  <Download className="h-4 w-4" /> CSV
                </button>
              )}
              <button onClick={() => { resetForm(); setShowForm(true); }} className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> New Template
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

          <div className="flex items-center gap-3">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="ff-select text-sm">
              <option value="">All Statuses</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <span className="text-sm text-[var(--ff-text-secondary)]">{filteredItems.length} templates</span>
          </div>

          {showForm && (
            <form onSubmit={handleSubmit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">{editId ? 'Edit Recurring Journal' : 'New Recurring Journal'}</h2>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <input value={form.templateName} onChange={e => setForm(f => ({ ...f, templateName: e.target.value }))} className="ff-input" placeholder="Template Name *" required />
                <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="ff-input" placeholder="Description" />
                <select value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))} className="ff-select">
                  <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option><option value="annually">Annually</option>
                </select>
                <input type="date" value={form.nextRunDate} onChange={e => setForm(f => ({ ...f, nextRunDate: e.target.value }))} className="ff-input" required />
              </div>
              {!editId && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-[var(--ff-text-secondary)]">Journal Lines</span>
                    <button type="button" onClick={() => setFormLines(p => [...p, { key: crypto.randomUUID(), glAccountId: '', debit: 0, credit: 0, description: '' }])} className="text-sm text-teal-500 hover:text-teal-400 flex items-center gap-1"><Plus className="h-3 w-3" /> Add Line</button>
                  </div>
                  {formLines.map(line => (
                    <div key={line.key} className="flex items-center gap-2">
                      <select value={line.glAccountId} onChange={e => setFormLines(p => p.map(l => l.key === line.key ? { ...l, glAccountId: e.target.value } : l))} className="ff-select flex-1">
                        <option value="">Account *</option>
                        {accounts.map(a => <option key={a.id} value={a.id}>{a.accountCode} — {a.accountName}</option>)}
                      </select>
                      <input type="number" step="0.01" min="0" value={line.debit || ''} onChange={e => setFormLines(p => p.map(l => l.key === line.key ? { ...l, debit: Number(e.target.value), credit: 0 } : l))} className="ff-input w-28" placeholder="Debit" />
                      <input type="number" step="0.01" min="0" value={line.credit || ''} onChange={e => setFormLines(p => p.map(l => l.key === line.key ? { ...l, credit: Number(e.target.value), debit: 0 } : l))} className="ff-input w-28" placeholder="Credit" />
                      <input value={line.description} onChange={e => setFormLines(p => p.map(l => l.key === line.key ? { ...l, description: e.target.value } : l))} className="ff-input w-40" placeholder="Desc" />
                      {formLines.length > 1 && <button type="button" onClick={() => setFormLines(p => p.filter(l => l.key !== line.key))} className="p-1 text-red-400"><Trash2 className="h-4 w-4" /></button>}
                    </div>
                  ))}
                  <div className="flex justify-end gap-4 text-sm">
                    <span className="text-[var(--ff-text-secondary)]">DR: {fmt(totalDebit)}</span>
                    <span className="text-[var(--ff-text-secondary)]">CR: {fmt(totalCredit)}</span>
                    <span className={Math.abs(totalDebit - totalCredit) < 0.01 ? 'text-teal-400' : 'text-red-400'}>
                      Diff: {fmt(totalDebit - totalCredit)}
                    </span>
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={resetForm} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
                <button type="submit" disabled={busy === 'new'} className="px-6 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                  {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" /> : editId ? <><Save className="h-4 w-4 inline mr-1" />Save</> : 'Create'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Template</th><th className="px-4 py-3">Frequency</th>
                <th className="px-4 py-3">Next Run</th><th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Runs</th><th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">Loading...</td></tr>}
                {!loading && filteredItems.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">{statusFilter ? 'No matching journals' : 'No recurring journals'}</td></tr>}
                {filteredItems.map(item => (
                  <tr key={item.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{item.templateName}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] capitalize">{item.frequency}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.nextRunDate?.split('T')[0]}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(item.totalAmount)}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.runCount}</td>
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
