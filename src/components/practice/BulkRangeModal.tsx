/**
 * BulkRangeModal
 * Modal for filling a date range from a saved time-entry template.
 */

import { useState, useEffect } from 'react';
import { CalendarRange, Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { fetchEntryTemplates, type EntryTemplate } from './practiceApi';
import type { BulkFromTemplateInput, BulkFromTemplateResult } from '@/modules/accounting/services/practice/practiceTimeEntryWorkflow';

function todayIso() { return new Date().toISOString().slice(0, 10); }
function offsetDate(iso: string, d: number): string {
  const dt = new Date(iso); dt.setDate(dt.getDate() + d); return dt.toISOString().slice(0, 10);
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ErrorBanner({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertCircle className="h-4 w-4 shrink-0" /><span>{msg}</span>
    </div>
  );
}

export interface BulkRangeModalProps {
  onClose: () => void;
  onDone: (result: BulkFromTemplateResult) => void;
}

export function BulkRangeModal({ onClose, onDone }: BulkRangeModalProps) {
  const today = todayIso();
  const [templates, setTemplates] = useState<EntryTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(offsetDate(today, 7));
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [hoursOverride, setHoursOverride] = useState('');
  const [taskOverride, setTaskOverride] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // The endpoint replies `{ data: { templates } }` and always scopes to the
  // session user (the `?userId=` this used to send was ignored). Reading
  // `j.data` therefore yielded the WRAPPER OBJECT, not an array: `templates.map`
  // then threw and took the whole modal down. Go through the shared fetcher.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchEntryTemplates();
        if (cancelled) return;
        setTemplates(list);
        if (list[0]) setTemplateId(list[0].id);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load templates');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function toggleDay(d: number) {
    setWeekdays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort());
  }

  async function handleConfirm() {
    if (!templateId) { setError('Select a template first'); return; }
    setLoading(true); setError('');
    try {
      const body: BulkFromTemplateInput = { templateId, dateFrom, dateTo, weekdays };
      if (hoursOverride) body.hoursOverride = Number(hoursOverride);
      if (taskOverride.trim()) body.taskOverride = taskOverride.trim();
      const res = await apiFetch('/api/accounting/practice/time-entries/bulk', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { data?: BulkFromTemplateResult; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      onDone(json.data!);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk fill failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] shadow-2xl">
        <div className="px-6 py-4 border-b border-[var(--ff-border-primary)] flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-teal-400" />
          <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Fill Range from Template</h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && <ErrorBanner msg={error} />}
          <label className="block space-y-1">
            <span className="text-xs font-medium text-[var(--ff-text-secondary)]">Template</span>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-teal-500">
              {templates.length === 0 && <option value="">No templates — create one first</option>}
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-[var(--ff-text-secondary)]">From</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-teal-500" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-[var(--ff-text-secondary)]">To</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-teal-500" />
            </label>
          </div>
          <div className="space-y-1">
            <span className="text-xs font-medium text-[var(--ff-text-secondary)]">Weekdays</span>
            <div className="flex gap-1.5">
              {WEEKDAY_LABELS.map((label, d) => (
                <button key={d} type="button" onClick={() => toggleDay(d)} className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${weekdays.includes(d) ? 'bg-teal-600 text-white' : 'border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)]'}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-[var(--ff-text-secondary)]">Hours override</span>
              <input type="number" min="0.25" max="24" step="0.25" value={hoursOverride} onChange={(e) => setHoursOverride(e.target.value)} placeholder="from template" className="w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-teal-500 placeholder:text-[var(--ff-text-tertiary)]" />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-[var(--ff-text-secondary)]">Task override</span>
              <input type="text" value={taskOverride} onChange={(e) => setTaskOverride(e.target.value)} placeholder="from template" className="w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] text-[var(--ff-text-primary)] text-sm px-3 py-2 focus:outline-none focus:ring-1 focus:ring-teal-500 placeholder:text-[var(--ff-text-tertiary)]" />
            </label>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-[var(--ff-border-primary)] flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm transition-colors">Cancel</button>
          <button onClick={() => void handleConfirm()} disabled={loading || !templateId} className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium transition-colors">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarRange className="h-4 w-4" />}
            {loading ? 'Creating…' : 'Fill Range'}
          </button>
        </div>
      </div>
    </div>
  );
}
