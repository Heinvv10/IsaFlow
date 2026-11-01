/**
 * A real mouse press reaches the document's outside-press listener before the click. The options live in a portal, so
 * they are outside the trigger: the press must not count as outside the control, or the panel unmounts under the
 * pointer, the click never lands and nothing can be picked with a mouse (fireEvent.click alone never showed it).
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Select } from '@/components/ui/Select';

const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }];

function Harness({ searchable }: { searchable?: boolean }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <Select label="Letter" options={OPTIONS} value={value} onChange={setValue} searchable={searchable ?? false} />
      <output>{value ?? 'none'}</output>
      <button>elsewhere</button>
    </>
  );
}
const open = () => fireEvent.click(screen.getByRole('combobox', { name: 'Letter' }));
const mouseClick = (el: Element) => { fireEvent.mouseDown(el); fireEvent.mouseUp(el); fireEvent.click(el); };

afterEach(cleanup);

describe('picking with a mouse', () => {
  it('a press on an option keeps the panel open until its click picks it', () => {
    render(<Harness />);
    open();
    mouseClick(screen.getByRole('option', { name: 'Beta' }));
    expect(screen.getByRole('status', { hidden: true }).textContent).toBe('b');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a press in the search box does not close the panel', () => {
    render(<Harness searchable />);
    open();
    mouseClick(screen.getByLabelText('Search Letter'));
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('a press outside the control still closes it', () => {
    render(<Harness />);
    open();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
