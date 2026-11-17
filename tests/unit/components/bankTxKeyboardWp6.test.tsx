/**
 * WP6 UI, fast review path: J/K move the rows like the arrows; Enter accepts and focus stays on the next row; in the
 * Selection popover Enter picks the first match and the arrows move along the matches.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { resolveBankTxKey } from '@/components/accounting/bankTxKeyboard';
import { popoverChoices, nextPopoverIndex } from '@/components/accounting/bankTx/bankTxOptions';
import { TXS, tableProps } from './bankTxTableFixture';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
afterEach(cleanup);

const rows = () => Array.from(document.querySelectorAll('tbody tr')) as HTMLElement[];
const search = () => screen.getByRole('textbox', { name: /^Search accounts$/ });
const settled = () => act(async () => { await Promise.resolve(); });

describe('J and K', () => {
  const row = { isEditingCell: false, canAccept: true };
  it('resolve to next and previous, either case', () => {
    expect(['j', 'J'].map((k) => resolveBankTxKey(k, row))).toEqual(['next', 'next']);
    expect(['k', 'K'].map((k) => resolveBankTxKey(k, row))).toEqual(['prev', 'prev']);
  });
  it('are plain letters while a field is being typed in', () => {
    const typing = { isEditingCell: true, canAccept: true };
    expect(resolveBankTxKey('j', typing)).toBeNull();
    expect(resolveBankTxKey('k', typing)).toBeNull();
  });
  it('move the focused row in the grid, and K stops at the first row', () => {
    render(<BankTxTable {...tableProps()} />);
    fireEvent.click(rows()[0]!);
    fireEvent.keyDown(rows()[0]!, { key: 'j' });
    expect(rows()[1]).toHaveAttribute('data-focused', 'true');
    fireEvent.keyDown(rows()[1]!, { key: 'k' });
    fireEvent.keyDown(rows()[0]!, { key: 'K' });
    expect(rows()[0]).toHaveAttribute('data-focused', 'true');
  });
});

describe('accept then keep going', () => {
  it('J to a row, Enter accepts it, and focus is on the row that follows once it leaves', async () => {
    const onAccept = vi.fn().mockResolvedValue(true);
    const p = tableProps({ onAccept });
    const { rerender } = render(<BankTxTable {...p} />);
    fireEvent.click(rows()[0]!); rows()[0]!.focus();
    fireEvent.keyDown(rows()[0]!, { key: 'j' });
    fireEvent.keyDown(rows()[1]!, { key: 'k' });
    fireEvent.keyDown(rows()[0]!, { key: 'Enter' });
    expect(onAccept).toHaveBeenCalledWith('a');
    await settled();
    rerender(<BankTxTable {...p} transactions={TXS.filter((t) => t.id !== 'a')} />);
    expect(document.activeElement).toBe(rows()[0]);
    expect(rows()[0]).toHaveAttribute('data-focused', 'true');
    expect(rows()[0]!.textContent).toContain('Pending row');
  });
});

describe('the Selection popover', () => {
  const openOn = (props = tableProps()) => {
    render(<BankTxTable {...props} />);
    fireEvent.click(rows()[0]!);
    fireEvent.keyDown(rows()[0]!, { key: 'e' });
    return props;
  };

  it('Enter picks the pinned suggestion when nothing is typed', () => {
    const p = openOn();
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(p.onRowEntityChange).toHaveBeenCalledWith('a', 'g1', '6100 Entertainment');
    expect(p.onAccept).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: /^Search accounts$/ })).toBeNull();
  });

  it('Enter picks the first match of what was typed', () => {
    const p = openOn();
    fireEvent.change(search(), { target: { value: 'don' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(p.onRowEntityChange).toHaveBeenCalledWith('a', 'g2', '7000 Donations');
  });

  it('the arrows move along the matches and Enter picks the one reached', () => {
    const p = openOn();
    fireEvent.keyDown(search(), { key: 'ArrowDown' }); // pinned suggestion, then 6100, then 7000
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    const active = document.querySelector('[data-active]') as HTMLElement;
    expect(search().getAttribute('aria-activedescendant')).toBe(active.id);
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(p.onRowEntityChange).toHaveBeenCalledTimes(1);
    expect(p.onRowEntityChange).toHaveBeenCalledWith('a', 'g2', '7000 Donations');
  });

  it('ArrowUp at the top stays on the first; typing starts again from the first match', () => {
    const p = openOn();
    fireEvent.keyDown(search(), { key: 'ArrowUp' });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.change(search(), { target: { value: 'don' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(p.onRowEntityChange).toHaveBeenCalledWith('a', 'g2', '7000 Donations');
  });

  it('Enter with no match does nothing (and does not accept the row)', () => {
    const p = openOn();
    fireEvent.change(search(), { target: { value: 'zzzzzz' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(p.onRowEntityChange).not.toHaveBeenCalled();
    expect(p.onAccept).not.toHaveBeenCalled();
  });
});

describe('popover helpers', () => {
  it('the pinned suggestion leads only while nothing is typed', () => {
    const opts = [{ id: 'g2', name: 'Donations', code: '7000' }];
    expect(popoverChoices(TXS[0]!, 'account', '', opts).map((o) => o.id)).toEqual(['g1', 'g2']);
    expect(popoverChoices(TXS[0]!, 'account', 'don', opts).map((o) => o.id)).toEqual(['g2']);
  });
  it('arrows clamp; other keys are not ours', () => {
    expect(nextPopoverIndex('ArrowDown', 1, 2)).toBe(1);
    expect(nextPopoverIndex('ArrowUp', 0, 2)).toBe(0);
    expect(nextPopoverIndex('a', 0, 2)).toBeNull();
    expect(nextPopoverIndex('ArrowDown', 0, 0)).toBeNull();
  });
});
