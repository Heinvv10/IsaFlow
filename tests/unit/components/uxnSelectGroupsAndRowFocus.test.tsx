/** UXN (wave 5): kit Select option groups and keyboard, and a row-opened drawer giving focus back to its row. */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Select, type SelectOption } from '@/components/ui/Select';
import { groupHeadingAt } from '@/components/ui/selectGroups';
import { Drawer } from '@/components/ui/Drawer';
import { useRestoreRowFocus } from '@/components/accounting/customer-invoices/useRestoreRowFocus';

afterEach(cleanup);

const OPTIONS: SelectOption[] = [
  { value: 'p1', label: 'Primary' },
  { value: 'c1', label: 'Child one', group: 'Umbrella' },
  { value: 'c2', label: 'Child two', group: 'Umbrella', disabled: true },
  { value: 'c3', label: 'Child three', group: 'Umbrella' },
  { value: 'd1', label: 'Other child', group: 'Second' },
];

describe('groupHeadingAt', () => {
  it('names a group only at its first option', () => {
    expect(OPTIONS.map((_, i) => groupHeadingAt(OPTIONS, i))).toEqual([null, 'Umbrella', null, null, 'Second']);
  });

  it('groups are positional: A, B, A gets three headings, in place, never merged', () => {
    const o: SelectOption[] = [
      { value: '1', label: 'a1', group: 'A' }, { value: '2', label: 'b1', group: 'B' }, { value: '3', label: 'a2', group: 'A' },
    ];
    expect(o.map((_, i) => groupHeadingAt(o, i))).toEqual(['A', 'B', 'A']);
  });
});

function setup() {
  const picked: (string | null)[] = [];
  render(<Select label="Bank" options={OPTIONS} value={null} onChange={(v) => picked.push(v)} />);
  const box = screen.getByRole('combobox');
  fireEvent.click(box);
  return { box, picked };
}
const key = (box: HTMLElement, k: string) => fireEvent.keyDown(box, { key: k });

describe('Select option groups', () => {
  it('each heading is a presentational row directly before its group\'s first option; options stay the only listbox options', () => {
    setup();
    expect(screen.getAllByRole('option')).toHaveLength(5);
    const items = Array.from(screen.getByRole('listbox').children);
    const text = items.map((li) => li.textContent);
    expect(text.indexOf('Umbrella')).toBe(text.indexOf('Child one') - 1);
    expect(text.indexOf('Second')).toBe(text.indexOf('Other child') - 1);
    expect(items[text.indexOf('Umbrella')]!.getAttribute('role')).toBe('presentation');
  });

  it('ArrowDown reaches the first child; ArrowUp from the next group steps back over the heading and the boundary', () => {
    const { box, picked } = setup();
    key(box, 'ArrowDown'); key(box, 'ArrowDown'); // Primary, Child one
    key(box, 'ArrowDown'); key(box, 'ArrowDown'); // Child two is disabled: skipped, Child three, then Other child
    key(box, 'ArrowDown');
    key(box, 'ArrowUp'); // back to Child three across the group boundary
    key(box, 'Enter');
    expect(picked).toEqual(['c3']);
  });

  it('a disabled option inside a group cannot be chosen by click or keys', () => {
    const { box, picked } = setup();
    fireEvent.click(screen.getByRole('option', { name: 'Child two' }));
    expect(picked).toEqual([]);
    key(box, 'ArrowDown'); key(box, 'ArrowDown'); key(box, 'ArrowDown'); // Primary, Child one, Child three (skips two)
    key(box, 'Enter');
    expect(picked).toEqual(['c3']);
  });

  it('search matches option labels only, not group names', () => {
    render(<Select label="Searchy" searchable options={OPTIONS} value={null} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('combobox'));
    const search = screen.getByRole('textbox', { name: /Search/ });
    fireEvent.change(search, { target: { value: 'Umbrella' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    fireEvent.change(search, { target: { value: 'Other' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('Second')).toBeTruthy();
  });
});

function Harness({ gen = 0, drop = false }: { gen?: number; drop?: boolean }) {
  const [id, setId] = useState<string | null>(null);
  const remember = useRestoreRowFocus(id);
  return (
    <>
      <table data-testid="table"><tbody>
        {!drop && <tr key={gen} data-row-id="r1" data-testid="row" onClick={(e) => { remember(e.currentTarget); setId('x'); }}><td>Acme</td></tr>}
      </tbody></table>
      <Drawer open={id !== null} onClose={() => setId(null)} title="Invoice"><button>Inside</button></Drawer>
    </>
  );
}
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

describe('useRestoreRowFocus', () => {
  it('Escape returns focus to the clicked row, not BODY', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Acme'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    escape();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('row'));
  });

  it('the row replaced under the open drawer (a refetch): focus goes to the new row with the same id, not a detached node', () => {
    const view = render(<Harness />);
    const old = screen.getByTestId('row');
    fireEvent.click(screen.getByText('Acme'));
    view.rerender(<Harness gen={1} />);
    expect(old.isConnected).toBe(false);
    escape();
    const fresh = screen.getByTestId('row');
    expect(fresh).not.toBe(old);
    expect(document.activeElement).toBe(fresh);
  });

  it('the row gone from the list (a sort or filter): focus falls back to its table', () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByText('Acme'));
    view.rerender(<Harness drop />);
    escape();
    expect(document.activeElement).toBe(screen.getByTestId('table'));
  });
});
