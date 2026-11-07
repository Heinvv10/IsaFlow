/**
 * The kit Select by keyboard alone (wave-4 NS1). Focus stays on the trigger of a non-searchable select, so every
 * key is a keyDown on the trigger. The value changes only on Enter or a click: Tab, a stray letter and type-ahead
 * move the active option at most.
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('kit Select keyboard: review findings', () => {
  const BANKS = [{ value: 'a', label: 'Alpha' }, { value: 'bank charges', label: 'Bank charges' }, { value: 'c', label: 'Charlie' }];
  const Host = ({ options = BANKS, value = null as string | null, searchable = false, onSearch }: { options?: typeof BANKS; value?: string | null; searchable?: boolean; onSearch?: (q: string) => void }) => {
    const [v, setV] = useState<string | null>(value);
    return <><Select label="Letter" options={options} value={v} onChange={setV} searchable={searchable} onSearch={onSearch} /><output data-testid="picked">{v ?? 'none'}</output><button>after</button></>;
  };

  it('Space inside a live type-ahead prefix is part of it, not a choice', () => {
    render(<Host />);
    for (const k of ['b', 'a', 'n', 'k']) key(k);
    key(' ');
    expect(picked()).toBe('none');
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(activeLabel()).toBe('Bank charges');
    key('c'); key('h');
    expect(activeLabel()).toBe('Bank charges');
    expect(picked()).toBe('none');
  });

  it('arrows, Home and End skip disabled options', () => {
    const options = [{ value: 'a', label: 'A', disabled: true }, { value: 'b', label: 'B' }, { value: 'c', label: 'C', disabled: true }, { value: 'd', label: 'D' }, { value: 'e', label: 'E', disabled: true }];
    render(<Host options={options} />);
    key('Home');
    expect(activeLabel()).toBe('B');
    key('ArrowDown');
    expect(activeLabel()).toBe('D');
    key('ArrowDown');
    expect(activeLabel()).toBe('D');
    key('End');
    expect(activeLabel()).toBe('D');
    key('ArrowUp');
    expect(activeLabel()).toBe('B');
  });

  it('ArrowUp on a closed trigger opens on the current value; type-ahead starts from it', () => {
    render(<Host value="c" />);
    key('ArrowUp');
    expect(activeLabel()).toBe('Charlie');
    key('Escape');
    key('a');
    expect(activeLabel()).toBe('Alpha');
  });

  it('type-ahead on a closed trigger starts after the selected option, not from the top', () => {
    render(<Host options={[{ value: 'a', label: 'Alpha' }, { value: 'bank charges', label: 'Bank charges' }, { value: 'beta', label: 'Beta' }]} value="bank charges" />);
    key('b');
    expect(activeLabel()).toBe('Beta');
  });

  it('Enter on the clear button clears the value and leaves focus on the trigger', () => {
    const Clearable = () => {
      const [v, setV] = useState<string | null>('c');
      return <><Select label="Letter" options={BANKS} value={v} onChange={setV} clearable /><output data-testid="picked">{v ?? 'none'}</output></>;
    };
    render(<Clearable />);
    const clear = screen.getByRole('button', { name: 'Clear selection' });
    clear.focus();
    fireEvent.click(clear); // a keyboard Enter on a button fires click
    expect(picked()).toBe('none');
    expect(document.activeElement).toBe(trigger());
  });

  it('the open trigger names the active option (aria-activedescendant), by an id with no whitespace', () => {
    render(<Host />);
    key('Enter'); key('ArrowDown'); key('ArrowDown');
    const id = trigger().getAttribute('aria-activedescendant')!;
    expect(id).toBeTruthy();
    expect(id).not.toMatch(/\s/);
    expect(document.getElementById(id)!.textContent).toBe('Bank charges');
    key('Escape');
    expect(trigger().getAttribute('aria-activedescendant')).toBeNull();
  });

  it('a searchable select keeps the first key typed on the closed trigger: opens, seeds the search, reports it', () => {
    const onSearch = vi.fn();
    render(<Host searchable onSearch={onSearch} />);
    key('c');
    expect((screen.getByLabelText('Search Letter') as HTMLInputElement).value).toBe('c');
    expect(onSearch).toHaveBeenCalledWith('c');
    cleanup();
    render(<Host searchable />);
    key('c');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Bank charges', 'Charlie']);
  });

  it('Tab out of the search box returns focus to the trigger and is not cancelled', () => {
    render(<Host searchable />);
    key('Enter');
    const proceeded = fireEvent.keyDown(screen.getByLabelText('Search Letter'), { key: 'Tab' });
    expect(proceeded).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('a press in the panel keeps focus on the trigger, so a multi-select keeps its keyboard', () => {
    function Multi() {
      const [v, setV] = useState<string[]>([]);
      return <><Select label="Letter" multiple options={OPTIONS} value={v} onChange={setV} /><output data-testid="picked">{v.join(',') || 'none'}</output></>;
    }
    render(<Multi />);
    trigger().focus();
    key('Enter');
    const beta = screen.getByRole('option', { name: 'Beta' });
    expect(fireEvent.mouseDown(beta)).toBe(false); // default prevented: focus is not taken
    fireEvent.click(beta);
    expect(document.activeElement).toBe(trigger());
    key('End'); key(' ');
    expect(picked()).toBe('b,d');
  });

  it('Home and End on a closed trigger are handled, and the clear button keeps its own Enter and Space', () => {
    function Clearable() {
      const [v, setV] = useState<string | null>('a');
      return <Select label="Letter" clearable options={OPTIONS} value={v} onChange={setV} />;
    }
    render(<Clearable />);
    expect(fireEvent.keyDown(trigger(), { key: 'Home' })).toBe(false);
    key('Escape');
    expect(fireEvent.keyDown(trigger(), { key: 'End' })).toBe(false);
    key('Escape');
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'Clear selection' }), { key: 'Enter' })).toBe(true);
  });

  it('a click on the label focuses the trigger', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Letter'));
    expect(document.activeElement).toBe(trigger());
  });
});

describe('kit Select: the active option is tracked by value', () => {
  // Options can change while the list is open (results arriving, a parent re-render): the highlight stays on the
  // option the user moved to, and Enter chooses that option, not whichever one now sits at its old index.
  function Growing({ searchable }: { searchable?: boolean }) {
    const [value, setValue] = useState<string | null>(null);
    const [opts, setOpts] = useState(OPTIONS);
    return (
      <>
        <Select label="Letter" options={opts} value={value} onChange={setValue} searchable={searchable} />
        <button type="button" onClick={() => setOpts([{ value: 'aa', label: 'Aardvark' }, ...OPTIONS])}>insert</button>
        <output data-testid="picked">{value ?? 'none'}</output>
      </>
    );
  }

  it('an option inserted before the active one does not move the choice', () => {
    render(<Growing />);
    key('Enter');
    key('ArrowDown'); key('ArrowDown'); key('ArrowDown'); // Alpha, Beta, Bravo
    expect(activeLabel()).toBe('Bravo');
    fireEvent.click(screen.getByRole('button', { name: 'insert' }));
    expect(activeLabel()).toBe('Bravo');
    key('Enter');
    expect(picked()).toBe('br');
  });

  it('a searchable list keeps its active option when options are inserted', () => {
    render(<Growing searchable />);
    fireEvent.click(trigger());
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'ArrowDown' }); fireEvent.keyDown(box, { key: 'ArrowDown' }); // Alpha, Beta
    fireEvent.click(screen.getByRole('button', { name: 'insert' }));
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(picked()).toBe('b');
  });
});
