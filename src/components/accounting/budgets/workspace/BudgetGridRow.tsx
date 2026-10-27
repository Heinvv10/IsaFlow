/**
 * One account line of the budget grid (spec §4.4, §6.1, §6.5): label, a focusable cell per month
 * and the FY total, then PY, Δ vs PY, the PY trend, Δ vs compare and the row actions. `memo` and a
 * per-row store subscription, so one edit re-renders this row and the subtotals only (§13).
 *
 * Cells carry `data-pos="{r}:{c}"` for the keyboard hook; only the focused cell has tabIndex 0
 * (roving tabindex). Dirty cells get the dirty token plus a 2px inset marker, conflicts the
 * conflict token; read-only cells say why in their title.
 */
import { memo, type MouseEvent, type ReactNode } from 'react';
import { Sparkline } from '@/components/accounting/statement/Sparkline';
import { STICKY_FIRST_CELL } from '@/components/accounting/statement/stickyTable';
import type { ChartPalette } from '@/components/accounting/charts/chartTypes';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { Pos } from '@/modules/accounting/services/budgets/grid/selection';
import type { AccountGrain, View } from '@/modules/accounting/services/budgets/grid/pivot';
import type { GridStore } from './gridStore';
import { useGridRow } from './gridStoreHooks';
import { accountRowKey } from './gridLayout';
import type { GridRowSnapshot, LayoutRow } from './types';
import { BudgetCellEditor } from './BudgetCellEditor';
import { DeltaCells, FIG, FIG_STYLE, KIND_CLASS, fig, spoken, type GridColumns } from './BudgetSubtotalRow';
import { RowActionsMenu, type RowAction } from './RowActionsMenu';

export type LineRow = Extract<LayoutRow, { kind: 'line' }>;

/** The mouse side of `useGridKeyboard`, plus the phone sheet and the row actions. */
export interface GridCellHandlers {
  onCellMouseDown(pos: Pos, shiftKey: boolean): void;
  onCellMouseEnter(pos: Pos): void;
  onCellDoubleClick(pos: Pos): void;
  onDraftChange(text: string): void;
  onEditorBlur(): void;
  /** Coarse pointer / phone: a tap opens the single-cell sheet instead of focusing. */
  onCellTap: ((pos: Pos) => void) | null;
  onRowAction(row: LineRow, action: RowAction): void;
  /** The account's live grain (it changes on a first write or a grain change). */
  grainOf(accountId: string): AccountGrain | null;
}

interface BudgetGridRowProps {
  store: GridStore;
  row: LineRow;
  months: readonly string[];
  cols: GridColumns;
  palette: ChartPalette;
  handlers: GridCellHandlers;
  /** Version is writable by this user (row actions that change data). */
  canChange: boolean;
  view: View;
}

const GRAIN_BADGE: Record<string, string> = { cc1: 'CC1', cc2: 'CC2', bu: 'BU', mixed: 'Mixed' };
const INDENT = ['pl-3', 'pl-7', 'pl-11', 'pl-14'];

function cellClass(snap: GridRowSnapshot, c: number, months: number): string {
  const base = `${FIG} relative px-2 py-1 cursor-cell outline-none focus:shadow-[inset_0_0_0_2px_var(--ff-cell-focus-ring)]`;
  const isFy = c === months;
  const dirty = !isFy && snap.dirty[c] === true;
  const conflict = !isFy && snap.conflict[c] === true;
  const selected = snap.selected !== null && c >= snap.selected.left && c <= snap.selected.right;
  const bg = conflict ? 'bg-[var(--ff-conflict-bg)]'
    : selected ? 'bg-[var(--ff-cell-selected-bg)]'
      : dirty ? 'bg-[var(--ff-dirty-bg)]' : '';
  const marker = dirty ? 'shadow-[inset_2px_0_0_var(--ff-text-primary)]' : '';
  const tone = snap.editable ? 'text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]';
  return `${base} ${bg} ${marker} ${tone} ${isFy ? 'font-semibold' : ''}`;
}

/**
 * Spec §6.5: a header that still holds its own amounts (legacy, pre decision 18) warns on its
 * roll-up row and offers the two ways to resolve it. The "(own budget)" line directly below
 * carries those amounts; the actions run on that line.
 */
function OwnBudgetChip({ store, row, handlers, canChange }: { store: GridStore; row: LineRow; handlers: GridCellHandlers; canChange: boolean }) {
  const own = useGridRow(store, accountRowKey(row.account.id));
  const ownLine = store.lineAt(row.index + 1);
  if (own.fy === null || !ownLine || ownLine.role !== 'own') return null;
  const hasKids = row.account.childIds.length > 0;
  const btn = 'underline hover:text-[var(--ff-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-cell-focus-ring)]';
  return (
    <span role="note" className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-normal text-[var(--ff-unfav)]">
      <span>This header has its own R {fig(own.fy, true)} budget</span>
      {canChange && hasKids && (
        <>
          <button type="button" tabIndex={-1} className={btn} onClick={() => handlers.onRowAction(ownLine, { type: 'moveOwn' })}>Move to a sub-account</button>
          <button type="button" tabIndex={-1} className={btn} onClick={() => handlers.onRowAction(ownLine, { type: 'spreadChildren' })}>Spread across sub-accounts</button>
        </>
      )}
    </span>
  );
}

/** `grain` is the LIVE grain (from the store's held cells), not the load-time model's. */
function RowLabel({ row, snap, chip, grain }: { row: LineRow; snap: GridRowSnapshot; chip: ReactNode; grain: AccountGrain | null }) {
  const a = row.account;
  const indent = INDENT[Math.min(a.depth + (row.role === 'own' ? 1 : 0), INDENT.length - 1)];
  const badge = grain !== null ? GRAIN_BADGE[grain] : undefined;
  return (
    <th role="rowheader" scope="row" title={snap.readReason ?? undefined}
      className={`text-left font-normal py-1 pr-2 ${indent} ${STICKY_FIRST_CELL} max-w-[11rem] md:max-w-[22rem]`}>
      <span className="flex items-center gap-1.5 min-w-0">
        {row.role === 'own' ? (
          <span className="italic truncate">(own budget)</span>
        ) : (
          <>
            <span className="font-mono text-xs text-[var(--ff-text-tertiary)] shrink-0">{a.code}</span>
            <span className={`truncate ${row.role === 'rollup' ? 'font-medium' : ''}`}>{a.name}</span>
          </>
        )}
        {!a.isActive && row.role !== 'own' && (
          <span className="text-[10px] px-1 rounded border border-[var(--ff-border-secondary)] text-[var(--ff-text-tertiary)] shrink-0">Inactive</span>
        )}
        {badge && row.role === 'account' && (
          <span className="text-[10px] px-1 rounded bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] shrink-0">{badge}</span>
        )}
      </span>
      {chip}
    </th>
  );
}

export const BudgetGridRow = memo(function BudgetGridRow({ store, row, months, cols, palette, handlers, canChange, view }: BudgetGridRowProps) {
  const snap = useGridRow(store, row.key);
  const r = row.index;
  // Recomputed on every render of this row; the row re-renders whenever its values change.
  const grain = handlers.grainOf(row.account.id);
  const label = row.role === 'own' ? `${row.account.name} (own budget)` : `${row.account.code} ${row.account.name}`;
  const incomeUp = row.band === 'turnover' || row.band === 'other_income';
  const values = [...snap.values, snap.fy];

  const down = (c: number) => (e: MouseEvent) => {
    if (handlers.onCellTap) { handlers.onCellTap({ r, c }); return; }
    if (e.button !== 0) return;
    handlers.onCellMouseDown({ r, c }, e.shiftKey);
  };

  return (
    <tr data-kind="line" data-row={row.key} aria-rowindex={r + 2} className={`${KIND_CLASS.line} text-sm`}>
      <RowLabel row={row} snap={snap} grain={grain}
        chip={row.role === 'rollup' && row.account.ownAmounts ? <OwnBudgetChip store={store} row={row} handlers={handlers} canChange={canChange} /> : null} />
      {values.map((v, c) => {
        const isFy = c === months.length;
        const editing = snap.editing !== null && snap.editing.col === c;
        const month = isFy ? 'full year' : monthLabel(months[c] ?? '');
        const selected = snap.selected !== null && c >= snap.selected.left && c <= snap.selected.right;
        return (
          <td
            key={isFy ? 'fy' : months[c]}
            role="gridcell"
            data-pos={`${r}:${c}`}
            data-dirty={!isFy && snap.dirty[c] ? 'true' : undefined}
            data-conflict={!isFy && snap.conflict[c] ? 'true' : undefined}
            tabIndex={snap.focusCol === c ? 0 : -1}
            aria-selected={selected}
            aria-readonly={!snap.editable}
            aria-label={`${label}, ${month}, ${spoken(v ?? null)}${!isFy && snap.dirty[c] ? ', unsaved' : ''}${!isFy && snap.conflict[c] ? ', conflict' : ''}`}
            title={snap.readReason ?? undefined}
            className={cellClass(snap, c, months.length)}
            style={FIG_STYLE}
            onMouseDown={down(c)}
            onMouseEnter={handlers.onCellTap ? undefined : () => handlers.onCellMouseEnter({ r, c })}
            onDoubleClick={handlers.onCellTap ? undefined : () => handlers.onCellDoubleClick({ r, c })}
          >
            {editing && snap.editing ? (
              <BudgetCellEditor draft={snap.editing.draft} label={`${label} ${month} budget`}
                onDraftChange={handlers.onDraftChange} onBlur={handlers.onEditorBlur} />
            ) : fig(v ?? null, cols.cents)}
          </td>
        );
      })}
      <DeltaCells fy={snap.fy} pyFy={snap.pyFy} compareFy={snap.compareFy} cols={cols} incomeUp={incomeUp} palette={palette}
        trend={snap.py ? <Sparkline points={snap.py.map(c => c / 100)} /> : null} />
      <td role="gridcell" aria-readonly="true" className="px-1 text-right">
        <RowActionsMenu row={row} snap={snap} canChange={canChange} view={view}
          grain={grain} onAction={a => handlers.onRowAction(row, a)} />
      </td>
    </tr>
  );
});
