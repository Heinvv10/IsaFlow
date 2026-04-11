/**
 * Recurring Invoices Page
 * Phase 1 Sage Alignment: Manage recurring invoice templates
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { Repeat, Plus, Pause, Play, XCircle, Zap, Loader2, Pencil, Save, Download, Clock, CheckCircle, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface RecurringInvoice {
  id: string; templateName: string; clientId: string; clientName?: string;
  frequency: string; nextRunDate: string; lastRunDate?: string; runCount: number;
  status: string; totalAmount: number; description?: string;
}
interface Client { id: string; company_name: string }
interface RunResult { generated: number; invoice_ids: string[]; errors: string[] }

const isOverdue = (d: string | undefined): boolean => {
  if (!d) return false;
  return d.split('T')[0]! <= new Date().toISOString().split('T')[0]!;
};

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
  const [runAllBusy, setRunAllBusy] = useState(false);
  const [error, setError] = useState('');
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [editId, setEditId] = useState('');
  const [form, setForm] = useState({
    templateName: '', clientId: '', frequency: 'monthly',
    nextRunDate: '', description: '', lineDesc: '', lineQty: '1', linePrice: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/accounting/recurring-invoices');
      const json = await res.json() as { data?: { items?: RecurringInvoice[] } };
      setItems(json.data?.items ?? []);
    } catch (err) {
      log.error('Failed to load recurring invoices', { error: err }, 'recurring-invoices-page');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    apiFetch('/api/accounting/customers').then(r => r.json()).then((res: { data?: unknown }) => {
      const d = res.data;
      setClients(Array.isArray(d) ? (d as Client[]) : ((d as { clients?: Client[] })?.clients ?? []));
    }).catch(err => {
      log.error('Failed to load customers', { error: err }, 'recurring-invoices-page');
    });
  }, []);

  const doAction = async (action: string, id: string) => {
    setBusy(id);
    setError('');
    try {
      await apiFetch('/api/accounting/recurring-invoices-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
      await load();
    } catch (err) {
      log.error('Recurring invoice action failed', { action, id, error: err }, 'recurring-invoices-page');
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy('');
    }
  };

  const runOne = async (id: string) => {
    setBusy(id);
    setError('');
    setRunResult(null);
    try {
      const res = await apiFetch('/api/accounting/recurring-invoices-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recurring_invoice_id: id }),
      });
      const json = await res.json() as { data?: RunResult };
      if (!res.ok) throw new Error('Run failed');
      setRunResult(json.data ?? null);
      await load();
    } catch (err) {
      log.error('Run recurring invoice failed', { id, error: err }, 'recurring-invoices-page');
      setError(err instanceof Error ? err.message : 'Run failed');
    } finally {
      setBusy('');
    }
  };

  const runAllDue = async () => {
    setRunAllBusy(true);
    setError('');
    setRunResult(null);
    try {
      const res = await apiFetch('/api/accounting/recurring-invoices-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json() as { data?: RunResult };
      if (!res.ok) throw new Error('Run All failed');
      setRunResult(json.data ?? null);
      await load();
    } catch (err) {
      log.error('Run all due recurring invoices failed', { error: err }, 'recurring-invoices-page');
      setError(err instanceof Error ? err.message : 'Run All failed');
    } finally {
      setRunAllBusy(false);
    }
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
        method,
        body: JSON.stringify(payload),
      });
      const json = await res.json() as { error?: { message?: string }; message?: string };
      if (!res.ok) throw new Error(json.error?.message ?? json.message ?? 'Failed');
      resetForm();
      await load();
    } catch (err) {
      log.error('Save recurring invoice failed', { error: err }, 'recurring-invoices-page');
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
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Recurring Invoices</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Automate repeating customer invoices
                  {items.filter(i => i.status === 'active' && isOverdue(i.nextRunDate)).length > 0 && (
                    <span className="ml-2 px-2 py-0.5 bg-orange-500/20 text-orange-400 rounded-full text-xs font-medium">
                      {items.filter(i => i.status === 'active' && isOverdue(i.nextRunDate)).length} due
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {(() => {
                const dueCount = items.filter(i => i.status === 'active' && isOverdue(i.nextRunDate)).length;
                return (
                  <button
                    onClick={() => void runAllDue()}
                    disabled={runAllBusy || dueCount === 0}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-sm font-medium disabled:opacity-50"
                  >
                    {runAllBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                    Run All Due{dueCount > 0 ? ` (${dueCount})` : ''}
                  </button>
                );
              })()}
              {items.length > 0 && (
                <button onClick={exportCSV} className="inline-flex items-center gap-2 px-3 py-2 border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] rounded-lg hover:bg-[var(--ff-bg-primary)] text-sm">
                  <Download className="h-4 w-4" /> CSV
                </button>
              )}
              <Link href="/accounting/recurring-invoices/new" className="inline-flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> New Recurring Invoice
              </Link>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
            </div>
          )}
          {runResult && (
            <div className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${runResult.errors.length > 0 ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400' : 'bg-teal-500/10 border-teal-500/30 text-teal-400'}`}>
              <CheckCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">{runResult.generated} invoice{runResult.generated !== 1 ? 's' : ''} generated</p>
                {runResult.errors.map((e, i) => <p key={i} className="text-xs mt-0.5">{e}</p>)}
              </div>
            </div>
          )}

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
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)] text-xs">
                <th className="px-4 py-3">Template</th><th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Frequency</th><th className="px-4 py-3">Next Run</th>
                <th className="px-4 py-3">Last Run</th>
                <th className="px-4 py-3 text-right">Amount</th><th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-secondary)]"><Loader2 className="h-5 w-5 animate-spin mx-auto text-violet-500" /></td></tr>}
                {!loading && items.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-12 text-center">
                    <Repeat className="h-10 w-10 mx-auto mb-2 opacity-20 text-[var(--ff-text-secondary)]" />
                    <p className="text-[var(--ff-text-secondary)] text-sm">No recurring invoices</p>
                    <Link href="/accounting/recurring-invoices/new" className="text-violet-400 hover:underline text-xs mt-1 inline-block">Create your first template</Link>
                  </td></tr>
                )}
                {items.map(item => {
                  const due = item.status === 'active' && isOverdue(item.nextRunDate);
                  return (
                    <tr key={item.id} className={`border-b border-[var(--ff-border-light)] last:border-0 hover:bg-[var(--ff-bg-primary)] transition-colors ${due ? 'bg-orange-500/5' : ''}`}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-[var(--ff-text-primary)]">{item.templateName}</div>
                        {item.description && <div className="text-xs text-[var(--ff-text-secondary)] mt-0.5">{item.description}</div>}
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.clientName ?? '—'}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)] capitalize">{item.frequency}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                        <span className="flex items-center gap-1.5">
                          {item.nextRunDate?.split('T')[0]}
                          {due && (
                            <span className="flex items-center gap-0.5 text-xs px-1.5 py-0.5 bg-orange-500/20 text-orange-400 rounded-full font-medium">
                              <Clock className="h-3 w-3" /> Due
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{item.lastRunDate ? item.lastRunDate.split('T')[0] : '—'}</td>
                      <td className="px-4 py-3 text-right font-medium text-[var(--ff-text-primary)]">{fmt(item.totalAmount)}</td>
                      <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_BADGE[item.status] ?? ''}`}>{item.status}</span></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {item.status === 'active' && (
                            <>
                              <button onClick={() => void runOne(item.id)} disabled={busy === item.id} title="Run Now"
                                className="p-1.5 text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 rounded-lg transition-colors disabled:opacity-40">
                                {busy === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                              </button>
                              <button onClick={() => void doAction('pause', item.id)} disabled={busy === item.id} title="Pause"
                                className="p-1.5 text-yellow-400 hover:text-yellow-300 hover:bg-yellow-500/10 rounded-lg transition-colors disabled:opacity-40">
                                <Pause className="h-4 w-4" />
                              </button>
                            </>
                          )}
                          {item.status === 'paused' && (
                            <button onClick={() => void doAction('resume', item.id)} disabled={busy === item.id} title="Resume"
                              className="p-1.5 text-teal-400 hover:text-teal-300 hover:bg-teal-500/10 rounded-lg transition-colors disabled:opacity-40">
                              <Play className="h-4 w-4" />
                            </button>
                          )}
                          {(item.status === 'active' || item.status === 'paused') && (
                            <>
                              <Link href={`/accounting/recurring-invoices/${item.id}`} title="Edit"
                                className="p-1.5 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 rounded-lg transition-colors">
                                <Pencil className="h-4 w-4" />
                              </Link>
                              <button onClick={() => void doAction('cancel', item.id)} disabled={busy === item.id} title="Cancel"
                                className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-40">
                                <XCircle className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
