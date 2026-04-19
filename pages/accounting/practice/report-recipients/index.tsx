/**
 * Report Recipients Admin
 * Route: /accounting/practice/report-recipients
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Mail, Loader2, AlertCircle, Plus, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { ReportRecipient } from '@/modules/accounting/services/practice/practiceReportRecipientsService';

const INPUT = 'rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-500/40 w-full';
const TH = 'text-left py-2 px-3 text-[10px] tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2.5 px-3 text-sm text-[var(--ff-text-secondary)]';

interface FormState { email: string; name: string; monthlySummary: boolean; }
const EMPTY_FORM: FormState = { email: '', name: '', monthlySummary: true };

export default function ReportRecipientsPage() {
  const [recipients, setRecipients] = useState<ReportRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/practice/report-recipients');
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const json = await res.json() as { data?: ReportRecipient[] } | ReportRecipient[];
      setRecipients(Array.isArray(json) ? json : ((json as { data?: ReportRecipient[] }).data ?? []));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  async function handleAdd() {
    if (!form.email.trim()) { setAddError('Email is required'); return; }
    setAdding(true);
    setAddError(null);
    try {
      const res = await apiFetch('/api/accounting/practice/report-recipients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email.trim(),
          name: form.name.trim() || null,
          reportTypes: form.monthlySummary ? ['monthly_summary'] : [],
        }),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setForm(EMPTY_FORM);
      await loadData();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Failed to add');
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(r: ReportRecipient) {
    setActionId(r.id);
    try {
      const res = await apiFetch(`/api/accounting/practice/report-recipients/${encodeURIComponent(r.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !r.isActive }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed');
    } finally {
      setActionId(null);
    }
  }

  async function handleDelete(id: string) {
    setActionId(id);
    try {
      const res = await apiFetch(`/api/accounting/practice/report-recipients/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setActionId(null);
    }
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Mail className="h-5 w-5 text-teal-400" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Report Recipients</h1>
              <p className="text-xs text-[var(--ff-text-tertiary)]">Manage who receives monthly practice management report emails</p>
            </div>
          </div>
        </div>

        <div className="px-6 py-6 max-w-4xl space-y-6">
          {/* Add form */}
          <div className="p-4 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Add recipient</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Email *</label>
                <input type="email" className={INPUT} value={form.email}
                  onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                  placeholder="name@company.co.za" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Name</label>
                <input type="text" className={INPUT} value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Optional display name" />
              </div>
              <div className="flex flex-col gap-1 justify-end">
                <label className="text-xs font-medium text-[var(--ff-text-secondary)]">Report types</label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.monthlySummary}
                    onChange={(e) => setForm((p) => ({ ...p, monthlySummary: e.target.checked }))}
                    className="h-4 w-4 rounded border-[var(--ff-border-primary)] accent-teal-500" />
                  <span className="text-sm text-[var(--ff-text-secondary)]">Monthly summary</span>
                </label>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleAdd()}
                disabled={adding}
                className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add recipient
              </button>
            </div>
            {addError && (
              <p className="flex items-center gap-1 text-sm text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />{addError}
              </p>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12 gap-2 text-[var(--ff-text-tertiary)] text-sm">
              <Loader2 className="h-5 w-5 animate-spin" />Loading…
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] overflow-x-auto">
              <table className="table-auto w-full">
                <thead>
                  <tr className="bg-slate-50/5">
                    <th className={TH}>Email</th>
                    <th className={TH}>Name</th>
                    <th className={TH}>Report types</th>
                    <th className={TH}>Active</th>
                    <th className={TH}></th>
                  </tr>
                </thead>
                <tbody>
                  {recipients.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-[var(--ff-text-tertiary)] text-sm">
                        No recipients configured yet.
                      </td>
                    </tr>
                  ) : recipients.map((r, i) => (
                    <tr key={r.id} className={i % 2 === 1 ? 'bg-slate-50/5' : ''}>
                      <td className={`${TD} font-medium text-[var(--ff-text-primary)]`}>{r.email}</td>
                      <td className={TD}>{r.name ?? '—'}</td>
                      <td className={TD}>{r.reportTypes.join(', ') || '—'}</td>
                      <td className={TD}>
                        <button
                          type="button"
                          onClick={() => void handleToggle(r)}
                          disabled={actionId === r.id}
                          className="p-1 rounded hover:bg-teal-500/10 text-[var(--ff-text-tertiary)] hover:text-teal-400 transition-colors disabled:opacity-50"
                          title={r.isActive ? 'Deactivate' : 'Activate'}
                        >
                          {actionId === r.id
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : r.isActive
                              ? <ToggleRight className="h-5 w-5 text-teal-400" />
                              : <ToggleLeft className="h-5 w-5" />}
                        </button>
                      </td>
                      <td className={TD}>
                        <button
                          type="button"
                          onClick={() => void handleDelete(r.id)}
                          disabled={actionId === r.id}
                          className="p-1 rounded hover:bg-red-500/10 text-[var(--ff-text-tertiary)] hover:text-red-400 transition-colors disabled:opacity-50"
                          title="Delete"
                        >
                          {actionId === r.id
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Trash2 className="h-4 w-4" />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
