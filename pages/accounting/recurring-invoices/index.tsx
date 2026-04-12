/**
 * Recurring Invoices — redesigned with ISAFlow design system
 */
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { RefreshCw, Plus, Pause, Play, XCircle, Zap, Loader2, Pencil, Download, Clock, CheckCircle, AlertCircle, X } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface RecurringInvoice {
  id: string; templateName: string; clientId: string; clientName?: string;
  frequency: string; nextRunDate: string; lastRunDate?: string; runCount: number;
  status: string; totalAmount: number; description?: string;
}
interface RunResult { generated: number; invoice_ids: string[]; errors: string[] }

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const isOverdue = (d: string | undefined): boolean => {
  if (!d) return false;
  return d.split('T')[0]! <= new Date().toISOString().split('T')[0]!;
};

const STATUS: Record<string, { label: string; cls: string }> = {
  active:    { label: 'Active',     cls: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' },
  paused:    { label: 'Paused',     cls: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' },
  completed: { label: 'Completed',  cls: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300' },
  cancelled: { label: 'Cancelled',  cls: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400' },
};

const TABS = ['all', 'active', 'paused', 'completed', 'cancelled'] as const;
type Tab = typeof TABS[number];

export default function RecurringInvoicesPage() {
  const [items, setItems] = useState<RecurringInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('all');
  const [busy, setBusy] = useState('');
  const [runAllBusy, setRunAllBusy] = useState(false);
  const [error, setError] = useState('');
  const [runResult, setRunResult] = useState<RunResult | null>(null);

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

  const filtered = tab === 'all' ? items : items.filter(i => i.status === tab);
  const dueCount = items.filter(i => i.status === 'active' && isOverdue(i.nextRunDate)).length;

  const doAction = async (action: string, id: string) => {
    setBusy(id); setError('');
    try {
      await apiFetch('/api/accounting/recurring-invoices-action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, id }),
      });
      await load();
    } catch (err) {
      log.error('Recurring invoice action failed', { action, id, error: err }, 'recurring-invoices-page');
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally { setBusy(''); }
  };

  const runOne = async (id: string) => {
    setBusy(id); setError(''); setRunResult(null);
    try {
      const res = await apiFetch('/api/accounting/recurring-invoices-run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recurring_invoice_id: id }),
      });
      const json = await res.json() as { data?: RunResult };
      if (!res.ok) throw new Error('Run failed');
      setRunResult(json.data ?? null);
      await load();
    } catch (err) {
      log.error('Run recurring invoice failed', { id, error: err }, 'recurring-invoices-page');
      setError(err instanceof Error ? err.message : 'Run failed');
    } finally { setBusy(''); }
  };

  const runAllDue = async () => {
    setRunAllBusy(true); setError(''); setRunResult(null);
    try {
      const res = await apiFetch('/api/accounting/recurring-invoices-run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json() as { data?: RunResult };
      if (!res.ok) throw new Error('Run All failed');
      setRunResult(json.data ?? null);
      await load();
    } catch (err) {
      log.error('Run all due recurring invoices failed', { error: err }, 'recurring-invoices-page');
      setError(err instanceof Error ? err.message : 'Run All failed');
    } finally { setRunAllBusy(false); }
  };

  const exportCSV = () => {
    const headers = ['Template', 'Client', 'Frequency', 'Next Run', 'Amount', 'Status', 'Run Count'];
    const rows = items.map(i => [i.templateName, i.clientName ?? '', i.frequency, i.nextRunDate?.split('T')[0] ?? '', i.totalAmount, i.status, i.runCount]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `recurring-invoices-${new Date().toISOString().split('T')[0]}.csv`; a.click();
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-8">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-1">Documents</p>
              <h1 className="text-2xl font-bold text-white">Recurring Invoices</h1>
              <p className="text-slate-400 text-sm mt-0.5">{items.length} {items.length === 1 ? 'template' : 'templates'}{dueCount > 0 && <span className="ml-2 px-2 py-0.5 bg-orange-500/20 text-orange-400 rounded-full text-xs font-medium">{dueCount} due</span>}</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => void runAllDue()} disabled={runAllBusy || dueCount === 0} className="inline-flex items-center gap-2 px-4 py-2.5 bg-orange-500 hover:bg-orange-400 text-white rounded-xl text-sm font-semibold transition-colors disabled:opacity-40 shadow-lg shadow-orange-500/25">
                {runAllBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                Run Due{dueCount > 0 ? ` (${dueCount})` : ''}
              </button>
              {items.length > 0 && (
                <button onClick={exportCSV} className="inline-flex items-center gap-2 px-3 py-2.5 bg-white/10 hover:bg-white/20 text-white rounded-xl text-sm font-medium transition-colors">
                  <Download className="h-4 w-4" /> CSV
                </button>
              )}
              <Link href="/accounting/recurring-invoices/new" className="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-white rounded-xl text-sm font-semibold transition-colors shadow-lg shadow-amber-500/25">
                <Plus className="w-4 h-4" /> New Template
              </Link>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="flex items-center justify-between p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-red-700 dark:text-red-400 text-sm">
              <span className="flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" />{error}</span>
              <button onClick={() => setError('')}><X className="h-4 w-4" /></button>
            </div>
          )}
          {runResult && (
            <div className={`flex items-start justify-between gap-2 p-3 rounded-xl border text-sm ${runResult.errors.length > 0 ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400' : 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400'}`}>
              <span className="flex items-center gap-2"><CheckCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />{runResult.generated} invoice{runResult.generated !== 1 ? 's' : ''} generated{runResult.errors.length > 0 ? ` (${runResult.errors.length} errors)` : ''}</span>
              <button onClick={() => setRunResult(null)}><X className="h-4 w-4" /></button>
            </div>
          )}

          <div className="flex items-center gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 w-fit">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${tab === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{t}</button>
            ))}
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {loading ? (
              <div className="p-16 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
            ) : filtered.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4">
                  <RefreshCw className="w-7 h-7 text-slate-400" />
                </div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No recurring invoices</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Set up your first recurring template</p>
                <Link href="/accounting/recurring-invoices/new" className="inline-block mt-5 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white text-sm font-semibold rounded-lg transition-colors">Create Template</Link>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['Template', 'Customer', 'Frequency', 'Next Run', 'Last Run', 'Amount', 'Status', ''].map((h, i) => (
                      <th key={i} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 5 ? 'text-right' : i === 7 ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filtered.map(item => {
                    const due = item.status === 'active' && isOverdue(item.nextRunDate);
                    const sc = STATUS[item.status];
                    return (
                      <tr key={item.id} className={`hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors ${due ? 'bg-orange-50/50 dark:bg-orange-900/5' : ''}`}>
                        <td className="px-5 py-3.5">
                          <div className="font-medium text-slate-900 dark:text-slate-100">{item.templateName}</div>
                          {item.description && <div className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{item.description}</div>}
                        </td>
                        <td className="px-5 py-3.5 text-slate-600 dark:text-slate-300">{item.clientName ?? '—'}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 capitalize">{item.frequency}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">
                          <span className="flex items-center gap-1.5">
                            {item.nextRunDate?.split('T')[0]}
                            {due && <span className="flex items-center gap-0.5 px-1.5 py-0.5 bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 rounded-full text-xs font-medium"><Clock className="h-3 w-3" />Due</span>}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{item.lastRunDate ? item.lastRunDate.split('T')[0] : '—'}</td>
                        <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 dark:text-white">{fmt(item.totalAmount)}</td>
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${sc?.cls ?? ''}`}>{sc?.label ?? item.status}</span>
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center justify-end gap-1">
                            {item.status === 'active' && (
                              <>
                                <button onClick={() => void runOne(item.id)} disabled={busy === item.id} title="Run Now" className="p-1.5 rounded-lg text-slate-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-40">
                                  {busy === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                                </button>
                                <button onClick={() => void doAction('pause', item.id)} disabled={busy === item.id} title="Pause" className="p-1.5 rounded-lg text-slate-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-40">
                                  <Pause className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                            {item.status === 'paused' && (
                              <button onClick={() => void doAction('resume', item.id)} disabled={busy === item.id} title="Resume" className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors disabled:opacity-40">
                                <Play className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {(item.status === 'active' || item.status === 'paused') && (
                              <>
                                <Link href={`/accounting/recurring-invoices/${item.id}`} title="Edit" className="p-1.5 rounded-lg text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                                  <Pencil className="h-3.5 w-3.5" />
                                </Link>
                                <button onClick={() => void doAction('cancel', item.id)} disabled={busy === item.id} title="Cancel" className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40">
                                  <XCircle className="h-3.5 w-3.5" />
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
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
