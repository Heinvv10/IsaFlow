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
 * - P4 (when the grid wires drivers): an editable account sets or edits its driver; a driver row
 *   with overrides resets the focused month's override or all of them (the keyboard route to Reset).
 */
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import type { AccountGrain, View } from '@/modules/accounting/services/budgets/grid/pivot';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import type { GridRowSnapshot, LayoutRow } from './types';

export type RowAction =
  | { type: 'spread' }
  | { type: 'copyPy' }
  | { type: 'clear' }
  | { type: 'spreadChildren' }
  | { type: 'moveOwn' }
  | { type: 'grain'; to: View['kind'] }
  | { type: 'note'; readOnly: boolean }
  | { type: 'driver' }
  /** `month: null`: every override of the row. */
  | { type: 'resetOverrides'; month: string | null };

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
  /** P4: the grid wires drivers (absent: no driver items). */
  drivers?: boolean;
  /** The year's months (the focused override's month label). */
  months?: readonly string[];
}

/** The P4 items: set / edit the row's driver, reset its overrides (the focused month's, or all). */
function driverItems({ snap, months = [], onAction }: RowActionsMenuProps): ActionMenuItem[] {
  const out: ActionMenuItem[] = [{ label: snap.driver ? 'Edit driver…' : 'Set driver…', onClick: () => onAction({ type: 'driver' }) }];
  if (!snap.driver) return out;
  const isOverride = (c: number) => snap.sources[c] === 'override' && snap.dirty[c] !== true;
  const focused = snap.focusCol !== null && snap.focusCol < months.length && isOverride(snap.focusCol) ? months[snap.focusCol] : undefined;
  if (focused) out.push({ label: `Reset ${monthLabel(focused)} to driver`, onClick: () => onAction({ type: 'resetOverrides', month: focused }) });
  if (snap.sources.some((_, c) => isOverride(c))) out.push({ label: 'Reset all overrides', onClick: () => onAction({ type: 'resetOverrides', month: null }) });
  return out;
}

export function rowActionItems(props: RowActionsMenuProps): ActionMenuItem[] {
  const { row, snap, canChange, grain, view, onAction } = props;
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
    ...(props.drivers && row.role === 'account' ? driverItems(props) : []),
    item('Clear row', { type: 'clear' }, { disabled: !hasValues, tone: 'destructive' }),
  ];
}

export function RowActionsMenu(props: RowActionsMenuProps) {
  const items = rowActionItems(props);
  if (items.length === 0) return null;
  const a = props.row.account;
  return <ActionMenu items={items} triggerLabel={`Row actions for ${a.code} ${a.name}${props.row.role === 'own' ? ' (own budget)' : ''}`} />;
}
