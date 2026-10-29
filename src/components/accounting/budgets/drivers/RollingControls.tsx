/**
 * The rolling forecast's controls in the versions bar (P4 spec §6, §7), for a reforecast version:
 * the auto-roll toggle (PUT), and when the roll is behind the closed periods (a missed after-close
 * job) the badge "Rolled through <Mon YYYY> · N months closed since" with Roll now (POST
 * `{ action: 'roll' }`). A roll that met a locked version shows its `last_error`. Both writes send
 * the version token and need a clean grid; the answer's token is adopted and the grid re-reads the version.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import { failureText } from '@/components/accounting/budgets/workspace/failureText';
import type { BudgetGridApi } from '@/components/accounting/budgets/workspace/useBudgetGrid';
import type { ApiResult, BudgetVersion } from '@/components/accounting/budgets/workspace/types';
import { fetchRollingStatus, rollNow, setRolling, type RollingStatus } from './driverClient';

export interface RollingControlsProps {
  version: BudgetVersion;
  grid: Pick<BudgetGridApi, 'token' | 'dirtyCount' | 'adoptToken' | 'refresh'>;
  /** A writer on an unlocked version. */
  editable: boolean;
}

const BTN = 'inline-flex items-center gap-1 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)] px-2.5 py-1 text-xs text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)] disabled:opacity-50';

/** "Rolled through Mar 2026 · 2 months closed since"; null when the roll is up to date. */
export function staleBadgeText(s: RollingStatus): string | null {
  if (!s.rolling || s.staleMonths.length === 0) return null;
  const n = s.staleMonths.length;
  const since = `${n} month${n === 1 ? '' : 's'} closed since`;
  return s.rolledThroughMonth ? `Rolled through ${monthLabel(s.rolledThroughMonth)} · ${since}` : `Not rolled yet · ${n} closed month${n === 1 ? '' : 's'} to roll`;
}

export function RollingControls({ version, grid, editable }: RollingControlsProps) {
  // Kept with the version it describes: a token change re-reads it without blanking the controls.
  const [read, setRead] = useState<{ versionId: string; status: RollingStatus } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A roll that changes no cell keeps the version token, so a write re-reads the status itself.
  const [reread, setReread] = useState(0);
  const { token } = grid;
  const reforecast = version.kind === 'reforecast';

  useEffect(() => {
    if (!reforecast) return undefined;
    let gone = false;
    void fetchRollingStatus(version.id).then((r) => {
      if (gone) return;
      if (r.ok) { setRead({ versionId: version.id, status: r.data }); setError(null); } else setError(failureText(r));
    });
    return () => { gone = true; };
  }, [version.id, reforecast, token, reread]);

  const run = useCallback(async (write: (token: string) => Promise<ApiResult<{ updatedAt: string | null }>>) => {
    if (!grid.token) return;
    if (grid.dirtyCount > 0) { setError(`Save or discard your ${grid.dirtyCount} unsaved changes first.`); return; }
    setBusy(true);
    setError(null);
    const r = await write(grid.token);
    setBusy(false);
    if (!r.ok) {
      setError(failureText(r));
      if (r.kind === 'stale') await grid.refresh();
      return;
    }
    if (r.data.updatedAt) grid.adoptToken(r.data.updatedAt);
    await grid.refresh();
    setReread((n) => n + 1);
  }, [grid]);

  const status = read?.versionId === version.id ? read.status : null;
  if (!reforecast || !status) return error && reforecast ? <span role="alert" className="text-xs text-error-700 dark:text-error-400">{error}</span> : null;
  const badge = staleBadgeText(status);
  const can = editable && !busy && grid.dirtyCount === 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="rolling-controls">
      <button type="button" role="switch" aria-checked={status.rolling} disabled={!can} className={BTN} data-testid="rolling-toggle"
        title={grid.dirtyCount > 0 ? 'Save or discard your changes first' : undefined}
        onClick={() => { void run((t) => setRolling(version.id, t, !status.rolling)); }}>
        {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RotateCw className="h-3 w-3" aria-hidden="true" />}
        Rolling: {status.rolling ? 'on' : 'off'}
      </button>
      {badge && (
        <span data-testid="rolling-stale" className="inline-flex items-center gap-1.5 rounded-full border border-[var(--ff-unfav)] px-2 py-0.5 text-xs text-[var(--ff-unfav)]">
          {badge}
          {editable && <button type="button" disabled={!can} className="underline disabled:opacity-50" data-testid="roll-now"
            onClick={() => { void run((t) => rollNow(version.id, t)); }}>Roll now</button>}
        </span>
      )}
      {status.lastError && (
        <span role="status" data-testid="rolling-error" className="inline-flex items-center gap-1 text-xs text-error-700 dark:text-error-400">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />Last roll skipped: {status.lastError}
        </span>
      )}
      {error && <span role="alert" className="text-xs text-error-700 dark:text-error-400">{error}</span>}
    </span>
  );
}
