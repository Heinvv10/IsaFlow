/**
 * ARFilters — workflow filter chip strip for the AR (customer invoice) list.
 *
 * Chips:
 *   - "Due soon"        — due_date in next 7 days, not paid
 *   - "Overdue 90+"     — days_overdue > 90
 *   - "Viewed but unpaid" — status=sent AND last_viewed_at IS NOT NULL
 *
 * "Needs follow-up" chip omitted: no last_contact column exists on the schema.
 * Document this omission so a future sprint can add it once CRM contact log is built.
 *
 * Selection is multi-select and persists in URL (?aging=due-soon,overdue-90).
 * The parent page reads router.query.aging and passes it down as selectedFilters.
 */

import { Calendar, AlertTriangle, Eye } from 'lucide-react';
import type { AgingBucketKey } from '@/lib/format/aging';

export type AgingFilterId = 'due-soon' | 'overdue-90' | 'viewed-unpaid';

interface Chip {
  id: AgingFilterId;
  label: string;
  icon: React.ElementType;
  activeClasses: string;
  inactiveClasses: string;
}

const CHIPS: Chip[] = [
  {
    id: 'due-soon',
    label: 'Due soon',
    icon: Calendar,
    activeClasses: 'bg-amber-500/20 text-amber-300 border-amber-500/50',
    inactiveClasses: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] border-[var(--ff-border-light)] hover:border-amber-500/40 hover:text-amber-300',
  },
  {
    id: 'overdue-90',
    label: 'Overdue 90+',
    icon: AlertTriangle,
    activeClasses: 'bg-red-500/20 text-red-300 border-red-500/50',
    inactiveClasses: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] border-[var(--ff-border-light)] hover:border-red-500/40 hover:text-red-300',
  },
  {
    id: 'viewed-unpaid',
    label: 'Viewed but unpaid',
    icon: Eye,
    activeClasses: 'bg-blue-500/20 text-blue-300 border-blue-500/50',
    inactiveClasses: 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] border-[var(--ff-border-light)] hover:border-blue-500/40 hover:text-blue-300',
  },
];

interface ARFiltersProps {
  selectedFilters: AgingFilterId[];
  /** Called when user toggles a chip; parent updates URL and re-fetches. */
  onChange: (next: AgingFilterId[]) => void;
}

export function ARFilters({ selectedFilters, onChange }: ARFiltersProps) {
  function toggle(id: AgingFilterId) {
    const next = selectedFilters.includes(id)
      ? selectedFilters.filter((f) => f !== id)
      : [...selectedFilters, id];
    onChange(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-[var(--ff-text-tertiary)] tracking-wide uppercase mr-1">
        Filter
      </span>
      {CHIPS.map((chip) => {
        const Icon = chip.icon;
        const active = selectedFilters.includes(chip.id);
        return (
          <button
            key={chip.id}
            type="button"
            onClick={() => toggle(chip.id)}
            className={[
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
              active ? chip.activeClasses : chip.inactiveClasses,
            ].join(' ')}
            aria-pressed={active}
          >
            <Icon className="h-3.5 w-3.5" />
            {chip.label}
          </button>
        );
      })}
      {selectedFilters.length > 0 && (
        <button
          type="button"
          onClick={() => onChange([])}
          className="text-xs text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-secondary)] underline ml-1"
        >
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * Parse the ?aging= query param from Next.js router into AgingFilterId[].
 * Accepts comma-separated values (e.g. "due-soon,overdue-90").
 */
const VALID: Set<AgingFilterId> = new Set(['due-soon', 'overdue-90', 'viewed-unpaid']);

export function parseAgingParam(raw: string | string[] | undefined): AgingFilterId[] {
  const str = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  return str
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is AgingFilterId => VALID.has(s as AgingFilterId));
}

/**
 * Encode AgingFilterId[] back into a URL param string (or undefined to remove it).
 */
export function encodeAgingParam(filters: AgingFilterId[]): string | undefined {
  return filters.length > 0 ? filters.join(',') : undefined;
}

/**
 * Map the server-side aging_bucket string to a AgingBucketKey for color/label lookup.
 * Returns null for 'Current' (teal-500 default) and for paid invoices (null bucket).
 */
const BUCKET_KEY_MAP: Record<string, AgingBucketKey> = {
  '1-30':  'days30',
  '31-60': 'days60',
  '61-90': 'days90',
  '90+':   'days90Plus',
};

export function toBucketKey(bucket: string | null | undefined): AgingBucketKey | null {
  if (!bucket || bucket === 'Current') return null;
  return BUCKET_KEY_MAP[bucket] ?? null;
}

/** Format a past ISO timestamp as a short relative "N ago" string. */
export function relativeTimeSince(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  const days = Math.floor(diffSec / 86400);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
