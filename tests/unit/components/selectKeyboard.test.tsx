/**
 * The kit Select by keyboard alone (wave-4 NS1). Focus stays on the trigger of a non-searchable select, so every
 * key is a keyDown on the trigger. The value changes only on Enter or a click: Tab, a stray letter and type-ahead
 * move the active option at most.
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Select } from '@/components/ui/Select';

const OPTIONS = [
  { value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'br', label: 'Bravo' },
  { value: 'c', label: 'Charlie' }, { value: 'd', label: 'Delta' },
];

function Harness({ initial = null, size }: { initial?: string | null; size?: 'sm' }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <Select label="Letter" options={OPTIONS} value={value} onChange={setValue} size={size} />
      <output data-testid="picked">{value ?? 'none'}</output>
    </>
  );
}
const trigger = () => screen.getByRole('combobox', { name: 'Letter' });
const key = (k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(trigger(), { key: k, ...init });
const picked = () => screen.getByTestId('picked').textContent;
const activeLabel = () => document.getElementById(trigger().id + '-listbox')?.querySelector('[role=option].bg-teal-50')?.textContent;

afterEach(cleanup);

describe('kit Select keyboard', () => {
  it('Enter on an open list chooses the active option', () => {
    render(<Harness />);
    key('Enter');
    key('ArrowDown'); key('ArrowDown');
    key('Enter');
    expect(picked()).toBe('b');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Space on an open list chooses the active option', () => {
    render(<Harness />);
    key('Enter');
    key('ArrowDown'); key('ArrowDown');
    key(' ');
    expect(picked()).toBe('b');
  });

  it('Tab closes the list without changing the value', () => {
    render(<Harness initial="d" />);
    key('ArrowDown'); key('ArrowUp');
    key('Tab');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(picked()).toBe('d');
  });

  it('a stray letter never changes the value, open or closed', () => {
    render(<Harness initial="a" />);
    key('c');
    expect(picked()).toBe('a');
    expect(activeLabel()).toBe('Charlie');
    key('Escape');
    key('d');
    expect(picked()).toBe('a');
  });

  it('type-ahead moves the active option to the next label with the prefix, then Enter chooses it', () => {
    render(<Harness />);
    key('b');
    expect(activeLabel()).toBe('Beta');
    key('b');
    expect(activeLabel()).toBe('Bravo');
    key('Enter');
    expect(picked()).toBe('br');
  });

  it('a longer prefix refines rather than cycles', () => {
    render(<Harness />);
    key('b'); key('r');
    expect(activeLabel()).toBe('Bravo');
  });

  it('Home and End jump to the first and last option', () => {
    render(<Harness />);
    key('ArrowDown');
    key('End');
    expect(activeLabel()).toBe('Delta');
    key('Home');
    expect(activeLabel()).toBe('Alpha');
  });

  it('ArrowDown on a closed trigger opens on the current value', () => {
    render(<Harness initial="c" />);
    key('ArrowDown');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(activeLabel()).toBe('Charlie');
  });

  it('Ctrl+letter is left to the browser', () => {
    render(<Harness />);
    key('b', { ctrlKey: true });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('size="sm" draws a compact trigger of at least 32px', () => {
    render(<Harness size="sm" />);
    expect(trigger().className).toContain('min-h-[32px]');
    expect(trigger().className).toContain('text-xs');
  });
});
