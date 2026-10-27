/**
 * The budget planning grid (spec §4.4, §5, §6, §12): `<table role="grid">` with a sticky head and
 * first column (stickyTable: the PAGE scrolls, no nested scroll box), one `<tbody>` per band, line
 * rows that subscribe per row, and live subtotal rows. No `content-visibility` (§13): on a `<tbody>`
 * it is inert (internal table boxes take no containment), and wrapping a band in a block box would
 * break the one table the sticky head and column rely on; the perf spec measures the page as is.
 * Keys, mouse and clipboard go through the core hooks (`useGridKeyboard`, `useGridClipboard`);
 * row actions through `useRowActions`. On a coarse pointer or under 768px a tap opens the
 * single-cell sheet instead (§12: read + single-cell edit, no range or clipboard).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useChartPalette } from '@/components/accounting/charts/ChartFrame';
import { STICKY_FIRST_HEAD, STICKY_HEAD } from '@/components/accounting/statement/stickyTable';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { Density } from '@/components/accounting/reportControls/useDensity';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { accountGrains, type View } from '@/modules/accounting/services/budgets/grid/pivot';
import type { GridStore } from './gridStore';
import { useGridLayout, useGridMeta } from './gridStoreHooks';
import { useGridKeyboard } from './useGridKeyboard';
import { useGridClipboard } from './useGridClipboard';
import type { LayoutRow } from './types';
import { BudgetGridRow, type GridCellHandlers } from './BudgetGridRow';
import { BudgetSectionRow, BudgetSubtotalRow, type GridColumns } from './BudgetSubtotalRow';
import { useRowActions, type DimensionMember } from './useRowActions';
import { useMobileSheet } from './useMobileSheet';

export interface BudgetGridProps {
  store: GridStore;
  /** The current view (Company / a dimension member); the store holds the same one. */
  view: View;
  roundingUnit: RoundingUnit;
  density: Density;
  /** Toolbar "show PY / Δ" toggle. */
  showPy: boolean;
  /** The compare version's name; null = no compare column. */
  compareLabel: string | null;
  /** The user may write and the version is not locked: row actions that change data. */
  canWrite: boolean;
  /** Members of the current view's dimension (empty in the Company view). */
  members: readonly DimensionMember[];
  onSave(): void;
  /**
   * Tab past the last column: move focus to the save bar and return true; return false when there
   * is nowhere to go (save bar hidden) and the browser's own Tab moves on (no keyboard trap).
   */
  onExit(): boolean;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const shortMonth = (m: string) => `${monthLabel(m).slice(0, 3)} ${m.slice(2, 4)}`;
const longMonth = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
const HEAD = 'px-2 py-2 text-xs font-semibold text-right whitespace-nowrap text-[var(--ff-text-secondary)]';

/** Coarse pointer or a phone-width viewport (spec §12). */
function useCompact(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(pointer: coarse), (max-width: 767px)');
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return compact;
}

/** Rows grouped into tbodies: each band from its section head, each profit row on its own. */
function groups(rows: readonly LayoutRow[]): LayoutRow[][] {
  const out: LayoutRow[][] = [];
  for (const row of rows) {
    const starts = row.kind === 'section' || row.kind === 'total' || row.kind === 'grand';
    if (starts || out.length === 0) out.push([row]); else out[out.length - 1]!.push(row);
  }
  return out;
}

export function BudgetGrid(props: BudgetGridProps) {
  const { store, view, roundingUnit, density, showPy, compareLabel, canWrite, members, onSave, onExit } = props;
  const layout = useGridLayout(store);
  const meta = useGridMeta(store);
  const palette = useChartPalette();
  const compact = useCompact();
  const gridRef = useRef<HTMLTableElement>(null);
  const keys = useGridKeyboard({ store, gridRef, roundingUnit, onSave, onExit });
  const clip = useGridClipboard(store);
  const { onRowAction, dialogs } = useRowActions({ store, layout, roundingUnit, view, members, focusPos: keys.focusPos });
  const sheet = useMobileSheet({ store, layout, roundingUnit, view, canWrite, onRowAction });

  // Shift+F10 / the context-menu key on a cell opens that row's ⋯ menu, so a keyboard user reaches
  // row actions from the cell they are on without tabbing through every row's button.
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLTableElement>) => {
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      const row = e.target instanceof Element ? e.target.closest('[data-pos]')?.closest('tr') : null;
      const trigger = row?.querySelector<HTMLButtonElement>('button[aria-label^="Row actions for"]');
      if (trigger) { e.preventDefault(); trigger.click(); return; }
    }
    keys.onKeyDown(e);
  }, [keys]);

  const accountant = density === 'accountant';
  const cols: GridColumns = useMemo(() => ({
    py: showPy, delta: showPy, deltaPct: showPy && accountant && !compact, trend: showPy && accountant && !compact,
    compare: compareLabel !== null, cents: accountant,
  }), [showPy, accountant, compact, compareLabel]);

  const handlers: GridCellHandlers = useMemo(() => ({
    onCellMouseDown: keys.onCellMouseDown,
    onCellMouseEnter: keys.onCellMouseEnter,
    onCellDoubleClick: keys.onCellDoubleClick,
    onDraftChange: keys.onDraftChange,
    onEditorBlur: keys.onEditorBlur,
    onCellTap: compact ? sheet.open : null,
    onRowAction,
    grainOf: (id: string) => accountGrains(new Map(store.heldCells(id))).get(id) ?? null,
  }), [keys, compact, sheet.open, onRowAction, store]);

  // An entry can stand for many cells (a paste clipped at the edge): the heading counts cells.
  const noticeCells = meta.notice ? meta.notice.reduce((n, e) => n + (e.cells ?? 1), 0) : 0;
  const extra = [cols.py, cols.delta, cols.deltaPct, cols.trend, cols.compare].filter(Boolean).length;
  const colCount = 1 + layout.cols + extra + 1;
  const header: ReactNode = (
    <tr aria-rowindex={1}>
      <th role="columnheader" scope="col" className={`${STICKY_FIRST_HEAD} ${HEAD} text-left px-3`}>Account</th>
      {layout.months.map(m => (
        <th key={m} role="columnheader" scope="col" aria-label={longMonth(m)} className={`${STICKY_HEAD} ${HEAD}`}>{shortMonth(m)}</th>
      ))}
      <th role="columnheader" scope="col" aria-label="Full year total" className={`${STICKY_HEAD} ${HEAD}`}>FY</th>
      {cols.py && <th role="columnheader" scope="col" aria-label="Prior year actual" className={`${STICKY_HEAD} ${HEAD}`}>PY</th>}
      {cols.delta && <th role="columnheader" scope="col" aria-label="Change versus prior year, rand" className={`${STICKY_HEAD} ${HEAD}`}>Δ PY</th>}
      {cols.deltaPct && <th role="columnheader" scope="col" aria-label="Change versus prior year, percent" className={`${STICKY_HEAD} ${HEAD}`}>Δ%</th>}
      {cols.trend && <th role="columnheader" scope="col" className={`${STICKY_HEAD} ${HEAD}`}>PY trend</th>}
      {cols.compare && <th role="columnheader" scope="col" className={`${STICKY_HEAD} ${HEAD}`}>Δ {compareLabel}</th>}
      <th role="columnheader" scope="col" className={`${STICKY_HEAD} ${HEAD}`}><span className="sr-only">Row actions</span></th>
    </tr>
  );

  const render = (row: LayoutRow) => {
    if (row.kind === 'section') return <BudgetSectionRow key={row.key} row={row} colCount={colCount} />;
    if (row.kind === 'line') {
      return <BudgetGridRow key={row.key} store={store} row={row} months={layout.months} cols={cols} palette={palette}
        handlers={handlers} canChange={canWrite} view={view} />;
    }
    return <BudgetSubtotalRow key={row.key} store={store} row={row} months={layout.months} cols={cols} palette={palette} />;
  };

  return (
    <div>
      <table
        ref={gridRef}
        role="grid"
        aria-label="Budget"
        aria-rowcount={layout.rows.length + 1}
        aria-colcount={colCount}
        aria-readonly={canWrite ? undefined : true}
        aria-multiselectable={compact ? undefined : true}
        className="min-w-full border-separate border-spacing-0 text-sm select-none"
        onKeyDown={compact ? undefined : onKeyDown}
        onCopy={compact ? undefined : clip.onCopy}
        onCut={compact ? undefined : clip.onCut}
        onPaste={compact ? undefined : clip.onPaste}
      >
        <thead>{header}</thead>
        {groups(layout.rows).map(g => (
          <tbody key={g[0]!.key}>{g.map(render)}</tbody>
        ))}
      </table>
      <div aria-live="polite" className="sr-only" data-testid="grid-announcement">
        <span key={meta.announcement.seq}>{meta.announcement.text}</span>
      </div>
      {meta.notice && (
        <div role="status" className="mt-3 rounded border border-[var(--ff-border-secondary)] bg-[var(--ff-bg-secondary)] p-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium text-[var(--ff-text-primary)]">{noticeCells} {noticeCells === 1 ? 'cell needs' : 'cells need'} a look</p>
            <button type="button" onClick={store.dismissNotice} className="text-xs underline text-[var(--ff-text-secondary)]">Dismiss</button>
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-[var(--ff-text-secondary)]">
            {meta.notice.map((n, i) => (
              // No text to quote (a paste clipped at the grid's edge): "label[, month]: reason".
              <li key={i}>{[n.rowLabel, n.monthLabel].filter(Boolean).join(', ')}: {n.raw === '' ? '' : `“${n.raw}”: `}{n.reason}</li>
            ))}
          </ul>
        </div>
      )}
      {dialogs}
      {sheet.node}
    </div>
  );
}
