/**
 * The phone path of the grid (spec §12): a tapped cell opens `MobileCellSheet`; Save cell commits
 * that one cell through the desktop editor's path (`commitDraft`: the FY column spreads evenly with
 * the rounding unit), one undo entry; Next month saves the same way and moves along the row.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { accountGrains, type View } from '@/modules/accounting/services/budgets/grid/pivot';
import type { Pos } from '@/modules/accounting/services/budgets/grid/selection';
import { centsToPlain } from '@/modules/accounting/services/budgets/grid/tsv';
import type { GridStore } from './gridStore';
import type { GridLayout } from './types';
import type { LineRow } from './BudgetGridRow';
import { rowActionItems, type RowAction } from './RowActionsMenu';
import { MobileCellSheet } from './MobileCellSheet';
import { commitDraft } from './gridCommands';

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
    if (snap.editable && value !== cents) {
      // The desktop editor's commit path: kit parser, FY spread with the unit, residue notice.
      const seq = store.getMeta().announcement.seq;
      const refused = commitDraft(store, pos, value === null ? '' : centsToPlain(value), isTotal, roundingUnit);
      if (refused !== null) return;
      // commitDraft announces only a warning (the residue notice); keep it rather than talk over it.
      if (store.getMeta().announcement.seq === seq) store.announce(`${accountLabel}, ${isTotal ? 'full year' : monthLabel(months[pos.c] ?? '')} changed`);
    }
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
