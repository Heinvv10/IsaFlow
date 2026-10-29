/**
 * The rolling forecast's controls in the versions bar (P4 spec §6, §7), for a reforecast version:
 * the auto-roll toggle (PUT); when the roll is behind the closed periods (a missed after-close
 * job) the badge "Rolled through <Mon YYYY> · N months closed since"; a month reopened after the
 * roll, "<Mon> reopened after the roll — Roll now refreshes it"; one Roll now (POST
 * `{ action: 'roll' }`) for either, on any reforecast (a non-rolling one refreshes its actuals by hand); the actuals the forecast cannot place; and a skipped roll's
 * `last_error`. Both writes send the version token and need a clean grid; a write's token is
 * adopted, the grid re-reads the version (the roll's warnings land on the rows) and the status is
 * read again (a roll that changes no cell keeps the token). A roll the server skipped (locked,
 * primary, not rolling) says so.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import { failureText } from '@/components/accounting/budgets/workspace/failureText';
import type { BudgetGridApi } from '@/components/accounting/budgets/workspace/useBudgetGrid';
import type { BudgetVersion } from '@/components/accounting/budgets/workspace/types';
import { fetchRollingStatus, rollNow, setRolling, type RollingStatus, type RollNowView, type UnplacedActualLine } from './driverClient';
import { UnplacedList } from './ReforecastDialog';

export interface RollingControlsProps {
  version: BudgetVersion;
  grid: Pick<BudgetGridApi, 'token' | 'dirtyCount' | 'adoptToken' | 'refresh'>;
  /** A writer on an unlocked version. */
  editable: boolean;
}

const BTN = 'inline-flex items-center gap-1 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-2.5 py-1 text-xs text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50';
const PILL = 'inline-flex items-center gap-1.5 rounded-full border border-[var(--ff-unfav)] px-2 py-0.5 text-xs text-[var(--ff-unfav)]';

/**
 * "Rolled through Mar 2026 · 2 months closed since"; null when the roll is up to date. Any reforecast, rolling or
 * not: Roll now is also the manual refresh of a reforecast that does not roll (PR-4), and turning rolling on shows
 * the closed months as stale until the first roll.
 */
export function staleBadgeText(s: RollingStatus): string | null {
  if (s.staleMonths.length === 0) return null;
  const n = s.staleMonths.length;
  const since = `${n} month${n === 1 ? '' : 's'} closed since`;
  return s.rolledThroughMonth ? `Rolled through ${monthLabel(s.rolledThroughMonth)} · ${since}` : `Not rolled yet · ${n} closed month${n === 1 ? '' : 's'} to roll`;
}

/** Spec §6: "<Mon YYYY> reopened after the roll — Roll now refreshes it"; null when none. */
export function reopenedText(s: RollingStatus): string | null {
  const months = s.reopenedMonths ?? [];
  if (months.length === 0) return null;
  return `${months.map((m) => monthLabel(m)).join(', ')} reopened after the roll — Roll now refreshes it`;
}

/** What a roll the server answered without rolling means for the user. */
export function skippedRollText(status: RollNowView['status']): string | null {
  if (status === 'locked') return 'The version is locked: the roll was skipped.';
  if (status === 'primary') return 'The version is primary: a rolling forecast never rolls the primary budget.';
  if (status === 'not_rolling') return 'This version does not roll forward: turn rolling on first.';
  return null;
}

/** Why a roll or toggle cannot be sent now; null when it can. */
function blockedBy(grid: Pick<BudgetGridApi, 'token' | 'dirtyCount'>): string | null {
  if (!grid.token) return 'The budget is not loaded.';
  return grid.dirtyCount > 0 ? `Save or discard your ${grid.dirtyCount} unsaved changes first.` : null;
}

type Note = { tone: 'error' | 'info'; text: string; unplaced?: UnplacedActualLine[] };

export function RollingControls({ version, grid, editable }: RollingControlsProps) {
  // Kept with the version it describes: a token change re-reads it without blanking the controls.
  const [read, setRead] = useState<{ versionId: string; status: RollingStatus } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [reread, setReread] = useState(0);
  const { token } = grid;
  const reforecast = version.kind === 'reforecast';

  useEffect(() => { setNote(null); }, [version.id]);
  useEffect(() => {
    if (!reforecast) return undefined;
    let gone = false;
    void fetchRollingStatus(version.id).then((r) => {
      if (gone) return;
      if (r.ok) setRead({ versionId: version.id, status: r.data }); else setNote({ tone: 'error', text: failureText(r) });
    });
    return () => { gone = true; };
  }, [version.id, reforecast, token, reread]);

  const roll = useCallback(async () => {
    const blocked = blockedBy(grid);
    if (blocked || !grid.token) { setNote({ tone: 'error', text: blocked ?? '' }); return; }
    setBusy(true);
    setNote(null);
    const r = await rollNow(version.id, grid.token);
    let next: Note;
    if (!r.ok) {
      next = { tone: 'error', text: failureText(r) };
      if (r.kind === 'stale') await grid.refresh();
    } else {
      const skipped = skippedRollText(r.data.status);
      if (r.data.updatedAt) grid.adoptToken(r.data.updatedAt);
      const failed = skipped ? null : await grid.refresh(r.data.warnings);
      next = skipped ? { tone: 'error', text: skipped }
        : { tone: failed ? 'error' : 'info', text: failed ?? `Rolled: ${r.data.changed} cell${r.data.changed === 1 ? '' : 's'} changed.`, unplaced: r.data.unplaced };
    }
    setBusy(false);
    setNote(next);
    setReread((n) => n + 1);
  }, [grid, version.id]);

  const toggle = useCallback(async (rolling: boolean) => {
    const blocked = blockedBy(grid);
    if (blocked || !grid.token) { setNote({ tone: 'error', text: blocked ?? '' }); return; }
    setBusy(true);
    setNote(null);
    const r = await setRolling(version.id, grid.token, rolling);
    if (r.ok) grid.adoptToken(r.data.updatedAt);
    const failed = r.ok ? await grid.refresh() : failureText(r);
    if (!r.ok && r.kind === 'stale') await grid.refresh();
    setBusy(false);
    setNote(failed ? { tone: 'error', text: failed } : null);
    setReread((n) => n + 1);
  }, [grid, version.id]);

  const status = read?.versionId === version.id ? read.status : null;
  const noteNode = note && (
    <span role={note.tone === 'error' ? 'alert' : 'status'} data-testid="rolling-note"
      className={`text-xs ${note.tone === 'error' ? 'text-error-700 dark:text-error-400' : 'text-[var(--ff-text-secondary)]'}`}>
      {note.text}
      {note.unplaced && note.unplaced.length > 0 && <span className="block"><UnplacedList lines={note.unplaced} /></span>}
    </span>
  );
  if (!reforecast) return null;
  if (!status) return noteNode;
  const badge = staleBadgeText(status);
  const reopened = reopenedText(status);
  const can = editable && !busy && grid.dirtyCount === 0;
  const unplaced = status.unplaced ?? [];
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="rolling-controls">
      <button type="button" role="switch" aria-checked={status.rolling} disabled={!can} className={BTN} data-testid="rolling-toggle"
        title={grid.dirtyCount > 0 ? 'Save or discard your changes first' : undefined}
        onClick={() => { void toggle(!status.rolling); }}>
        {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RotateCw className="h-3 w-3" aria-hidden="true" />}
        Rolling: {status.rolling ? 'on' : 'off'}
      </button>
      {badge && <span data-testid="rolling-stale" className={PILL}>{badge}</span>}
      {reopened && <span data-testid="rolling-reopened" className={PILL}>{reopened}</span>}
      {(badge || reopened) && editable && (
        <button type="button" disabled={!can} className={`${BTN} underline`} data-testid="roll-now" onClick={() => { void roll(); }}>Roll now</button>
      )}
      {unplaced.length > 0 && (
        <details data-testid="rolling-unplaced" className="text-xs text-[var(--ff-text-secondary)]">
          <summary className="cursor-pointer">{unplaced.length} unplaced actual{unplaced.length === 1 ? '' : 's'}</summary>
          <UnplacedList lines={unplaced} />
        </details>
      )}
      {status.lastError && (
        <span role="status" data-testid="rolling-error" className="inline-flex items-center gap-1 text-xs text-error-700 dark:text-error-400">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />Last roll skipped: {status.lastError}
        </span>
      )}
      {noteNode}
    </span>
  );
}
