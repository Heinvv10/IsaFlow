/**
 * "Lock a period" form for VAT period locks — records the filed VAT201
 * figures and blocks any posting that would change them.
 */
import { useState } from 'react';
import { Lock, Loader2 } from 'lucide-react';

interface Props {
  onLock: (periodStart: string, periodEnd: string, notes: string) => Promise<string | null>;
}

export function VatPeriodLockForm({ onLock }: Props) {
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!periodStart || !periodEnd) return;
    setSubmitting(true); setError('');
    const err = await onLock(periodStart, periodEnd, notes.trim());
    setSubmitting(false);
    if (err) { setError(err); return; }
    setPeriodStart(''); setPeriodEnd(''); setNotes('');
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4">
      <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Lock a period</h3>
      <p className="mt-1 text-xs text-[var(--ff-text-secondary)]">
        Locking records the filed VAT201 figures and blocks any posting that would change them.
      </p>
      {error && <p className="mt-2 rounded-lg bg-red-500/10 p-2 text-sm text-red-400">{error}</p>}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div>
          <label htmlFor="vat-lock-periodStart" className="block text-xs font-medium text-[var(--ff-text-secondary)]">Period start</label>
          <input
            type="date" id="vat-lock-periodStart" name="periodStart" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]"
            required
          />
        </div>
        <div>
          <label htmlFor="vat-lock-periodEnd" className="block text-xs font-medium text-[var(--ff-text-secondary)]">Period end</label>
          <input
            type="date" id="vat-lock-periodEnd" name="periodEnd" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]"
            required
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="vat-lock-notes" className="block text-xs font-medium text-[var(--ff-text-secondary)]">Notes (optional)</label>
          <input
            type="text" id="vat-lock-notes" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]"
            placeholder="e.g. Filed on eFiling 2026-09-24"
          />
        </div>
      </div>
      <button
        type="submit" disabled={submitting}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Lock period
      </button>
    </form>
  );
}
