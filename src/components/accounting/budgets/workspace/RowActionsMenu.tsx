/**
 * The ⋯ menu at the end of a grid line (spec §4.4, §6.5, §11). It only names actions; the grid
 * runs them (dialogs for the ones that need input, the store for the rest, one undo entry each).
 *
 * - An editable account: spread across months, copy PY actuals, clear row.
 * - An account at another grain than the view: "Budget by CC1…" / "Budget at company level…".
 * - A header's roll-up: spread across sub-accounts.
 * - A legacy header's own amounts: move to a sub-account, spread across sub-accounts.
 * - An active leaf account, at any grain: add or edit its note for the year (year-scoped).
 * - Any row with a note it cannot edit (read-only, a header, inactive): view the note, so a
 *   keyboard user or a viewer can read it without the icon's mouse-only tooltip.
 */
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import type { AccountGrain, View } from '@/modules/accounting/services/budgets/grid/pivot';
import type { GridRowSnapshot, LayoutRow } from './types';

export type RowAction =
  | { type: 'spread' }
  | { type: 'copyPy' }
  | { type: 'clear' }
  | { type: 'spreadChildren' }
  | { type: 'moveOwn' }
  | { type: 'grain'; to: View['kind'] }
  | { type: 'note'; readOnly: boolean };

const DIM_LABEL = { cc1: 'CC1', cc2: 'CC2', bu: 'BU' } as const;

/** The grain change this row offers in `view`, or null (§11 table; mixed grain is "Edit via Excel"). */
export function grainChangeFor(grain: AccountGrain | null, view: View): View['kind'] | null {
  if (grain === null || grain === 'mixed') return null;
  if (view.kind === 'company') return grain === 'company' ? null : 'company';
  return grain === 'company' ? view.kind : null;
}

export function grainActionLabel(to: View['kind']): string {
  return to === 'company' ? 'Budget at company level…' : `Budget by ${DIM_LABEL[to]}…`;
}

interface RowActionsMenuProps {
  row: Extract<LayoutRow, { kind: 'line' }>;
  snap: GridRowSnapshot;
  /** The version is writable by this user. */
  canChange: boolean;
  /** The account's live grain, and the current view (for the grain change). */
  grain: AccountGrain | null;
  view: View;
  onAction(action: RowAction): void;
}

export function rowActionItems({ row, snap, canChange, grain, view, onAction }: RowActionsMenuProps): ActionMenuItem[] {
  const item = (label: string, action: RowAction, extra: Partial<ActionMenuItem> = {}): ActionMenuItem =>
    ({ label, onClick: () => onAction(action), ...extra });
  const viewNote = snap.note && row.role !== 'own' ? [item('View note…', { type: 'note', readOnly: true })] : [];
  if (!canChange) return viewNote;
  const hasKids = row.account.childIds.length > 0;
  if (row.role === 'rollup') return [...(hasKids ? [item('Spread across sub-accounts…', { type: 'spreadChildren' })] : []), ...viewNote];
  if (row.role === 'own') {
    if (!hasKids) return [];
    return [item('Move to a sub-account…', { type: 'moveOwn' }), item('Spread across sub-accounts…', { type: 'spreadChildren' })];
  }
  // The server takes a note on an active leaf only (a header's own row and roll-up are above).
  const note = row.account.isActive ? [item(snap.note ? 'Edit note…' : 'Add note…', { type: 'note', readOnly: false })] : viewNote;
  if (!snap.editable) {
    const to = grainChangeFor(grain, view);
    return [...(to === null ? [] : [item(grainActionLabel(to), { type: 'grain', to })]), ...note];
  }
  const hasValues = snap.values.some(v => v !== null);
  return [
    item('Spread across months…', { type: 'spread' }),
    item('Copy PY actuals', { type: 'copyPy' }, { disabled: snap.py === null }),
    ...note,
    item('Clear row', { type: 'clear' }, { disabled: !hasValues, tone: 'destructive' }),
  ];
}

export function RowActionsMenu(props: RowActionsMenuProps) {
  const items = rowActionItems(props);
  if (items.length === 0) return null;
  const a = props.row.account;
  return <ActionMenu items={items} triggerLabel={`Row actions for ${a.code} ${a.name}${props.row.role === 'own' ? ' (own budget)' : ''}`} />;
}
