/**
 * UXB (wave 5, review rounds 3-4): the bank grid's row stream. Hotkeys act on the row itself; the grid container takes
 * only the arrows; a held key does not chain accepts; Escape returns focus to the row the field is in; the stream's
 * index follows its row when the list is re-sorted.
 */
import { afterEach, describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
  it('accepts once: the repeats of Enter, X and S do nothing', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    const rowA = rows()[0]!;
    fireEvent.click(rowA);
    for (const key of ['Enter', 'x', 's']) fireEvent.keyDown(rowA, { key, repeat: true });
    expect(p.onAccept).not.toHaveBeenCalled();
    expect(p.onExclude).not.toHaveBeenCalled();
    expect(p.onSplit).not.toHaveBeenCalled();
    fireEvent.keyDown(rowA, { key: 'Enter' });
    expect(p.onAccept).toHaveBeenCalledTimes(1);
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
