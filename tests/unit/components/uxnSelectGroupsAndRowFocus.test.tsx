/** UXN (wave 5): kit Select option groups, and a row-opened drawer giving focus back to its row. */
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
  { value: 'c2', label: 'Child two', group: 'Umbrella' },
  { value: 'd1', label: 'Other child', group: 'Second' },
];

describe('groupHeadingAt', () => {
  it('names a group only at its first option', () => {
    expect(OPTIONS.map((_, i) => groupHeadingAt(OPTIONS, i))).toEqual([null, 'Umbrella', null, 'Second']);
  });
});

describe('Select option groups', () => {
  it('draws one heading per group, not as an option, and keyboard order stays over the options', () => {
    const picked: (string | null)[] = [];
    render(<Select label="Bank" options={OPTIONS} value={null} onChange={(v) => picked.push(v)} />);
    const box = screen.getByRole('combobox');
    fireEvent.click(box);
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(screen.getByText('Umbrella')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(picked).toEqual(['c1']);
  });
});

function Harness() {
  const [id, setId] = useState<string | null>(null);
  const remember = useRestoreRowFocus(id);
  return (
    <>
      <table><tbody><tr tabIndex={-1} data-testid="row" onClick={(e) => { remember(e.currentTarget); setId('x'); }}><td>Acme</td></tr></tbody></table>
      <Drawer open={id !== null} onClose={() => setId(null)} title="Invoice"><button>Inside</button></Drawer>
    </>
  );
}

describe('useRestoreRowFocus', () => {
  it('Escape returns focus to the row that opened the drawer, not BODY', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Acme'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('row'));
  });
});
