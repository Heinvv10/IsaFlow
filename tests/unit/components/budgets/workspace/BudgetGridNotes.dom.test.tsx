/**
 * Budget notes are read-only on the grid (PR-D review M1): the old page showed and saved
 * `accounting_budgets.notes`; the read model now carries each account's note for the version's
 * year (`GridAccount.note`). An account line or header roll-up with a note shows a note icon whose
 * accessible name and tooltip carry the text; the phone sheet shows the text itself. No icon for
 * an account without one, and nothing here edits a note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BudgetGrid, type BudgetGridProps } from '@/components/accounting/budgets/workspace/BudgetGrid';
import { GridStore, accountRowKey, rollupRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import { ID, gridModel } from './gridFixture';

const COMPANY = { kind: 'company' } as const;
const NOTE = 'Includes the Q3 price rise agreed with the board';
const HEADER_NOTE = 'Premises: lease renewal in March';

/** The fixture with a note on 1010 and on the 3000 header, as the read model carries them. */
function withNotes() {
  const m = gridModel();
  return { ...m, accounts: m.accounts.map((a) => (a.id === ID.rev2 ? { ...a, note: NOTE } : a.id === ID.hdr ? { ...a, note: HEADER_NOTE } : a)) };
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
  store.reset(withNotes(), { view: COMPANY, canWrite: true });
});
afterEach(() => { vi.unstubAllGlobals(); });

function mount(over: Partial<BudgetGridProps> = {}) {
  const props: BudgetGridProps = {
    store, view: COMPANY, roundingUnit: 1, density: 'owner', showPy: true, compareLabel: null,
    canWrite: true, members: [], onSave: vi.fn(), onExit: vi.fn(() => false), ...over,
  };
  return render(<BudgetGrid {...props} />);
}
const rowOf = (rowKey: string) => document.querySelector<HTMLElement>(`tr[data-row="${rowKey}"]`)!;
const rowIndex = (rowKey: string) => store.getLayout().rows.find((r) => r.key === rowKey)!.index;

describe('budget notes on the grid', () => {
  it('a line with a note shows a note icon carrying the text as its name and tooltip; a line without one shows none', () => {
    mount();
    const icon = within(rowOf(accountRowKey(ID.rev2))).getByRole('img', { name: `Note: ${NOTE}` });
    expect(icon).toHaveAttribute('title', NOTE);
    expect(within(rowOf(accountRowKey(ID.rev2))).getByRole('rowheader')).toHaveAccessibleName(new RegExp(`Note: ${NOTE}`));
    expect(within(rowOf(accountRowKey(ID.rev1))).queryByRole('img', { name: /^Note:/ })).toBeNull();
  });

  it('a header roll-up with a note shows it too', () => {
    mount();
    expect(within(rowOf(rollupRowKey(ID.hdr))).getByRole('img', { name: `Note: ${HEADER_NOTE}` })).toHaveAttribute('title', HEADER_NOTE);
  });

  it('read-only: a locked version still shows the note, and there is nothing to edit it with', () => {
    const m = withNotes();
    store.reset({ ...m, version: { ...m.version!, status: 'locked' } }, { view: COMPANY, canWrite: false });
    mount({ canWrite: false });
    expect(within(rowOf(accountRowKey(ID.rev2))).getByRole('img', { name: `Note: ${NOTE}` })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /note/i })).toBeNull();
  });

  it('the phone sheet shows the note as text', () => {
    compact = true;
    mount();
    fireEvent.mouseDown(document.querySelector<HTMLElement>(`[data-pos="${rowIndex(accountRowKey(ID.rev2))}:0"]`)!, { button: 0 });
    expect(within(screen.getByRole('dialog')).getByTestId('sheet-note')).toHaveTextContent(`Note: ${NOTE}`);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    fireEvent.mouseDown(document.querySelector<HTMLElement>(`[data-pos="${rowIndex(accountRowKey(ID.rev1))}:0"]`)!, { button: 0 });
    expect(within(screen.getByRole('dialog')).queryByTestId('sheet-note')).toBeNull();
  });
});
