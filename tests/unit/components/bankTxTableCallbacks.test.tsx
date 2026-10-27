/**
 * The bank grid's callback contract: which handler each control calls, and with exactly what. Accept,
 * exclude, undo and reverse post to (or unpost from) the ledger through these handlers, and the type /
 * entity / VAT / dimension callbacks build the payload accept sends, so a split or a renaming that
 * rewired one of them would change what is posted. Each control is found by its accessible name, then
 * the spy's arguments are compared whole.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { rowLabel } from '@/components/accounting/bankTx/bankTxRowLabel';
import { TXS, tableProps } from './bankTxTableFixture';

const row = (id: string) => rowLabel(TXS.find(t => t.id === id)!);
const rowOf = (id: string) => within(screen.getByRole('checkbox', { name: `Select ${row(id)}` }).closest('tr')!);

describe('BankTxTable: a new row calls each handler with the row and its value', () => {
  it('select boxes', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all transactions on this page' }));
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${row('a')}` }));
    expect(p.onSelectAll).toHaveBeenCalledTimes(1);
    expect(p.onToggleSelect).toHaveBeenCalledTimes(1);
    expect(p.onToggleSelect).toHaveBeenCalledWith('a');
    expect(screen.getByRole('checkbox', { name: `Select ${row('b')}` })).toBeDisabled();
  });

  it('type, VAT and dimension selects', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    fireEvent.change(screen.getByRole('combobox', { name: `Allocation type, ${row('a')}` }), { target: { value: 'transfer' } });
    fireEvent.change(screen.getByRole('combobox', { name: `VAT, ${row('a')}` }), { target: { value: 'zero_rated' } });
    fireEvent.change(screen.getByRole('combobox', { name: `Cost centre 1, ${row('a')}` }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: `Cost centre 2, ${row('a')}` }), { target: { value: 'y' } });
    fireEvent.change(screen.getByRole('combobox', { name: `Business unit, ${row('a')}` }), { target: { value: 'z' } });
    expect(p.onRowTypeChange).toHaveBeenCalledTimes(1);
    expect(p.onRowTypeChange).toHaveBeenCalledWith('a', 'transfer');
    expect(p.onRowVatChange).toHaveBeenCalledTimes(1);
    expect(p.onRowVatChange).toHaveBeenCalledWith('a', 'zero_rated');
    expect(p.onRowDimensionChange).toHaveBeenCalledTimes(3);
    expect(p.onRowDimensionChange).toHaveBeenNthCalledWith(1, 'a', '', '', '');
    expect(p.onRowDimensionChange).toHaveBeenNthCalledWith(2, 'a', 'x', 'y', '');
    expect(p.onRowDimensionChange).toHaveBeenNthCalledWith(3, 'a', 'x', '', 'z');
  });

  it('entity popover: the pinned suggestion, a listed option, and New', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    const open = () => fireEvent.click(screen.getByRole('button', { name: `6100 Entertainment. Choose account, ${row('a')}` }));
    open();
    const pinned = screen.getAllByRole('button', { name: /Entertainment/ }).find(b => b.closest('[data-bank-dropdown]') && b.className.includes('bg-teal-500/5'))!;
    fireEvent.click(pinned);
    open();
    fireEvent.click(screen.getByRole('button', { name: '7000 Donations' }));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'New Account' }));
    expect(p.onRowEntityChange).toHaveBeenNthCalledWith(1, 'a', 'g1', '6100 Entertainment');
    expect(p.onRowEntityChange).toHaveBeenNthCalledWith(2, 'a', 'g2', '7000 Donations');
    expect(p.onRowEntityChange).toHaveBeenCalledTimes(2);
    expect(p.onCreateEntity).toHaveBeenCalledTimes(1);
    expect(p.onCreateEntity).toHaveBeenCalledWith('a', 'account');
  });

  it('notes save on blur with the new text', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    fireEvent.click(screen.getByRole('button', { name: `Note, ${row('a')}: lunch` }));
    const input = screen.getByRole('textbox', { name: `Note, ${row('a')}` });
    fireEvent.change(input, { target: { value: 'team lunch' } });
    fireEvent.blur(input);
    expect(p.onUpdateNotes).toHaveBeenCalledTimes(1);
    expect(p.onUpdateNotes).toHaveBeenCalledWith('a', 'team lunch');
  });

  it('action buttons', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    const r = rowOf('a');
    for (const name of ['Accept', 'Find & Match', 'Split transaction', 'Create rule from this transaction', 'Link to asset / fuel / service', 'Attachments', 'Ask client on WhatsApp', 'Exclude']) {
      fireEvent.click(r.getByRole('button', { name: `${name}, ${row('a')}` }));
    }
    const once: [keyof typeof p, unknown][] = [
      ['onAccept', 'a'], ['onFindMatch', 'a'], ['onSplit', 'a'], ['onCreateRule', TXS[0]], ['onLink', TXS[0]],
      ['onAttachments', 'a'], ['onAskClient', 'a'], ['onExclude', 'a'],
    ];
    for (const [h, arg] of once) {
      expect(p[h], h).toHaveBeenCalledTimes(1);
      expect(p[h], h).toHaveBeenCalledWith(arg);
    }
    expect(p.onUnmatch).not.toHaveBeenCalled();
    expect(p.onReverse).not.toHaveBeenCalled();
  });

  it('Accept is disabled on a row with nothing chosen, and a pending row has no actions', () => {
    render(<BankTxTable {...tableProps()} />);
    expect(rowOf('n').getByRole('button', { name: `Accept, ${row('n')}` })).toBeDisabled();
    expect(rowOf('b').queryByRole('button', { name: /^Accept/ })).toBeNull();
  });
});

describe('BankTxTable: reviewed rows undo through the handler for their status', () => {
  it('allocated -> onReverse; reconciled -> onUnmatch, and onReverse for "Reverse reconciled"', () => {
    const p = tableProps({ tab: 'reviewed' });
    render(<BankTxTable {...p} />);
    fireEvent.click(rowOf('d').getByRole('button', { name: `Undo allocation, ${row('d')}` }));
    expect(p.onReverse).toHaveBeenCalledTimes(1);
    expect(p.onReverse).toHaveBeenLastCalledWith('d');
    expect(p.onUnmatch).not.toHaveBeenCalled();
    fireEvent.click(rowOf('e').getByRole('button', { name: `Undo allocation, ${row('e')}` }));
    expect(p.onUnmatch).toHaveBeenCalledTimes(1);
    expect(p.onUnmatch).toHaveBeenCalledWith('e');
    fireEvent.click(rowOf('e').getByRole('button', { name: `Reverse reconciled, ${row('e')}` }));
    expect(p.onReverse).toHaveBeenLastCalledWith('e');
    expect(p.onReverse).toHaveBeenCalledTimes(2);
    expect(p.onAccept).not.toHaveBeenCalled();
  });
});

describe('BankTxTable: keyboard row stream', () => {
  it('ArrowDown enters the stream, Enter accepts the focused row that has a choice, E opens its popover', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    const grid = screen.getByRole('group', { name: /Bank transactions/ });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(p.onAccept).toHaveBeenCalledTimes(1);
    expect(p.onAccept).toHaveBeenCalledWith('a');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'Enter' }); // row n: nothing chosen, so Enter edits instead
    expect(p.onAccept).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Search accounts' })).toHaveFocus();
    fireEvent.keyDown(grid, { key: 'x' }); // typing in the search is not a hotkey
    expect(p.onExclude).not.toHaveBeenCalled();
  });
  it('X excludes and S splits the focused row, once each; E opens the focused row\'s popover', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    const grid = screen.getByRole('group', { name: /Bank transactions/ });
    fireEvent.keyDown(grid, { key: 'ArrowDown' }); // row a
    fireEvent.keyDown(grid, { key: 'x' });
    expect(p.onExclude).toHaveBeenCalledTimes(1);
    expect(p.onExclude).toHaveBeenCalledWith('a');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' }); // row c
    fireEvent.keyDown(grid, { key: 's' });
    expect(p.onSplit).toHaveBeenCalledTimes(1);
    expect(p.onSplit).toHaveBeenCalledWith('c');
    fireEvent.keyDown(grid, { key: 'e' });
    expect(screen.getByRole('button', { name: `Acme. Choose customer, ${row('c')}` })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('textbox', { name: 'Search customers' })).toHaveFocus();
    expect(p.onAccept).not.toHaveBeenCalled();
  });
});
