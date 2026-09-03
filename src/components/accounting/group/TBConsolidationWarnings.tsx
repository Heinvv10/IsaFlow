/**
 * Warnings the consolidated trial balance must show even when it has no rows.
 *
 * Production's only group has three members carrying R152m and R952m of ledger
 * and zero group-CoA mappings, so every account is excluded and the report
 * consolidates nothing. It previously rendered an ordinary "no data" empty
 * state, which reads as "nothing to report" rather than "everything was
 * dropped". These panels sit ABOVE the empty state for that reason.
 */

import { AlertCircle } from 'lucide-react';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export interface UnmappedEntity {
  companyId: string; companyName: string; accountCount: number; value: number;
}

interface Props {
  unmapped?: { accountCount: number; value: number; byEntity: UnmappedEntity[] };
  /** False when members do not share a financial year end. */
  coterminous?: boolean;
}

export function TBConsolidationWarnings({ unmapped, coterminous }: Props) {
  const hasUnmapped = (unmapped?.accountCount ?? 0) > 0;
  if (!hasUnmapped && coterminous !== false) return null;

  return (
    <>
      {hasUnmapped && unmapped && (
        <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
          <p className="flex items-center gap-2 font-semibold text-red-700 dark:text-red-400">
            <AlertCircle className="h-5 w-5" aria-hidden="true" />
            {unmapped.accountCount} account{unmapped.accountCount === 1 ? '' : 's'} excluded — no group account mapping
          </p>
          <p className="mt-1 text-sm text-[var(--ff-text-secondary)]">
            Net {fmt(unmapped.value)} did not reach this consolidation. Map these accounts to group
            accounts, or the group report understates by that amount.
          </p>
          <ul className="mt-2 space-y-0.5 text-sm text-[var(--ff-text-tertiary)]">
            {unmapped.byEntity.map(e => (
              <li key={e.companyId}>
                {e.companyName}: {e.accountCount} account{e.accountCount === 1 ? '' : 's'}, net {fmt(e.value)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {coterminous === false && (
        <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <p className="flex items-center gap-2 font-semibold text-amber-700 dark:text-amber-400">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            Members do not share a financial year end
          </p>
          <p className="mt-1 text-[var(--ff-text-secondary)]">
            Each entity&apos;s income statement is measured from its own year start, so those columns
            cover different windows and are not additive without adjustment.
          </p>
        </div>
      )}
    </>
  );
}
