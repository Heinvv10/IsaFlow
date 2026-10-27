/**
 * Runs the grid's row actions (spec §5.5, §6.5, §11): the ones without input write straight
 * through the store, the others open SpreadDialog / GrainChangeDialog. Every action is ONE
 * `store.apply` (one undo entry) plus an announcement. Focus returns to the row's first cell
 * when a dialog closes (spec §12), through the store (`focusPos`), so the grid state, the roving
 * tab stop and DOM focus agree (QA-10). `onRowAction` keeps one identity for the grid's life:
 * view, members and layout are read through refs (ARCH-H1), so memo rows never re-render for it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { viewCellKey, type View } from '@/modules/accounting/services/budgets/grid/pivot';
import type { GridStore } from './gridStore';
import { accountRowKey } from './gridLayout';
import type { GridLayout } from './types';
import type { Pos } from '@/modules/accounting/services/budgets/grid/selection';
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
  /** The keyboard hook's store-driven focus (state + tab stop + DOM). */
  focusPos(pos: Pos): void;
}

const DIM_LABEL = { cc1: 'CC1', cc2: 'CC2', bu: 'BU' } as const;
const rowLabel = (row: LineRow) => `${row.account.code} ${row.account.name}`;

export function useRowActions({ store, layout, roundingUnit, view, members, focusPos }: UseRowActionsArgs): {
  onRowAction(row: LineRow, action: RowAction): void;
  dialogs: ReactNode;
} {
  const [spread, setSpread] = useState<{ target: SpreadTarget; r: number } | null>(null);
  const [grain, setGrain] = useState<{ target: GrainChangeTarget; r: number } | null>(null);
  const live = useRef({ layout, view, members, focusPos });
  useEffect(() => { live.current = { layout, view, members, focusPos }; });

  const cellsOf = useCallback((row: LineRow): RowCells => {
    const keys = live.current.layout.months.map((_, c) => store.cellKeyAt({ r: row.index, c })).filter((k): k is CellKey => k !== null);
    return { keys, values: store.getRow(row.key).values };
  }, [store]);

  const childrenOf = useCallback((row: LineRow): NamedChild[] => row.account.childIds.flatMap(id => {
    const child = live.current.layout.rows.find(r => r.key === accountRowKey(id));
    if (!child || child.kind !== 'line' || child.role !== 'account' || !store.isEditable({ r: child.index, c: 0 })) return [];
    const cells = cellsOf(child);
    return [{ accountId: id, label: rowLabel(child), keys: cells.keys, values: cells.values, py: store.getRow(child.key).py }];
  }), [cellsOf, store]);

  const write = useCallback((writes: CellWriteByKey[], text: string) => {
    const n = store.apply(writes);
    store.announce(n === 0 ? `${text}: nothing changed` : text);
  }, [store]);

  const refocus = useCallback((r: number) => { live.current.focusPos({ r, c: 0 }); }, []);

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
        const { view, members, layout } = live.current;
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
  }, [cellsOf, childrenOf, store, write]);

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
