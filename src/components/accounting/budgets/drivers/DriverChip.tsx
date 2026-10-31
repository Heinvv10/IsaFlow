/**
 * The driver chip in a grid row's header (P4 spec §7): what the row's driver computes, in a few
 * words ("38% × Sales", "+2% m/m from Mar", "R 32 000 × heads", "R 15 000 fixed", "5% of
 * Turnover"). A writer clicks it (keyboard: the row's actions, "Edit driver…") to open the driver editor; a reader sees the same words with the
 * full description in its title (a reader's per_head chip has no rate: "Per head × heads"). A driver the last recompute skipped (DRIVER_SKIPPED) or warned
 * about shows the warning state, its message in the title and the accessible name.
 */
import { AlertTriangle, Sigma } from 'lucide-react';
import type { VisibleDriverLine } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';
import { driverChipText } from './driverText';

export interface DriverChipProps {
  line: VisibleDriverLine;
  /** The account's name (no code) for a pct_of_line reference. */
  accountName(id: string): string;
  /** The long description (range, scope, rounding). */
  description: string;
  /** The last recompute's warning for this row (skipped, or an input read as 0); null when none. */
  warning: string | null;
  /** Opens the editor; null renders a read-only chip. */
  onOpen: (() => void) | null;
}

const BASE = 'mt-0.5 inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-px text-xs font-normal';
const TONE = 'border-[var(--ff-border-secondary)] bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]';
const WARN = 'border-[var(--ff-unfav)] text-[var(--ff-unfav)]';

export function DriverChip({ line, accountName, description, warning, onOpen }: DriverChipProps) {
  const text = driverChipText(line, accountName);
  const title = warning ? `${description}. ${warning}` : description;
  const icon = warning
    ? <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
    : <Sigma className="h-3 w-3 shrink-0" aria-hidden="true" />;
  const cls = `${BASE} ${warning ? WARN : TONE}`;
  if (!onOpen) {
    return <span data-testid="driver-chip" data-warning={warning ? 'true' : undefined} title={title} className={cls}>{icon}<span className="truncate">{text}</span></span>;
  }
  return (
    // Not a tab stop (as the own-budget chip's buttons): keyboard users reach "Edit driver…" through the row's actions (Shift+F10).
    <button type="button" tabIndex={-1} data-testid="driver-chip" data-warning={warning ? 'true' : undefined} title={title}
      aria-label={`Driver: ${text}. ${title}. Edit the driver`} onClick={onOpen}
      className={`${cls} hover:text-[var(--ff-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-cell-focus-ring)]`}>
      {icon}<span className="truncate">{text}</span>
    </button>
  );
}
