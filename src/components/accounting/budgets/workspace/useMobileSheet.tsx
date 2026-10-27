/**
 * The phone path of the grid (spec §12): a tapped cell opens `MobileCellSheet`; Save cell writes
 * that one cell through the store (the FY column spreads evenly with the rounding unit, as typing
 * in it does on desktop), one undo entry; Next month saves the same way and moves along the row.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { accountGrains, type View } from '@/modules/accounting/services/budgets/grid/pivot';
import type { Pos } from '@/modules/accounting/services/budgets/grid/selection';
import { spreadEven } from '@/modules/accounting/services/budgets/grid/spread';
import type { GridStore } from './gridStore';
import type { GridLayout } from './types';
import type { LineRow } from './BudgetGridRow';
import { rowActionItems, type RowAction } from './RowActionsMenu';
import { MobileCellSheet } from './MobileCellSheet';
import { rowWrites, type CellWriteByKey } from './rowActionWrites';

interface UseMobileSheetArgs {
  store: GridStore;
  layout: GridLayout;
  roundingUnit: RoundingUnit;
  view: View;
  canWrite: boolean;
  onRowAction(row: LineRow, action: RowAction): void;
}

export function useMobileSheet({ store, layout, roundingUnit, view, canWrite, onRowAction }: UseMobileSheetArgs): {
  open(pos: Pos): void;
  node: ReactNode;
} {
  const [pos, setPos] = useState<Pos | null>(null);
  const open = useCallback((p: Pos) => setPos(p), []);
  const close = () => setPos(null);

  const line = pos ? store.lineAt(pos.r) : null;
  if (!pos || !line) return { open, node: null };

  const snap = store.getRow(line.key);
  const months = layout.months;
  const isTotal = pos.c === months.length;
  const accountLabel = line.role === 'own' ? `${line.account.code} ${line.account.name} (own budget)` : `${line.account.code} ${line.account.name}`;
  const cents = isTotal ? snap.fy : snap.values[pos.c] ?? null;

  const save = (value: number | null, next: boolean) => {
    let writes: CellWriteByKey[];
    if (!snap.editable || value === cents) { if (next) setPos({ r: pos.r, c: pos.c + 1 }); else close(); return; }
    if (isTotal) {
      const keys = months.map((_, c) => store.cellKeyAt({ r: pos.r, c })).filter((k): k is CellKey => k !== null);
      if (value === null) writes = keys.map(key => ({ key, cents: null }));
      else {
        const spread = spreadEven(value, months.length, roundingUnit);
        if (!spread.ok) { store.announce(spread.reason); return; }
        writes = rowWrites(keys, spread.months);
      }
    } else {
      const key = store.cellKeyAt(pos);
      if (key === null) return;
      writes = [{ key, cents: value }];
    }
    if (store.apply(writes) > 0) store.announce(`${accountLabel}, ${isTotal ? 'full year' : monthLabel(months[pos.c] ?? '')} changed`);
    if (next) setPos({ r: pos.r, c: pos.c + 1 }); else close();
  };

  const grain = accountGrains(new Map(store.heldCells(line.account.id))).get(line.account.id) ?? null;
  const actions = rowActionItems({
    row: line, snap, canChange: canWrite, grain, view,
    onAction: a => { close(); onRowAction(line, a); },
  }).filter(a => !a.disabled).map(a => ({ label: a.label, onClick: a.onClick }));

  const node = (
    <MobileCellSheet
      key={`${pos.r}:${pos.c}`}
      target={{
        accountLabel, monthLabel: isTotal ? 'Full year' : monthLabel(months[pos.c] ?? ''), cents,
        editable: snap.editable, readReason: snap.readReason, isTotal, hasNext: pos.c < months.length - 1,
      }}
      onSave={v => save(v, false)}
      onNext={v => save(v, true)}
      onClose={close}
      actions={actions}
    />
  );
  return { open, node };
}
