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
    expect(p.onRowTypeChange).toHaveBeenCalledWith('a', 'transfer');
    expect(p.onRowVatChange).toHaveBeenCalledWith('a', 'zero_rated');
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
    expect(p.onCreateEntity).toHaveBeenCalledWith('a', 'account');
  });

  it('notes save on blur with the new text', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    fireEvent.click(screen.getByRole('button', { name: `Note, ${row('a')}: lunch` }));
    const input = screen.getByRole('textbox', { name: `Note, ${row('a')}` });
    fireEvent.change(input, { target: { value: 'team lunch' } });
    fireEvent.blur(input);
    expect(p.onUpdateNotes).toHaveBeenCalledWith('a', 'team lunch');
  });

  it('action buttons', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    const r = rowOf('a');
    for (const name of ['Accept', 'Find & Match', 'Split transaction', 'Create rule from this transaction', 'Link to asset / fuel / service', 'Attachments', 'Ask client on WhatsApp', 'Exclude']) {
      fireEvent.click(r.getByRole('button', { name }));
    }
    expect(p.onAccept).toHaveBeenCalledWith('a');
    expect(p.onFindMatch).toHaveBeenCalledWith('a');
    expect(p.onSplit).toHaveBeenCalledWith('a');
    expect(p.onCreateRule).toHaveBeenCalledWith(TXS[0]);
    expect(p.onLink).toHaveBeenCalledWith(TXS[0]);
    expect(p.onAttachments).toHaveBeenCalledWith('a');
    expect(p.onAskClient).toHaveBeenCalledWith('a');
    expect(p.onExclude).toHaveBeenCalledWith('a');
    expect(p.onUnmatch).not.toHaveBeenCalled();
    expect(p.onReverse).not.toHaveBeenCalled();
  });

  it('Accept is disabled on a row with nothing chosen, and a pending row has no actions', () => {
    render(<BankTxTable {...tableProps()} />);
    expect(rowOf('n').getByRole('button', { name: 'Accept' })).toBeDisabled();
    expect(rowOf('b').queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});

describe('BankTxTable: reviewed rows undo through the handler for their status', () => {
  it('allocated -> onReverse; reconciled -> onUnmatch, and onReverse for "Reverse reconciled"', () => {
    const p = tableProps({ tab: 'reviewed' });
    render(<BankTxTable {...p} />);
    fireEvent.click(rowOf('d').getByRole('button', { name: 'Undo allocation' }));
    expect(p.onReverse).toHaveBeenLastCalledWith('d');
    expect(p.onUnmatch).not.toHaveBeenCalled();
    fireEvent.click(rowOf('e').getByRole('button', { name: 'Undo allocation' }));
    expect(p.onUnmatch).toHaveBeenCalledWith('e');
    fireEvent.click(rowOf('e').getByRole('button', { name: 'Reverse reconciled' }));
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
});
