/**
 * The filters currently narrowing a list, each removable, plus "Clear all".
 * Renders nothing when no filter is active.
 */

import { X } from 'lucide-react';
import { formatSaDateValue } from '@/lib/saDateParser';

export interface ActiveFilterChip {
  key: string;
  label: string;
  onRemove: () => void;
}

interface Props {
  chips: ActiveFilterChip[];
  onClearAll: () => void;
}

export function ActiveFilterChips({ chips, onClearAll }: Props) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
      {chips.map(chip => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs bg-teal-500/10 text-teal-700 dark:text-teal-300 border border-teal-500/30"
        >
          {chip.label}
          <button
            type="button"
            onClick={chip.onRemove}
            aria-label={`Remove filter: ${chip.label}`}
            className="p-0.5 rounded-full hover:bg-teal-500/20"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-xs text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] underline underline-offset-2"
      >
        Clear all
      </button>
    </div>
  );
}

/** Human label for an inclusive date range, e.g. "Jun 2026" or "1 Jun 2026 – 15 Jun 2026". */
export function periodChipLabel(from: string, to: string, month: string | null): string {
  if (month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y!, m! - 1, 1).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
  }
  const fmt = (d: string) => {
    const [y, m, day] = d.split('-').map(Number);
    return formatSaDateValue(new Date(y!, m! - 1, day!));
  };
  if (from && to) return `${fmt(from)} – ${fmt(to)}`;
  return from ? `From ${fmt(from)}` : `Until ${fmt(to)}`;
}
