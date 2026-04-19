/**
 * JobStatusBadge — coloured pill for practice job status.
 */

import type { PracticeJob } from '@/modules/accounting/services/practice/practiceJobService';

const STATUS_STYLES: Record<PracticeJob['status'], { label: string; classes: string }> = {
  new:         { label: 'New',         classes: 'bg-slate-100 text-slate-700 border-slate-300' },
  in_progress: { label: 'In progress', classes: 'bg-blue-100 text-blue-800 border-blue-300' },
  review:      { label: 'In review',   classes: 'bg-amber-100 text-amber-800 border-amber-300' },
  approved:    { label: 'Approved',    classes: 'bg-green-100 text-green-800 border-green-300' },
  billed:      { label: 'Billed',      classes: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  complete:    { label: 'Complete',    classes: 'bg-neutral-100 text-neutral-700 border-neutral-300' },
  cancelled:   { label: 'Cancelled',   classes: 'bg-rose-100 text-rose-800 border-rose-300' },
};

export function JobStatusBadge({ status }: { status: PracticeJob['status'] }) {
  const s = STATUS_STYLES[status];
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium border rounded ${s.classes}`}>
      {s.label}
    </span>
  );
}
