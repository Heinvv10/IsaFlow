/**
 * Day-View Time Entry Page
 * Route: /accounting/practice/time-entry
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Clock, Loader2, AlertCircle, ChevronLeft, ChevronRight, Trash2, Send, CalendarRange } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { useAuth } from '@/contexts/AuthContext';
import { TimeEntryForm, type Client, type Category } from '@/components/practice/TimeEntryForm';
import { DayTotalsBar } from '@/components/practice/DayTotalsBar';
import { BulkRangeModal } from '@/components/practice/BulkRangeModal';
import type { PracticeTimeEntry, PracticeTimeEntryInput } from '@/modules/accounting/services/practice/practiceTimeEntryTypes';
import type { BulkFromTemplateResult } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';

// ---------- helpers ----------

function todayIso() { return new Date().toISOString().slice(0, 10); }
function offsetDate(iso: string, d: number): string {
  const dt = new Date(iso); dt.setDate(dt.getDate() + d); return dt.toISOString().slice(0, 10);
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-ZA', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

const STATUS_CLS: Record<PracticeTimeEntry['status'], string> = {
  draft: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]',
  submitted: 'bg-blue-500/20 text-blue-400',
  approved: 'bg-teal-500/20 text-teal-400',
  billed: 'bg-purple-500/20 text-purple-400',
  not_billable: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]',
  leave: 'bg-yellow-500/20 text-yellow-400',
  invoiced: 'bg-green-500/20 text-green-400',
};

const TH_CLS = 'text-left py-2 px-4 text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD_CLS = 'py-2.5 px-4 text-[var(--ff-text-secondary)]';

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" /><span>{msg}</span>
    </div>
  );
}

// ---------- page ----------

export default function TimeEntryPage() {
  const { user } = useAuth();
  const [selectedDate, setSelectedDate] = useState(todayIso);
  const [clients, setClients] = useState<Client[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [initLoading, setInitLoading] = useState(true);
  const [initError, setInitError] = useState('');
  const [entries, setEntries] = useState<PracticeTimeEntry[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkFromTemplateResult | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [cr, catr] = await Promise.all([
          apiFetch('/api/accounting/practice/clients?status=active'),
          apiFetch('/api/accounting/practice/job-categories?isActive=true'),
        ]);
        if (!cr.ok || !catr.ok) throw new Error('Failed to load reference data');
        const cj = (await cr.json()) as { data?: Client[] } | Client[];
        const catj = (await catr.json()) as { data?: Category[]; categories?: Category[] } | Category[];
        setClients(Array.isArray(cj) ? cj : (cj.data ?? []));
        const catArr = Array.isArray(catj) ? catj
          : ((catj as { categories?: Category[] }).categories ?? (catj as { data?: Category[] }).data ?? []);
        setCategories(catArr);
      } catch { setInitError('Failed to load clients or categories. Please refresh.'); }
      finally { setInitLoading(false); }
    })();
  }, []);

  const reloadEntries = useCallback(async () => {
    if (!user?.id) return;
    setEntriesLoading(true); setEntriesError('');
    try {
      const res = await apiFetch(
        `/api/accounting/practice/time-entries?userId=${user.id}&dateFrom=${selectedDate}&dateTo=${selectedDate}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: { entries?: PracticeTimeEntry[] }; entries?: PracticeTimeEntry[] } | PracticeTimeEntry[];
      let list: PracticeTimeEntry[];
      if (Array.isArray(json)) list = json;
      else if ('data' in json && json.data && 'entries' in json.data) list = json.data.entries ?? [];
      else if ('entries' in json) list = (json as { entries?: PracticeTimeEntry[] }).entries ?? [];
      else list = [];
      setEntries(list);
    } catch { setEntriesError('Failed to load entries for this day.'); }
    finally { setEntriesLoading(false); }
  }, [user?.id, selectedDate]);

  useEffect(() => { void reloadEntries(); }, [reloadEntries]);

  async function handleCreate(input: PracticeTimeEntryInput): Promise<void> {
    const res = await apiFetch('/api/accounting/practice/time-entries', { method: 'POST', body: JSON.stringify(input) });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error ?? `HTTP ${res.status}`);
    }
    await reloadEntries();
  }

  async function handleDelete(id: string) {
    setDeletingId(id); setActionError('');
    try {
      const res = await apiFetch(`/api/accounting/practice/time-entries/${id}`, { method: 'DELETE' });
      if (!res.ok) { const e = (await res.json().catch(() => ({}))) as { error?: string }; throw new Error(e.error ?? `HTTP ${res.status}`); }
      await reloadEntries();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Delete failed'); }
    finally { setDeletingId(null); }
  }

  async function handleSubmitDay() {
    const draftIds = entries.filter((e) => e.status === 'draft').map((e) => e.id);
    if (!draftIds.length) return;
    setSubmitting(true); setActionError('');
    try {
      const res = await apiFetch('/api/accounting/practice/time-entries/submit', { method: 'POST', body: JSON.stringify({ ids: draftIds }) });
      if (!res.ok) { const e = (await res.json().catch(() => ({}))) as { error?: string }; throw new Error(e.error ?? `HTTP ${res.status}`); }
      await reloadEntries();
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Submit failed'); }
    finally { setSubmitting(false); }
  }

  const draftCount = entries.filter((e) => e.status === 'draft').length;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10"><Clock className="h-5 w-5 text-teal-400" /></div>
            <div>
              <h1 className="text-lg font-semibold text-[var(--ff-text-primary)]">Time Entry</h1>
              <p className="text-xs text-[var(--ff-text-tertiary)]">Log and submit daily time</p>
            </div>
          </div>
        </div>

        <div className="px-6 py-6 space-y-6 max-w-5xl">
          {initError && <ErrorBanner msg={initError} />}
          {actionError && <ErrorBanner msg={actionError} />}
          {bulkResult && (
            <div className="p-3 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-300 text-sm space-y-1">
              <span>Bulk fill: created {bulkResult.created}, skipped {bulkResult.skipped}, failed {bulkResult.failed.length}</span>
              {bulkResult.failed.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-red-400">
                  {bulkResult.failed.map((f) => <li key={f.date}>{f.date}: {f.error}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Day nav */}
          <div className="flex items-center gap-2">
            <button onClick={() => setSelectedDate((d) => offsetDate(d, -1))} className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"><ChevronLeft className="h-5 w-5" /></button>
            <span className="text-sm font-medium text-[var(--ff-text-primary)] min-w-[210px] text-center">{fmtDate(selectedDate)}</span>
            <button onClick={() => setSelectedDate((d) => offsetDate(d, 1))} className="p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors"><ChevronRight className="h-5 w-5" /></button>
            <button onClick={() => setSelectedDate(todayIso())} className="ml-2 px-3 py-1.5 rounded-lg text-xs font-medium border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] transition-colors">Today</button>
          </div>

          {/* Totals */}
          <DayTotalsBar entries={entries.map((e) => ({ hours: e.hours, billable: e.billable, lineTotal: e.lineTotal }))} />

          {/* Form */}
          {initLoading ? (
            <div className="flex items-center gap-2 py-4 text-[var(--ff-text-tertiary)] text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading form…</div>
          ) : !initError && user?.id ? (
            <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] p-5">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Add Entry</h2>
              <TimeEntryForm clients={clients} categories={categories} defaultDate={selectedDate} currentUserId={user.id} onSubmit={handleCreate} />
            </div>
          ) : null}

          {/* Entries list */}
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Entries for {fmtDate(selectedDate)}</h2>
            {entriesLoading ? (
              <div className="flex items-center gap-2 py-6 text-[var(--ff-text-tertiary)] text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
            ) : entriesError ? (
              <ErrorBanner msg={entriesError} />
            ) : entries.length === 0 ? (
              <p className="text-sm text-[var(--ff-text-tertiary)] py-4">No entries logged for this day.</p>
            ) : (
              <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                      <th className={TH_CLS}>Status</th><th className={TH_CLS}>Hours</th>
                      <th className={TH_CLS}>Client</th><th className={TH_CLS}>Category / Work Item</th>
                      <th className={TH_CLS}>Description</th><th className="py-2 px-4 w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                        <td className={TD_CLS}><span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLS[e.status]}`}>{e.status}</span></td>
                        <td className="py-2.5 px-4 font-mono text-[var(--ff-text-primary)]">{e.hours.toFixed(2)}h</td>
                        <td className={TD_CLS}>{e.practiceClientName ?? '—'}</td>
                        <td className={TD_CLS}>{e.jobCategoryName ?? '—'}{e.workItemName && <span className="text-[var(--ff-text-tertiary)]"> / {e.workItemName}</span>}</td>
                        <td className={`${TD_CLS} max-w-xs truncate`}>{e.taskDescription}</td>
                        <td className="py-2.5 px-4">
                          {e.status === 'draft' && (
                            <button onClick={() => void handleDelete(e.id)} disabled={deletingId === e.id} className="p-1 rounded text-[var(--ff-text-tertiary)] hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50" title="Delete">
                              {deletingId === e.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Submit footer */}
          <div className="flex items-center gap-3 pt-2 border-t border-[var(--ff-border-primary)]">
            <button onClick={() => void handleSubmitDay()} disabled={draftCount === 0 || submitting} className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {submitting ? 'Submitting…' : `Submit Day${draftCount > 0 ? ` (${draftCount} draft${draftCount !== 1 ? 's' : ''})` : ''}`}
            </button>
            <button onClick={() => { setBulkResult(null); setShowBulk(true); }} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium transition-colors">
              <CalendarRange className="h-4 w-4" />Fill Range
            </button>
            {draftCount === 0 && !submitting && entries.length > 0 && (
              <span className="text-sm text-[var(--ff-text-tertiary)]">No draft entries to submit.</span>
            )}
          </div>
        </div>
      </div>

      {showBulk && user?.id && (
        <BulkRangeModal
          userId={user.id}
          onClose={() => setShowBulk(false)}
          onDone={(r) => { setBulkResult(r); setShowBulk(false); void reloadEntries(); }}
        />
      )}
    </AppLayout>
  );
}
