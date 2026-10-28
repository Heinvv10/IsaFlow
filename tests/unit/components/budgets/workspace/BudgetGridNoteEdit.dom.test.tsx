/**
 * Budget notes are editable from the grid (P2 follow-up F1): a writer opens "Add note…" / "Edit
 * note…" from a leaf account's row actions (desktop ⋯, Shift+F10, or the phone sheet), edits the
 * text in a labelled dialog that says the note is year-scoped, and Save sends it through
 * `onSaveNote`. On success the row's note icon and tooltip change without a reload; unsaved
 * amounts, undo history and the dirty count are untouched. Escape closes and puts focus back on
 * the row. A refusal keeps the dialog open with the server's message. Viewers and locked versions
 * (canWrite false), header roll-ups and inactive accounts have no note action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BudgetGrid, type BudgetGridProps } from '@/components/accounting/budgets/workspace/BudgetGrid';
import { GridStore, accountRowKey, rollupRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import { viewCellKey } from '@/modules/accounting/services/budgets/grid/pivot';
import { ID, MONTHS, gridModel } from './gridFixture';

const COMPANY = { kind: 'company' } as const;
const NOTE = 'Includes the Q3 price rise';

function model() {
  const m = gridModel();
  return {
    ...m,
    accounts: m.accounts.map((a) => (a.id === ID.rev2 ? { ...a, note: NOTE } : a.id === ID.opex ? { ...a, isActive: false } : a)),
  };
}

let store: GridStore;
let compact = false;
beforeEach(() => {
  compact = false;
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: compact, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })));
  store = new GridStore();
  store.reset(model(), { view: COMPANY, canWrite: true });
});
afterEach(() => { vi.unstubAllGlobals(); });

type SaveNote = BudgetGridProps['onSaveNote'];
const ok = (note: string | null) => Promise.resolve({ ok: true as const, data: { note } });

function mount(over: Partial<BudgetGridProps> = {}) {
  const onSaveNote = vi.fn<SaveNote>((_id, note) => ok(note === null || note.trim() === '' ? null : note.trim()));
  const props: BudgetGridProps = {
    store, view: COMPANY, roundingUnit: 1, density: 'owner', showPy: true, compareLabel: null,
    canWrite: true, members: [], onSave: vi.fn(), onExit: vi.fn(() => false), fiscalYear: 2027, onSaveNote, ...over,
  };
  render(<BudgetGrid {...props} />);
  return props.onSaveNote as typeof onSaveNote;
}
const rowOf = (rowKey: string) => document.querySelector<HTMLElement>(`tr[data-row="${rowKey}"]`)!;
const rowIndex = (rowKey: string) => store.getLayout().rows.find((r) => r.key === rowKey)!.index;
const cellOf = (id: string, c: number) => document.querySelector<HTMLElement>(`[data-pos="${rowIndex(accountRowKey(id))}:${c}"]`)!;
const openMenu = (label: string) => fireEvent.click(screen.getByRole('button', { name: `Row actions for ${label}` }));

describe('editing a budget note from the grid', () => {
  it('Edit note… opens a labelled dialog with the year-scope helper; Save updates the icon and tooltip without a reload', async () => {
    const onSaveNote = mount();
    openMenu('1010 Account 1010');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit note…' }));
    const dialog = screen.getByRole('dialog', { name: 'Note for 1010 Account 1010' });
    const box = within(dialog).getByRole('textbox', { name: 'Note' });
    expect(box).toHaveValue(NOTE);
    expect(box).toHaveAccessibleDescription(/Shown on every version of FY2027/);
    fireEvent.change(box, { target: { value: '  Price rise moved to Q4  ' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save note' })); });
    expect(onSaveNote).toHaveBeenCalledWith(ID.rev2, '  Price rise moved to Q4  ');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const icon = within(rowOf(accountRowKey(ID.rev2))).getByRole('img', { name: 'Note: Price rise moved to Q4' });
    expect(icon).toHaveAttribute('title', 'Price rise moved to Q4');
    expect(document.activeElement).toBe(cellOf(ID.rev2, 0));
  });

  it('Add note… on a line without one; a cleared note removes the icon', async () => {
    mount();
    openMenu('1000 Account 1000');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add note…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'New line' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save note' })); });
    expect(within(rowOf(accountRowKey(ID.rev1))).getByRole('img', { name: 'Note: New line' })).toBeInTheDocument();
    openMenu('1010 Account 1010');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit note…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: '' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save note' })); });
    expect(within(rowOf(accountRowKey(ID.rev2))).queryByRole('img', { name: /^Note:/ })).toBeNull();
  });

  it('Escape closes without saving and puts focus back on the row', async () => {
    const onSaveNote = mount();
    openMenu('1010 Account 1010');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit note…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'not saved' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSaveNote).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(cellOf(ID.rev2, 0));
    expect(within(rowOf(accountRowKey(ID.rev2))).getByRole('img', { name: `Note: ${NOTE}` })).toBeInTheDocument();
  });

  it('a refusal keeps the dialog open with the server\'s message and the old note on the row', async () => {
    mount({ onSaveNote: vi.fn<SaveNote>(() => Promise.resolve({ ok: false as const, kind: 'locked' as const, message: 'This budget version is locked' })) });
    openMenu('1010 Account 1010');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit note…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'refused' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save note' })); });
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('This budget version is locked');
    expect(within(rowOf(accountRowKey(ID.rev2))).getByRole('img', { name: `Note: ${NOTE}` })).toBeInTheDocument();
  });

  it('a save that throws (it never should) shows a message and leaves the dialog usable', async () => {
    mount({ onSaveNote: vi.fn<SaveNote>(() => Promise.reject(new Error('socket hang up'))) });
    openMenu('1010 Account 1010');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit note…' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save note' })); });
    expect(within(screen.getByRole('dialog')).getByRole('alert')).toHaveTextContent('socket hang up');
    expect(screen.getByRole('button', { name: 'Save note' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('over 2 000 characters (after trimming) cannot be saved', async () => {
    const onSaveNote = mount();
    openMenu('1010 Account 1010');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit note…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: ` ${'x'.repeat(2000)} ` } });
    expect(screen.getByRole('button', { name: 'Save note' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'x'.repeat(2001) } });
    expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();
    expect(onSaveNote).not.toHaveBeenCalled();
  });

  it('unsaved amounts, the dirty count and undo survive a note save', async () => {
    mount();
    const key = viewCellKey(ID.rev1, COMPANY, MONTHS[2]!);
    act(() => { store.apply([{ key, cents: 12345 }]); });
    const revision = store.getRevision();
    openMenu('1010 Account 1010');
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit note…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'kept amounts' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save note' })); });
    expect(store.getMeta()).toMatchObject({ dirtyCount: 1, canUndo: true });
    expect(store.valueAt(key)).toBe(12345);
    expect(store.getRevision()).toBe(revision);
    act(() => { store.undo(); });
    expect(store.valueAt(key)).toBeNull();
    expect(within(rowOf(accountRowKey(ID.rev2))).getByRole('img', { name: 'Note: kept amounts' })).toBeInTheDocument();
  });

  it('Shift+F10 on a cell reaches the note action', async () => {
    mount();
    cellOf(ID.rev2, 3).focus();
    fireEvent.keyDown(cellOf(ID.rev2, 3), { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menuitem', { name: 'Edit note…' })).toBeInTheDocument();
  });

  it('no note action for a viewer or a locked version, a header roll-up or an inactive account', async () => {
    mount();
    fireEvent.click(within(rowOf(rollupRowKey(ID.hdr))).getByRole('button', { name: /^Row actions/ }));
    expect(await screen.findByRole('menuitem', { name: 'Spread across sub-accounts…' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /note…$/ })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    openMenu('3100 Account 3100');
    await screen.findAllByRole('menuitem');
    expect(screen.queryByRole('menuitem', { name: /note…$/ })).toBeNull();
  });

  it('read-only (viewer, or a locked version): no row actions at all, the note still shows', () => {
    const m = model();
    store.reset({ ...m, version: { ...m.version!, status: 'locked' } }, { view: COMPANY, canWrite: false });
    mount({ canWrite: false });
    expect(screen.queryByRole('button', { name: /^Row actions/ })).toBeNull();
    expect(within(rowOf(accountRowKey(ID.rev2))).getByRole('img', { name: `Note: ${NOTE}` })).toBeInTheDocument();
  });

  it('the phone sheet offers the same action and shows the saved note', async () => {
    compact = true;
    mount();
    fireEvent.mouseDown(cellOf(ID.rev2, 0), { button: 0 });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Edit note…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'From the phone' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save note' })); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.mouseDown(cellOf(ID.rev2, 0), { button: 0 });
    expect(within(screen.getByRole('dialog')).getByTestId('sheet-note')).toHaveTextContent('Note: From the phone');
  });
});
