/**
 * The budget grid's holder-mode notice (budgets P5-6): shown to a budget holder of the version on
 * screen. It names their slices and each slice's review status, says that only those are shown and
 * editable (and only while open or returned on a draft), and links to "My budget slices", where
 * they submit a slice for review.
 */
import Link from 'next/link';
import { Users } from 'lucide-react';
import type { GridDimensions } from '@/modules/accounting/services/budgets/gridReadTypes';
import { sliceLabel, type HolderView } from '@/modules/accounting/services/budgets/holderSlices';

const STATUS_TEXT: Record<string, string> = {
  open: 'open', returned: 'returned to you', submitted: 'submitted, with the reviewer', approved: 'approved',
};

export function HolderBanner({ holder, dimensions, versionStatus }: { holder: HolderView; dimensions: GridDimensions; versionStatus: string }) {
  const names = new Map([...dimensions.cc1, ...dimensions.cc2, ...dimensions.bu].map((m) => [m.id, `${m.code} ${m.name}`]));
  return (
    <div data-testid="holder-banner" role="status"
      className="flex flex-wrap items-start gap-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3 text-sm text-[var(--ff-text-secondary)]">
      <Users className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ff-brand-eyebrow)]" aria-hidden="true" />
      <div className="min-w-[14rem] flex-1 space-y-1">
        <p className="font-medium text-[var(--ff-text-primary)]">You are a budget holder on this version</p>
        <ul className="space-y-0.5">
          {holder.slices.map((s) => (
            <li key={`${s.cc1Id}|${s.cc2Id}|${s.buId}`}>
              {sliceLabel(s, (id) => names.get(id))}{s.glAccountIds ? ` (${s.glAccountIds.length} account${s.glAccountIds.length === 1 ? '' : 's'})` : ''}
              {': '}{STATUS_TEXT[s.status ?? 'open'] ?? s.status}
            </li>
          ))}
        </ul>
        <p>
          {versionStatus === 'draft'
            ? 'Only your slices are shown. You can change them while they are open or returned; submit them for review when they are ready.'
            : 'Only your slices are shown. This version is no longer a draft, so they are read-only.'}
        </p>
      </div>
      <Link href="/accounting/budgets/review" className="shrink-0 rounded border border-[var(--ff-border-primary)] px-3 py-1 text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)]">
        My budget slices
      </Link>
    </div>
  );
}
