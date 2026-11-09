/**
 * UXB (wave 5, review rounds 3-4): the bank grid's row stream. Hotkeys act on the row itself; the grid container takes
 * only the arrows; a held key does not chain accepts; Escape returns focus to the row the field is in; the stream's
 * index follows its row when the list is re-sorted.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { TXS, tableProps } from './bankTxTableFixture';

afterEach(() => { cleanup(); });

const rows = () => Array.from(document.querySelectorAll('tbody tr')) as HTMLElement[];
const rowOf = (text: string) => rows().find(r => r.textContent?.includes(text))!;
const grid = () => screen.getByRole('group', { name: /Bank transactions/ });

describe('the grid container', () => {
  it.each(['Enter', 'x', 's', 'e'])('takes no %s hotkey, even with a row held by the stream', (key) => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    fireEvent.click(rows()[0]!); // the stream holds row a, which can be accepted
    fireEvent.keyDown(grid(), { key });
    expect(p.onAccept).not.toHaveBeenCalled();
    expect(p.onExclude).not.toHaveBeenCalled();
    expect(p.onSplit).not.toHaveBeenCalled();
  });

  it('still takes the arrows: ArrowDown moves the stream on from the held row', () => {
    render(<BankTxTable {...tableProps()} />);
    fireEvent.click(rows()[0]!);
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    expect(rows()[1]).toHaveAttribute('data-focused', 'true');
  });
});

describe('a held key', () => {
  it.each([['Enter', 'onAccept'], ['x', 'onExclude'], ['s', 'onSplit']] as const)('a held %s is one press: the repeats call %s never, the press once', (key, handler) => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    const rowA = rows()[0]!;
    fireEvent.click(rowA);
    fireEvent.keyDown(rowA, { key, repeat: true });
    fireEvent.keyDown(rowA, { key, repeat: true });
    expect(p[handler]).not.toHaveBeenCalled();
    fireEvent.keyDown(rowA, { key });
    expect(p[handler]).toHaveBeenCalledTimes(1);
  });

  it('the arrows keep repeating', () => {
    render(<BankTxTable {...tableProps()} />);
    fireEvent.click(rows()[0]!);
    fireEvent.keyDown(rows()[0]!, { key: 'ArrowDown', repeat: true });
    expect(rows()[1]).toHaveAttribute('data-focused', 'true');
  });
});

describe('Escape', () => {
  it('from a field in a row the stream does not hold goes to that row', () => {
    render(<BankTxTable {...tableProps()} />);
    const rowC = rowOf('Client pay');
    fireEvent.click(rowC.querySelector('button[aria-label^="Add note"]') as HTMLElement); // opens the field (and holds row c)
    const field = screen.getByRole('textbox', { name: /^Note, / });
    fireEvent.click(rows()[0]!); // the stream now holds row a; the field stays open in row c
    expect(rows()[0]).toHaveAttribute('data-focused', 'true');
    field.focus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(document.activeElement).toBe(rowC);
    expect(rowC).toHaveAttribute('data-focused', 'true');
    expect(rows()[0]).not.toHaveAttribute('data-focused');
  });

  it('from a checkbox goes to the checkbox\'s own row', () => {
    render(<BankTxTable {...tableProps()} />);
    fireEvent.click(rows()[0]!);
    const rowC = rowOf('Client pay');
    const box = rowC.querySelector('input[type="checkbox"]') as HTMLElement;
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(document.activeElement).toBe(rowC);
  });
});

describe('the stream follows its row', () => {
  it('a re-sort moves data-focused with the row, not with the index', () => {
    const p = tableProps();
    const { rerender } = render(<BankTxTable {...p} />);
    fireEvent.click(rowOf('Client pay'));
    expect(rowOf('Client pay')).toHaveAttribute('data-focused', 'true');
    rerender(<BankTxTable {...p} transactions={[...TXS].reverse()} />);
    const focused = rows().filter(r => r.hasAttribute('data-focused'));
    expect(focused).toHaveLength(1);
    expect(focused[0]).toBe(rowOf('Client pay'));
  });
});

describe('modifier chords are not hotkeys', () => {
  const mods = ['ctrlKey', 'metaKey', 'altKey'] as const;
  const cases = mods.flatMap(m => ['Enter', 'x', 's', 'e'].map(k => [m, k] as const));
  it.each(cases)('%s + %s on the focused row does nothing and is left alone', (mod, key) => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    const rowA = rows()[0]!;
    fireEvent.click(rowA);
    const notPrevented = fireEvent.keyDown(rowA, { key, [mod]: true });
    expect(notPrevented).toBe(true);
    expect(p.onAccept).not.toHaveBeenCalled();
    expect(p.onExclude).not.toHaveBeenCalled();
    expect(p.onSplit).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: /^Search/ })).toBeNull();
  });
});

describe('a held E does not toggle the picker', () => {
  it('the repeat of E opens nothing; the press does', () => {
    render(<BankTxTable {...tableProps()} />);
    const rowA = rows()[0]!;
    fireEvent.click(rowA);
    fireEvent.keyDown(rowA, { key: 'e', repeat: true });
    expect(screen.queryByRole('textbox', { name: /^Search accounts$/ })).toBeNull();
    fireEvent.keyDown(rowA, { key: 'e' });
    expect(screen.getByRole('textbox', { name: /^Search accounts$/ })).toBeInTheDocument();
  });
});

describe('when the focused row leaves the list', () => {
  const without = (id: string) => TXS.filter(t => t.id !== id);
  /** Click and focus row a, as a user does: the stream holds it and focus is inside the grid. */
  const holdRowA = () => { fireEvent.click(rows()[0]!); rows()[0]!.focus(); return rows()[0]!; };
  const settled = () => act(async () => { await Promise.resolve(); });

  it('our exclude completed: the stream moves on and the next row is focused', async () => {
    const p = tableProps({ onExclude: vi.fn().mockResolvedValue(true) });
    const { rerender } = render(<BankTxTable {...p} />);
    fireEvent.keyDown(holdRowA(), { key: 'x' });
    await settled();
    rerender(<BankTxTable {...p} transactions={without('a')} />);
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows()[0]).toHaveAttribute('data-focused', 'true');
  });

  it('our accept completed, same length, row replaced: focus is on the row now at that index, not the body', async () => {
    const p = tableProps({ onAccept: vi.fn().mockResolvedValue(true) });
    const { rerender } = render(<BankTxTable {...p} />);
    fireEvent.keyDown(holdRowA(), { key: 'Enter' });
    await settled();
    const replaced = [{ ...TXS[1]!, id: 'z', description: 'Replacement' }, ...TXS.slice(1)];
    rerender(<BankTxTable {...p} transactions={replaced} />);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(rows()[0]);
  });

  it.each([
    ['exclude failed', 'x', 'onExclude'],
    ['split cancelled', 's', 'onSplit'],
    ['accept failed', 'Enter', 'onAccept'],
  ] as const)('%s, then a filter removes the row: the grid has focus, no row is picked', async (_name, key, handler) => {
    const p = tableProps({ [handler]: vi.fn().mockResolvedValue(false) });
    const { rerender } = render(<BankTxTable {...p} />);
    fireEvent.keyDown(holdRowA(), { key });
    await settled();
    rerender(<BankTxTable {...p} transactions={without('a')} />);
    expect(document.activeElement).toBe(grid());
    expect(rows().some(r => r.hasAttribute('data-focused'))).toBe(false);
    fireEvent.keyDown(grid(), { key: 'Enter' });
    expect(p.onAccept).toHaveBeenCalledTimes(key === 'Enter' ? 1 : 0);
  });

  it('an accept still in flight when a filter lands: the grid has focus, and the late success arms nothing', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const p = tableProps({ onAccept: vi.fn(() => new Promise<boolean>(r => { finish = r; })) });
    const { rerender } = render(<BankTxTable {...p} />);
    fireEvent.keyDown(holdRowA(), { key: 'Enter' });
    rerender(<BankTxTable {...p} transactions={without('a')} />);
    expect(document.activeElement).toBe(grid());
    await act(async () => { finish(true); await Promise.resolve(); });
    rerender(<BankTxTable {...p} transactions={without('a')} />);
    expect(document.activeElement).toBe(grid());
    expect(rows().some(r => r.hasAttribute('data-focused'))).toBe(false);
  });

  it('a completed action\'s mark serves the next list update only: a later filter is not ours', async () => {
    const p = tableProps({ onExclude: vi.fn().mockResolvedValue(true) });
    const { rerender } = render(<BankTxTable {...p} />);
    fireEvent.keyDown(holdRowA(), { key: 'x' });
    await settled();
    rerender(<BankTxTable {...p} transactions={[...TXS]} />); // the next update: row a is still there (a peer refresh)
    rerender(<BankTxTable {...p} transactions={without('a')} />); // now a filter takes it
    expect(document.activeElement).toBe(grid());
  });

  it('focus that never was in the grid is left alone', () => {
    const p = tableProps();
    const { rerender } = render(<BankTxTable {...p} />);
    fireEvent.click(rows()[0]!); // a click event alone does not focus
    expect(document.activeElement).toBe(document.body);
    rerender(<BankTxTable {...p} transactions={without('a')} />);
    expect(document.activeElement).toBe(document.body);
  });

  it('a filter typed in a field outside the grid does not take the focus', () => {
    const p = tableProps();
    const { rerender } = render(<div><input aria-label="outside" /><BankTxTable {...p} /></div>);
    holdRowA();
    const outside = screen.getByLabelText('outside');
    outside.focus();
    rerender(<div><input aria-label="outside" /><BankTxTable {...p} transactions={without('a')} /></div>);
    expect(document.activeElement).toBe(outside);
  });
});
