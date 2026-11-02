/**
 * Edit an assignment's dates in place (Pay Components card, payroll employee profile): effective-from, and
 * effective-to with blank = open-ended. Works on ended rows too. This is how a run refused for a manual pro-rata
 * is fixed (payrollRecurringProRata): e.g. move the salary to the 1st of next month and assign the part month as a
 * once-off, then recalculate the run.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';

interface Props {
  componentName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  onSave: (effectiveFrom: string, effectiveTo: string | null) => Promise<void> | void;
  onCancel: () => void;
}

export function AssignmentDatesEditor({ componentName, effectiveFrom, effectiveTo, onSave, onCancel }: Props) {
  const [from, setFrom] = useState<string | null>(effectiveFrom.slice(0, 10));
  const [to, setTo] = useState<string | null>(effectiveTo ? effectiveTo.slice(0, 10) : null);
  const [refused, setRefused] = useState({ from: false, to: false });
  const [saving, setSaving] = useState(false);
  const endBeforeStart = from !== null && to !== null && to < from;

  const save = async () => {
    if (!from) return;
    setSaving(true);
    try { await onSave(from, to); } finally { setSaving(false); }
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg bg-[var(--ff-bg-tertiary)] p-3" aria-label={`Edit dates for ${componentName}`} role="group">
      <div className="w-48">
        <DateField label="New effective from" required value={from}
          onChange={(iso, v) => { setRefused(r => ({ ...r, from: !v.valid })); setFrom(iso); }} />
      </div>
      <div className="w-56">
        <DateField label="New effective to (blank: open-ended)" value={to} anchorDate={from}
          error={endBeforeStart ? 'The end cannot be before the start.' : undefined}
          onChange={(iso, v) => { setRefused(r => ({ ...r, to: !v.valid })); setTo(iso); }} />
      </div>
      <button type="button" onClick={() => void save()}
        disabled={!from || refused.from || refused.to || endBeforeStart || saving}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-medium">
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        Save dates
      </button>
      <button type="button" onClick={onCancel}
        className="px-3 py-2 rounded-lg text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-surface-primary)]">
        Cancel
      </button>
      <p className="w-full text-xs text-[var(--ff-text-tertiary)]">
        Recalculate any open pay run afterwards: a run keeps the figures it was calculated with.
      </p>
    </div>
  );
}
