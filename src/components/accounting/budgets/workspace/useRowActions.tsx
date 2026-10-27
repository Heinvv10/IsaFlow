/**
 * Runs the grid's row actions (spec §5.5, §6.5, §11): the ones without input write straight
 * through the store, the others open SpreadDialog / GrainChangeDialog. Every action is ONE
 * `store.apply` (one undo entry) plus an announcement. Focus returns to the row's first cell
 * when a dialog closes (spec §12).
 */
import { useCallback, useState, type ReactNode, type RefObject } from 'react';
import type { CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { viewCellKey, type View } from '@/modules/accounting/services/budgets/grid/pivot';
import type { GridStore } from './gridStore';
import { accountRowKey } from './gridLayout';
import type { GridLayout } from './types';
import type { LineRow } from './BudgetGridRow';
import type { RowAction } from './RowActionsMenu';
import { SpreadDialog, type NamedChild, type RowCells, type SpreadTarget } from './SpreadDialog';
import { GrainChangeDialog, type GrainChangeTarget } from './GrainChangeDialog';
import { type CellWriteByKey, clearWrites, grainChangeWrites, rowWrites } from './rowActionWrites';

export interface DimensionMember { id: string; code: string; name: string }

interface UseRowActionsArgs {
  store: GridStore;
  layout: GridLayout;
  roundingUnit: RoundingUnit;
  view: View;
  /** Members of the current view's dimension (for "Budget by CC1 …" naming). */
  members: readonly DimensionMember[];
  gridRef: RefObject<HTMLElement>;
}

const DIM_LABEL = { cc1: 'CC1', cc2: 'CC2', bu: 'BU' } as const;
const rowLabel = (row: LineRow) => `${row.account.code} ${row.account.name}`;

export function useRowActions({ store, layout, roundingUnit, view, members, gridRef }: UseRowActionsArgs): {
  onRowAction(row: LineRow, action: RowAction): void;
  dialogs: ReactNode;
} {
  const [spread, setSpread] = useState<{ target: SpreadTarget; r: number } | null>(null);
  const [grain, setGrain] = useState<{ target: GrainChangeTarget; r: number } | null>(null);

  const cellsOf = useCallback((row: LineRow): RowCells => {
    const keys = layout.months.map((_, c) => store.cellKeyAt({ r: row.index, c })).filter((k): k is CellKey => k !== null);
    return { keys, values: store.getRow(row.key).values };
  }, [layout.months, store]);

  const childrenOf = useCallback((row: LineRow): NamedChild[] => row.account.childIds.flatMap(id => {
    const child = layout.rows.find(r => r.key === accountRowKey(id));
    if (!child || child.kind !== 'line' || child.role !== 'account' || !store.isEditable({ r: child.index, c: 0 })) return [];
    const cells = cellsOf(child);
    return [{ accountId: id, label: rowLabel(child), keys: cells.keys, values: cells.values, py: store.getRow(child.key).py }];
  }), [cellsOf, layout.rows, store]);

  const write = useCallback((writes: CellWriteByKey[], text: string) => {
    const n = store.apply(writes);
    store.announce(n === 0 ? `${text}: nothing changed` : text);
  }, [store]);

  const refocus = useCallback((r: number) => {
    gridRef.current?.querySelector<HTMLElement>(`[data-pos="${r}:0"]`)?.focus();
  }, [gridRef]);

  const onRowAction = useCallback((row: LineRow, action: RowAction) => {
    const label = rowLabel(row);
    const snap = store.getRow(row.key);
    switch (action.type) {
      case 'spread':
        setSpread({ r: row.index, target: { mode: 'row', label, row: cellsOf(row), py: snap.py } });
        return;
      case 'copyPy': {
        if (snap.py === null) return;
        write(rowWrites(cellsOf(row).keys, snap.py), `Copied PY actuals into ${label}`);
        return;
      }
      case 'clear': {
        const cells = cellsOf(row);
        write(clearWrites(cells.keys, cells.values), `Cleared ${label}`);
        return;
      }
      case 'spreadChildren':
      case 'moveOwn': {
        const own = row.role === 'own' ? cellsOf(row) : null;
        const children = childrenOf(row);
        const target: SpreadTarget = action.type === 'moveOwn' && own
          ? { mode: 'move', label, children, own }
          : { mode: 'children', label, children, own };
        setSpread({ r: row.index, target });
        return;
      }
      case 'grain': {
        const id = row.account.id;
        const to = action.to;
        const member = view.kind === 'company' ? undefined : members.find(m => m.id === view.memberId);
        const newView: View = to === 'company' ? { kind: 'company' } : view;
        const newKeys = layout.months.map(m => viewCellKey(id, newView, m));
        const toLabel = to === 'company' ? 'company level' : `${DIM_LABEL[to]} ${member ? member.name : ''}`.trim();
        const enterHint = to === 'company' ? 'at company level' : to === 'bu' ? 'per business unit' : 'per cost centre';
        setGrain({
          r: row.index,
          target: { accountLabel: label, toLabel, enterHint, build: carry => grainChangeWrites(store.heldCells(id), layout.months, newKeys, carry) },
        });
        return;
      }
    }
  }, [cellsOf, childrenOf, layout.months, members, store, view, write]);

  const close = (r: number) => { setSpread(null); setGrain(null); refocus(r); };

  const dialogs = (
    <>
      {spread && (
        <SpreadDialog key={`${spread.r}:${spread.target.mode}`} target={spread.target} months={layout.months} unit={roundingUnit}
          onClose={() => close(spread.r)}
          onApply={(writes, text) => { write(writes, text); close(spread.r); }} />
      )}
      {grain && (
        <GrainChangeDialog key={grain.r} target={grain.target}
          onClose={() => close(grain.r)}
          onApply={(writes, text) => { write(writes, text); close(grain.r); }} />
      )}
    </>
  );
  return { onRowAction, dialogs };
}
