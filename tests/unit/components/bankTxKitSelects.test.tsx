/**
 * NS2 (wave 4): the bank grid's type, VAT, CC1, CC2 and BU cells are kit Selects. Each must call its handler with
 * exactly the arguments the native <select> sent (accept builds the posted journal from them), keep the s17(2)(a) and
 * non-supply warnings and their amber state, and be choosable by keyboard without a key reaching the grid's
 * row-stream hotkeys (Enter accepts, X excludes, S splits a row).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { rowLabel } from '@/components/accounting/bankTx/bankTxRowLabel';
import { TXS, SELECTIONS, tableProps } from './bankTxTableFixture';

const row = (id: string) => rowLabel(TXS.find(t => t.id === id)!);
const cell = (name: string, id = 'a') => screen.getByRole('combobox', { name: `${name}, ${row(id)}` });

function choose(name: string, option: string) {
  fireEvent.click(cell(name));
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }));
}

describe('bank grid cells: the kit Select calls each handler with the native select\'s arguments', () => {
  // [cell, option chosen, handler, the arguments the native select passed for that value]. Row a holds
  // type account, VAT standard, CC1 x, CC2 '', BU '' (bankTxTableFixture SELECTIONS.a).
  const TABLE: [string, string, 'onRowTypeChange' | 'onRowVatChange' | 'onRowDimensionChange', unknown[]][] = [
    ['Allocation type', 'Transfer', 'onRowTypeChange', ['a', 'transfer']],
    ['Allocation type', 'Supplier', 'onRowTypeChange', ['a', 'supplier']],
    ['VAT', 'Zero Rated', 'onRowVatChange', ['a', 'zero_rated']],
    ['VAT', 'No VAT', 'onRowVatChange', ['a', 'none']],
    ['Cost centre 1', '—', 'onRowDimensionChange', ['a', '', '', '']],
    ['Cost centre 2', 'Y', 'onRowDimensionChange', ['a', 'x', 'y', '']],
    ['Business unit', 'Z', 'onRowDimensionChange', ['a', 'x', '', 'z']],
  ];
  it.each(TABLE)('%s -> %s calls %s(%j)', (name, option, handler, args) => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    choose(name, option);
    expect(p[handler]).toHaveBeenCalledTimes(1);
    expect(p[handler]).toHaveBeenCalledWith(...args);
  });

  it('CC1 and CC2 keep their own positions when the other one is set', () => {
    const p = tableProps({ rowSelections: { ...SELECTIONS, a: { ...SELECTIONS.a!, cc1Id: '', cc2Id: 'y', buId: 'z' } } });
    render(<BankTxTable {...p} />);
    choose('Cost centre 1', 'X Xn');
    expect(p.onRowDimensionChange).toHaveBeenLastCalledWith('a', 'x', 'y', 'z');
  });

  it('each trigger shows the row\'s current value', () => {
    render(<BankTxTable {...tableProps()} />);
    expect(cell('Allocation type')).toHaveTextContent('Account');
    expect(cell('VAT')).toHaveTextContent('Standard 15%');
    expect(cell('Cost centre 1')).toHaveTextContent('X Xn');
    expect(cell('Cost centre 2')).toHaveTextContent('—');
    expect(cell('Business unit')).toHaveTextContent('—');
  });

  it('no native select is left in the grid', () => {
    const { container } = render(<BankTxTable {...tableProps()} />);
    expect(container.querySelectorAll('select')).toHaveLength(0);
  });
});

describe('bank grid VAT cell: the warnings keep their text and their amber state', () => {
  it('s17(2)(a): standard VAT on an entertainment account warns, amber, and describes the select', () => {
    render(<BankTxTable {...tableProps()} />);
    expect(screen.getByText('⚠ Entertainment — input tax normally denied')).toBeInTheDocument();
    expect(cell('VAT')).toHaveAccessibleDescription('⚠ Entertainment — input tax normally denied');
    expect(cell('VAT').closest('[data-vat-warn]')).toHaveAttribute('data-vat-warn', 'true');
    expect(cell('VAT').closest('[data-vat-warn]')!.className).toContain('!border-amber-500');
  });

  it('no warning, no amber, once VAT is not claimed', () => {
    render(<BankTxTable {...tableProps({ rowSelections: { ...SELECTIONS, a: { ...SELECTIONS.a!, vatCode: 'none' } } })} />);
    expect(screen.queryByText(/input tax normally denied/)).toBeNull();
    expect(cell('VAT').closest('[data-vat-warn]')).toHaveAttribute('data-vat-warn', 'false');
    expect(cell('VAT').closest('[data-vat-warn]')!.className).not.toContain('amber');
  });

  it('non-supply: standard VAT on a donations account warns that no supply arises (text only, as before)', () => {
    render(<BankTxTable {...tableProps({ rowSelections: { a: { type: 'account', entityId: 'g2', label: '7000 Donations', vatCode: 'standard' } } })} />);
    expect(cell('VAT')).toHaveAccessibleDescription(/no supply, so no VAT/);
    expect(screen.getByText(/no supply, so no VAT/)).toHaveClass('text-amber-700');
    expect(cell('VAT').closest('[data-vat-warn]')).toHaveAttribute('data-vat-warn', 'false');
  });
});

describe('bank grid cells: chosen by keyboard, and no key reaches the row hotkeys', () => {
  it('ArrowDown opens the VAT cell on its value, Enter chooses; the row is not accepted', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    const grid = screen.getByRole('group', { name: /Bank transactions/ });
    fireEvent.keyDown(grid, { key: 'ArrowDown' }); // row a is in the stream and can be accepted
    const vat = cell('VAT');
    vat.focus();
    fireEvent.keyDown(vat, { key: 'ArrowDown' }); // opens on Standard 15%
    expect(vat).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(vat, { key: 'ArrowDown' });
    fireEvent.keyDown(vat, { key: 'Enter' });
    expect(p.onRowVatChange).toHaveBeenCalledTimes(1);
    expect(p.onRowVatChange).toHaveBeenCalledWith('a', 'zero_rated');
    expect(p.onAccept).not.toHaveBeenCalled();
  });

  it('type-ahead letters on a cell are not X / S / E hotkeys, and change no value', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    fireEvent.keyDown(screen.getByRole('group', { name: /Bank transactions/ }), { key: 'ArrowDown' });
    const type = cell('Allocation type');
    type.focus();
    for (const key of ['x', 's', 'e', 'S']) fireEvent.keyDown(type, { key });
    expect(p.onExclude).not.toHaveBeenCalled();
    expect(p.onSplit).not.toHaveBeenCalled();
    expect(p.onRowTypeChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: /^Search (accounts|suppliers|customers)/ })).toBeNull();
  });

  it('a searchable CC cell chooses from its search box with Enter, without accepting the row', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    fireEvent.keyDown(screen.getByRole('group', { name: /Bank transactions/ }), { key: 'ArrowDown' });
    const cc2 = cell('Cost centre 2');
    cc2.focus();
    fireEvent.keyDown(cc2, { key: 'Enter' });
    const search = screen.getByRole('textbox', { name: `Search Cost centre 2, ${row('a')}` });
    fireEvent.change(search, { target: { value: 'Y' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(p.onRowDimensionChange).toHaveBeenCalledWith('a', 'x', 'y', '');
    expect(p.onAccept).not.toHaveBeenCalled();
  });

  it('Escape closes an open cell and keeps focus on it; a second Escape returns to the row', () => {
    render(<BankTxTable {...tableProps()} />);
    fireEvent.keyDown(screen.getByRole('group', { name: /Bank transactions/ }), { key: 'ArrowDown' });
    const vat = cell('VAT');
    vat.focus();
    fireEvent.keyDown(vat, { key: 'Enter' });
    fireEvent.keyDown(vat, { key: 'Escape' });
    expect(vat).toHaveAttribute('aria-expanded', 'false');
    expect(vat).toHaveFocus();
    fireEvent.keyDown(vat, { key: 'Escape' });
    expect(vat).not.toHaveFocus();
    expect(vat.closest('tr')).toHaveFocus();
  });
});
