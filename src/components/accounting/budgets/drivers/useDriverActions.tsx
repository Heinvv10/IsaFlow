/**
 * The drivers layer of the budget workspace (P4 spec §7): the grid's driver handlers (chip,
 * override Reset, driver values), the driver editor drawer, the headcount cache the preview reads,
 * and `runWrite`, the one path every driver / override / hire / refresh write takes:
 *
 * - the grid must be clean (a write recomputes cells and the grid reloads: unsaved edits would be
 *   lost), the version token goes as `expectedUpdatedAt`;
 * - on success the answer's token is adopted at once (a second write never sends a stale one),
 *   the grid re-reads the version in place (the recompute moved cells), and the recompute's
 *   warnings land on the rows;
 * - a 409 STALE reloads the version and says so; any other refusal is the message to show (a
 *   400 DRIVER_CYCLE carries the loop's path).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { rowKeyFor } from '@/modules/accounting/services/budgets/drivers/driverTypes';
import type { DriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import type { BudgetGridApi } from '@/components/accounting/budgets/workspace/useBudgetGrid';
import { failureText } from '@/components/accounting/budgets/workspace/failureText';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';
import { deleteDriver, fetchHeadcount, resetOverride, saveDriver, type DriverWriteAnswer } from './driverClient';
import { DriverEditor, type EditorFailure } from './DriverEditor';
import { driverValueOf, previewDriver, type DriverContext, type HeadcountLookup } from './driverPreview';
import { costCentreOptions, grainInView, refRowOptions, rowLabels } from './driverRows';
import { driverDescription } from './driverText';
import type { GridDriverHandlers } from './gridDriverHandlers';

export type DriverWrite<T extends DriverWriteAnswer> = (versionId: string, token: string) => Promise<ApiResult<T>>;

export interface DriverActions {
  /** Null until a version is loaded. */
  handlers: GridDriverHandlers | null;
  editor: ReactNode;
  /** The last write's outcome for the page (an error, or what the recompute did). */
  notice: { tone: 'error' | 'info'; text: string } | null;
  dismissNotice(): void;
  runWrite<T extends DriverWriteAnswer>(write: DriverWrite<T>, done: (data: T) => string): Promise<EditorFailure | null>;
  /** Drop the cached headcount (a hire changed, headcount refreshed). */
  invalidateHeadcount(): void;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function useDriverActions(grid: BudgetGridApi, editable: boolean): DriverActions {
  const { model, version } = grid;
  const versionId = version?.id ?? null;
  // The account being edited, and how to put focus back on its row when the drawer closes.
  const [editing, setEditing] = useState<{ accountId: string; onClosed?: () => void } | null>(null);
  const refocus = useRef<(() => void) | null>(null);
  const [notice, setNotice] = useState<DriverActions['notice']>(null);
  const [tick, setTick] = useState(0);
  const live = useRef(grid);
  useEffect(() => { live.current = grid; });
  const counts = useRef(new Map<string, ReadonlyMap<string, number>>());
  const countErrors = useRef(new Map<string, string>());
  const loading = useRef(new Set<string>());
  const resetting = useRef(new Set<string>());

  useEffect(() => { counts.current = new Map(); countErrors.current = new Map(); setEditing(null); setNotice(null); }, [versionId]);
  // After the drawer unmounted (its focus trap hands focus back first): the row's cell takes it.
  useEffect(() => {
    if (editing || !refocus.current) return;
    const back = refocus.current;
    refocus.current = null;
    back();
  }, [editing]);
  const closeEditor = useCallback(() => {
    setEditing((e) => { refocus.current = e?.onClosed ?? null; return null; });
  }, []);

  const lookup: HeadcountLookup = useCallback((scope) => counts.current.get(scope ?? ''), []);
  const loadHeadcount = useCallback(async (scope: string | null) => {
    const id = live.current.version?.id;
    const k = scope ?? '';
    if (!id || counts.current.has(k) || loading.current.has(k)) return;
    loading.current.add(k);
    const r = await fetchHeadcount(id, scope);
    loading.current.delete(k);
    if (live.current.version?.id !== id) return;
    if (r.ok) { counts.current.set(k, new Map(r.data.months.map((m) => [m.month, m.total]))); countErrors.current.delete(k); }
    else countErrors.current.set(k, failureText(r));
    setTick((t) => t + 1);
  }, []);
  // A failed read is retried when the editor asks again (a scope change, or reopening it).
  const needHeadcount = useCallback((scope: string | null) => { countErrors.current.delete(scope ?? ''); void loadHeadcount(scope); }, [loadHeadcount]);
  const headcountError = useCallback((scope: string | null) => countErrors.current.get(scope ?? '') ?? null, []);
  const invalidateHeadcount = useCallback(() => { counts.current = new Map(); countErrors.current = new Map(); setTick((t) => t + 1); }, []);

  const context = useCallback((): DriverContext => {
    const g = live.current;
    const inputs = g.store.driverInputs();
    return { ...inputs, months: g.model?.year.monthKeys ?? [], closedMonths: g.store.getClosedMonths(), rounding: g.roundingUnit };
  }, []);

  const runWrite = useCallback(async <T extends DriverWriteAnswer>(write: DriverWrite<T>, done: (data: T) => string): Promise<EditorFailure | null> => {
    const g = live.current;
    if (!g.version || !g.token) return { message: 'The budget is not loaded.' };
    if (g.dirtyCount > 0) {
      return { message: `Save or discard your ${plural(g.dirtyCount, 'unsaved change')} first: a driver change recomputes the grid.` };
    }
    const r = await write(g.version.id, g.token);
    if (!r.ok) {
      if (r.kind === 'stale') {
        await g.refresh();
        return { message: `${r.message} The latest version is now on screen; check it and try again.` };
      }
      return { message: failureText(r), ...(r.kind === 'invalid' && r.path ? { path: r.path } : {}) };
    }
    g.adoptToken(r.data.updatedAt);
    // The write stands even when the re-read fails: that is said, never a refusal.
    const reread = await g.refresh(r.data.warnings);
    const text = done(r.data);
    g.store.announce(reread ?? text);
    setNotice(reread ? { tone: 'error', text: `${text}. ${reread}` }
      : r.data.warnings.length > 0 ? { tone: 'error', text: `${text} ${r.data.warnings.map((w) => w.message).join(' ')}` }
        : { tone: 'info', text });
    return null;
  }, []);

  const labels = useMemo(() => (model ? rowLabels(model.accounts, model.dimensions) : null), [model]);

  const handlers = useMemo<GridDriverHandlers | null>(() => {
    if (!labels || !versionId) return null;
    return {
      canChange: editable,
      openEditor: (id, onClosed) => setEditing({ accountId: id, onClosed }),
      resetOverride: async (id, month) => {
        const row = grainInView(id, live.current.view);
        const key = `${rowKeyFor(row)}|${month ?? ''}`;
        if (resetting.current.has(key)) return; // one Reset of a cell (or row) at a time
        resetting.current.add(key);
        try {
          const f = await runWrite((v, t) => resetOverride(v, t, { ...row, month }),
            (d) => `${plural(d.reset, 'override')} reset to the driver on ${labels.row(rowKeyFor(row))}`);
          if (f) { setNotice({ tone: 'error', text: f.message }); live.current.store.announce(f.message); }
        } finally {
          resetting.current.delete(key);
        }
      },
      driverValue: (id, month) => driverValueOf(context(), rowKeyFor(grainInView(id, live.current.view)), month, lookup),
      accountName: labels.accountName,
      describe: (line) => driverDescription(line, labels.account, labels.member, labels.scope),
    };
  }, [labels, versionId, editable, runWrite, context, lookup]);

  const preview = useCallback((line: DriverLine) => previewDriver(context(), line, lookup), [context, lookup]);
  const pathLabel = useCallback((path: readonly string[]) => (labels ? path.map(labels.row).join(' → ') : path.join(' → ')), [labels]);

  let editor: ReactNode = null;
  if (editing && model && labels) {
    const grain = grainInView(editing.accountId, grid.view);
    const key = rowKeyFor(grain);
    const existing = grid.store.driverOfRow(key);
    const close = closeEditor;
    editor = (
      <DriverEditor key={key} grain={grain} label={labels.row(key)} existing={existing} months={model.year.monthKeys}
        rows={refRowOptions(model.accounts, grid.store.driverInputs().values, key, labels)} costCentres={costCentreOptions(model.dimensions)}
        readOnly={!editable} preview={preview} onNeedHeadcount={needHeadcount} headcountTick={tick} headcountError={headcountError} pathLabel={pathLabel}
        onSave={async (line) => {
          const f = await runWrite((v, t) => saveDriver(v, t, line), (d) => `Driver saved on ${labels.row(key)}; ${plural(d.recomputed, 'cell')} recomputed`);
          if (!f) close();
          return f;
        }}
        onDelete={async () => {
          if (!existing) return null;
          const f = await runWrite((v, t) => deleteDriver(v, t, existing.id), (d) => `Driver deleted from ${labels.row(key)}; its cells keep their amounts (${plural(d.recomputed, 'cell')} recomputed)`);
          if (!f) close();
          return f;
        }}
        onClose={close} />
    );
  }

  return { handlers, editor, notice, dismissNotice: () => setNotice(null), runWrite, invalidateHeadcount };
}
