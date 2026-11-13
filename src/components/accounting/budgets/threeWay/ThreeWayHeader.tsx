/**
 * The three-way page's header (budgets P6 spec §8): the version switcher, the opening as-at chip (amber when the
 * opening is provisional; its title shows posted equity vs derived retained earnings, §13.9), the "Balances ✓"
 * chip (red, naming the months, when ANY check — the opening's or a month's — is not 0) and the warnings in words.
 */
import { AlertTriangle } from 'lucide-react';
import { formatStatementFigure } from '@/lib/format/money';
import { versionOptionLabel } from '@/components/accounting/budgets/workspace/VersionsBar';
import type { BudgetVersion } from '@/components/accounting/budgets/workspace/types';
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { warningText } from './warningText';

const CHIP = 'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium';
const TONE = {
  neutral: 'border-[var(--ff-border-light)] text-[var(--ff-text-secondary)]',
  amber: 'border-amber-400 bg-amber-50 text-amber-800 dark:border-amber-500/60 dark:bg-amber-500/10 dark:text-amber-300',
  ok: 'border-[var(--ff-border-light)] text-[var(--ff-text-primary)]',
  red: 'border-red-400 bg-red-50 text-error-700 dark:border-red-500/60 dark:bg-red-500/10 dark:text-error-400',
} as const;
const SELECT = 'min-w-0 max-w-full rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-3 py-1.5 text-sm text-[var(--ff-text-primary)]';

const rand = (cents: number): string => (cents === 0 ? 'R 0' : formatStatementFigure(cents / 100, { symbol: true }));

/** The months (and 'opening') whose check is not 0, from the figures themselves and the server's summary. */
export function unbalancedPoints(view: ThreeWayView): string[] {
  const out = new Set<string>();
  if (view.opening.balanceSheet.check !== 0) out.add('opening');
  for (const m of view.balanceSheet) if (m.sections.check !== 0) out.add(m.month);
  for (const m of view.checks.unbalancedMonths) out.add(m);
  if (!view.checks.balanced && out.size === 0) out.add('see the balance sheet');
  return [...out];
}

export interface ThreeWayHeaderProps {
  view: ThreeWayView;
  versions: readonly BudgetVersion[];
  selectedId: string;
  onSelect: (versionId: string) => void;
  disabled: boolean;
}

export function ThreeWayHeader({ view, versions, selectedId, onSelect, disabled }: ThreeWayHeaderProps) {
  const { opening } = view;
  const unbalanced = unbalancedPoints(view);
  const asAtTitle = `Opening balance sheet as at ${opening.asAt}${opening.provisional ? ' (provisional: today, the year has not started)' : ''}. `
    + `Posted equity ${rand(opening.equity.posted)} · derived retained earnings ${rand(opening.equity.derivedRetainedEarnings)}.`;
  return (
    <div className="space-y-2" data-testid="three-way-header">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Budget version" value={selectedId} disabled={disabled} onChange={(e) => onSelect(e.target.value)}
          className={SELECT} data-testid="three-way-version-select">
          {versions.map((v) => <option key={v.id} value={v.id}>{versionOptionLabel(v)}</option>)}
        </select>
        <span data-testid="opening-chip" data-tone={opening.provisional ? 'amber' : 'neutral'} title={asAtTitle}
          className={`${CHIP} ${opening.provisional ? TONE.amber : TONE.neutral}`}>
          Opening as at {opening.asAt}{opening.provisional ? ' · provisional' : ''}
        </span>
        <span data-testid="balances-chip" data-tone={unbalanced.length === 0 ? 'ok' : 'red'}
          className={`${CHIP} ${unbalanced.length === 0 ? TONE.ok : TONE.red}`}>
          {unbalanced.length === 0 ? 'Balances ✓' : `Out of balance: ${unbalanced.join(', ')}`}
        </span>
        {view.version.status === 'locked' && <span className={`${CHIP} ${TONE.neutral}`}>Locked: read-only</span>}
      </div>
      {view.warnings.length > 0 && (
        <ul data-testid="three-way-warnings" className="space-y-1 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-3 text-xs text-[var(--ff-text-secondary)]">
          {view.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
              <span>{warningText(w)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
