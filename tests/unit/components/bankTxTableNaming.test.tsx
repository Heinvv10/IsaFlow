/**
 * Every control in the bank grid has an accessible name, scoped to its row by rowLabel(tx). axe counted 77
 * critical findings on /accounting/bank-transactions, nearly all of them these: unnamed row checkboxes and
 * type / VAT / CC / BU selects, 25 rows to a page. Icon buttons carried only `title`, which screen readers
 * do not reliably announce, so each also gets the same text as aria-label (lucide marks the icon itself
 * aria-hidden).
 *
 * Rendered, and read through the accessibility tree (getAllByRole + toHaveAccessibleName): an attribute
 * grep would pass on a name a screen reader never reaches.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { rowLabel } from '@/components/accounting/bankTx/bankTxRowLabel';
import { TXS, tableProps } from './bankTxTableFixture';

const ROLES = ['button', 'checkbox', 'combobox', 'textbox', 'link', 'searchbox'] as const;
const row = (id: string) => rowLabel(TXS.find(t => t.id === id)!);

function everyControlIsNamed(container: HTMLElement) {
  const controls = ROLES.flatMap(r => within(container).queryAllByRole(r));
  expect(controls.length).toBeGreaterThan(0);
  for (const el of controls) expect(el).toHaveAccessibleName();
  return controls.length;
}

describe('BankTxTable: every control has an accessible name', () => {
  it.each(['new', 'reviewed', 'excluded'] as const)('on the %s tab', (tab) => {
    const { container } = render(<BankTxTable {...tableProps({ tab })} />);
    everyControlIsNamed(container);
  });

  it('with the Selection popover open, and the notes cell in edit mode', () => {
    const { container } = render(<BankTxTable {...tableProps()} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Choose account, ${row('a')}`) }));
    fireEvent.click(screen.getByRole('button', { name: `Add note, ${row('n')}` }));
    expect(everyControlIsNamed(container)).toBeGreaterThan(20);
  });
});

describe('BankTxTable: the names, row by row', () => {
  it('names the select-all box and each row box', () => {
    render(<BankTxTable {...tableProps()} />);
    expect(screen.getByRole('checkbox', { name: 'Select all transactions on this page' })).toBeInTheDocument();
    for (const id of ['a', 'b', 'c', 'n', 'd', 'e', 'f']) {
      expect(screen.getByRole('checkbox', { name: `Select ${row(id)}` })).toBeInTheDocument();
    }
  });

  it('names the type, VAT and dimension selects of a new row', () => {
    render(<BankTxTable {...tableProps()} />);
    expect(screen.getByRole('combobox', { name: `Allocation type, ${row('a')}` })).toHaveValue('account');
    expect(screen.getByRole('combobox', { name: `VAT, ${row('a')}` })).toHaveValue('standard');
    expect(screen.getByRole('combobox', { name: `Cost centre 1, ${row('a')}` })).toHaveValue('x');
    expect(screen.getByRole('combobox', { name: `Cost centre 2, ${row('a')}` })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: `Business unit, ${row('a')}` })).toHaveValue('');
  });

  it('names the Selection trigger by its visible text, then what it chooses and for which row', () => {
    render(<BankTxTable {...tableProps({ rowSelections: { ...tableProps().rowSelections, n: { type: 'supplier', entityId: '', label: '', vatCode: 'none' } } })} />);
    expect(screen.getByRole('button', { name: `6100 Entertainment. Choose account, ${row('a')}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Acme. Choose customer, ${row('c')}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Select Supplier. Choose supplier, ${row('n')}` })).toBeInTheDocument();
  });

  it.each([
    ['account', 'Search accounts'], ['supplier', 'Search suppliers'], ['customer', 'Search customers'], ['transfer', 'Search bank accounts'],
  ] as const)('names the popover search for a %s row', (type, name) => {
    render(<BankTxTable {...tableProps({ rowSelections: { n: { type, entityId: '', label: '', vatCode: 'none' } } })} />);
    fireEvent.click(within(screen.getAllByRole('row')[4]!).getByRole('button', { name: /Choose/ }));
    expect(screen.getByRole('textbox', { name })).toHaveFocus();
  });

  it('names the notes cell, read and edit', () => {
    render(<BankTxTable {...tableProps()} />);
    fireEvent.click(screen.getByRole('button', { name: `Note, ${row('a')}: lunch` }));
    expect(screen.getByRole('textbox', { name: `Note, ${row('a')}` })).toHaveValue('lunch');
  });

  it('gives every icon button its title as aria-label, with the icon hidden', () => {
    const { container } = render(<BankTxTable {...tableProps()} />);
    const iconButtons = Array.from(container.querySelectorAll('button')).filter(b => !b.textContent?.trim());
    expect(iconButtons.length).toBeGreaterThan(10);
    for (const b of iconButtons) {
      expect(b.getAttribute('aria-label')).toBe(b.getAttribute('title'));
      for (const svg of Array.from(b.querySelectorAll('svg'))) expect(svg).toHaveAttribute('aria-hidden', 'true');
    }
    const first = within(screen.getAllByRole('row')[1]!);
    for (const name of ['Accept', 'Find & Match', 'Split transaction', 'Create rule from this transaction', 'Attachments', 'Ask client on WhatsApp', 'Exclude']) {
      expect(first.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('names the undo / reverse buttons on reviewed rows', () => {
    render(<BankTxTable {...tableProps({ tab: 'reviewed' })} />);
    expect(within(screen.getAllByRole('row')[5]!).getByRole('button', { name: 'Undo allocation' })).toBeInTheDocument();
    expect(within(screen.getAllByRole('row')[6]!).getByRole('button', { name: 'Reverse reconciled' })).toBeInTheDocument();
  });
});
