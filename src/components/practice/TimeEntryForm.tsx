/**
 * TimeEntryForm — cascading client → category → work item form with rate preview.
 * Used by the day-view time entry page (Task 6).
 */

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Save, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { PracticeTimeEntryInput } from '@/modules/accounting/services/practice/practiceTimeEntryTypes';

export interface Client {
  id: string;
  legalName: string;
  tradingName?: string | null;
}

export interface Category {
  id: string;
  name: string;
}

export interface WorkItem {
  id: string;
  name: string;
  categoryId: string;
}

export interface TimeEntryFormProps {
  clients: Client[];
  categories: Category[];
  defaultDate: string;
  currentUserId: string;
  onSubmit: (input: PracticeTimeEntryInput) => Promise<void>;
  onCancel?: () => void;
}

type RatePreview = number | 'loading' | 'none' | null;

const INPUT_CLS =
  'w-full py-2 px-3 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50';

const LABEL_CLS = 'block text-sm font-medium text-[var(--ff-text-primary)] mb-1.5';

export function TimeEntryForm({
  clients,
  categories,
  defaultDate,
  currentUserId,
  onSubmit,
  onCancel,
}: TimeEntryFormProps) {
  const [entryDate, setEntryDate] = useState(defaultDate);
  const [hours, setHours] = useState('');
  const [practiceClientId, setPracticeClientId] = useState('');
  const [jobCategoryId, setJobCategoryId] = useState('');
  const [workItemId, setWorkItemId] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [notes, setNotes] = useState('');
  const [billable, setBillable] = useState(true);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [ratePreview, setRatePreview] = useState<RatePreview>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Load work items when category changes
  useEffect(() => {
    setWorkItemId('');
    setWorkItems([]);
    if (!jobCategoryId) return;

    void (async () => {
      try {
        const res = await apiFetch(
          `/api/accounting/practice/work-items?categoryId=${jobCategoryId}&isActive=true`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as { workItems?: WorkItem[] } | WorkItem[];
        const items = Array.isArray(json) ? json : (json.workItems ?? []);
        setWorkItems(items);
      } catch {
        // Leave workItems empty — user can still type
      }
    })();
  }, [jobCategoryId]);

  // Resolve rate preview when client + date + user are all set
  const resolveRate = useCallback(async () => {
    if (!practiceClientId || !entryDate || !currentUserId) {
      setRatePreview(null);
      return;
    }
    setRatePreview('loading');
    try {
      const res = await apiFetch(
        `/api/accounting/practice/rate-resolve?userId=${currentUserId}&clientId=${practiceClientId}&date=${entryDate}`,
      );
      if (res.status === 404) {
        setRatePreview('none');
        return;
      }
      if (!res.ok) {
        setRatePreview(null);
        return;
      }
      const json = (await res.json()) as { rate: number };
      setRatePreview(json.rate);
    } catch {
      setRatePreview(null);
    }
  }, [practiceClientId, entryDate, currentUserId]);

  useEffect(() => {
    void resolveRate();
  }, [resolveRate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const numHours = Number(hours);
    if (!numHours || numHours <= 0 || numHours > 24) {
      setError('Hours must be between 0 and 24');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onSubmit({
        entryDate,
        hours: numHours,
        practiceClientId,
        jobCategoryId,
        workItemId,
        taskDescription,
        notes: notes || null,
        billable,
        origin: 'manual',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save entry');
    } finally {
      setSubmitting(false);
    }
  }

  const numHours = Number(hours) || 0;
  const rateNum = typeof ratePreview === 'number' ? ratePreview : null;
  const lineTotal = rateNum !== null ? (numHours * rateNum).toFixed(2) : null;

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-6 gap-4">
        {/* Date */}
        <div className="md:col-span-2">
          <label className={LABEL_CLS}>Date <span className="text-red-400">*</span></label>
          <input type="date" required value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className={INPUT_CLS} />
        </div>

        {/* Hours */}
        <div className="md:col-span-1">
          <label className={LABEL_CLS}>Hours <span className="text-red-400">*</span></label>
          <input type="number" required step="0.25" min="0" max="24" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="0.00" className={INPUT_CLS} />
        </div>

        {/* Client */}
        <div className="md:col-span-3">
          <label className={LABEL_CLS}>Client <span className="text-red-400">*</span></label>
          <select required value={practiceClientId} onChange={(e) => setPracticeClientId(e.target.value)} className={INPUT_CLS}>
            <option value="">Select client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.tradingName ?? c.legalName}</option>
            ))}
          </select>
        </div>

        {/* Category */}
        <div className="md:col-span-3">
          <label className={LABEL_CLS}>Category <span className="text-red-400">*</span></label>
          <select required value={jobCategoryId} onChange={(e) => setJobCategoryId(e.target.value)} className={INPUT_CLS}>
            <option value="">Select category…</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
        </div>

        {/* Work item */}
        <div className="md:col-span-3">
          <label className={LABEL_CLS}>Work Item <span className="text-red-400">*</span></label>
          <select required value={workItemId} onChange={(e) => setWorkItemId(e.target.value)} disabled={!jobCategoryId} className={INPUT_CLS}>
            <option value="">{jobCategoryId ? 'Select work item…' : 'Pick a category first'}</option>
            {workItems.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>

        {/* Task description */}
        <div className="md:col-span-6">
          <label className={LABEL_CLS}>Task Description <span className="text-red-400">*</span></label>
          <input type="text" required maxLength={500} value={taskDescription} onChange={(e) => setTaskDescription(e.target.value)} placeholder="Describe the work done…" className={INPUT_CLS} />
        </div>

        {/* Notes */}
        <div className="md:col-span-5">
          <label className={LABEL_CLS}>Notes</label>
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" className={INPUT_CLS} />
        </div>

        {/* Billable */}
        <div className="md:col-span-1 flex flex-col justify-end pb-1">
          <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-[var(--ff-text-primary)]">
            <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} className="rounded border-[var(--ff-border-primary)] text-teal-500 focus:ring-teal-500" />
            Billable
          </label>
        </div>
      </div>

      {/* Rate preview */}
      {ratePreview !== null && (
        <div className="text-sm">
          {ratePreview === 'loading' && (
            <span className="text-[var(--ff-text-tertiary)] flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Resolving rate…
            </span>
          )}
          {ratePreview === 'none' && (
            <span className="text-amber-400">No rate configured for this client.</span>
          )}
          {typeof ratePreview === 'number' && (
            <span className="text-[var(--ff-text-secondary)]">
              R{ratePreview}/h × {numHours}h = <strong className="text-teal-400">R{lineTotal}</strong>
            </span>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <button type="submit" disabled={submitting} className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {submitting ? 'Saving…' : 'Save Entry'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)] text-sm font-medium transition-colors">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
