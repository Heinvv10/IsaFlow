/**
 * NS2 review item 1: a row's stored CC1/CC2/BU id that is not among the active-only options (the dimension was
 * deactivated after the row was tagged) is still posted on accept. Its kit cell must show that stored dimension,
 * never the "Select…" placeholder, and changing a sibling dimension must carry the id through untouched.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { rowLabel } from '@/components/accounting/bankTx/bankTxRowLabel';
import type { BankTx } from '@/components/accounting/bankTx/bankTxTypes';
import { TXS, SELECTIONS, tableProps } from './bankTxTableFixture';

// Row a carries its stored CC1 with the code and name the list endpoint joined; CC2 and BU have no labels.
const TX_A: BankTx = { ...TXS[0]!, cc1Id: 'old1', cc1Code: 'OLD', cc1Name: 'Closed site' };
const TRANSACTIONS = [TX_A, ...TXS.slice(1)];
const STORED = { ...SELECTIONS, a: { ...SELECTIONS.a!, cc1Id: 'old1', cc2Id: 'old2', buId: 'oldbu' } };

const cell = (name: string) => screen.getByRole('combobox', { name: `${name}, ${rowLabel(TX_A)}` });
function choose(name: string, option: string) {
  fireEvent.click(cell(name));
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }));
}
const props = () => tableProps({ transactions: TRANSACTIONS, rowSelections: STORED });

describe('bank grid: a stored dimension outside the active options', () => {
  it('shows the stored CC1 by its code and name when the row carries them', () => {
    render(<BankTxTable {...props()} />);
    expect(cell('Cost centre 1')).toHaveTextContent('OLD Closed site');
    expect(cell('Cost centre 1')).not.toHaveTextContent('Select…');
  });

  it('names an unlabelled stored CC2 and BU as inactive instead of "Select…"', () => {
    render(<BankTxTable {...props()} />);
    expect(cell('Cost centre 2')).toHaveTextContent('Inactive cost centre');
    expect(cell('Business unit')).toHaveTextContent('Inactive business unit');
  });

  it('does not borrow the row\'s labels for a different stored id', () => {
    const p = tableProps({ transactions: TRANSACTIONS, rowSelections: { ...STORED, a: { ...STORED.a!, cc1Id: 'other' } } });
    render(<BankTxTable {...p} />);
    expect(cell('Cost centre 1')).toHaveTextContent('Inactive cost centre');
  });

  it('a sibling change keeps the stored ids, and nothing is cleared on render', () => {
    const p = props();
    render(<BankTxTable {...p} />);
    expect(p.onRowDimensionChange).not.toHaveBeenCalled();
    choose('Cost centre 2', 'Y');
    expect(p.onRowDimensionChange).toHaveBeenLastCalledWith('a', 'old1', 'y', 'oldbu');
    choose('Business unit', 'Z');
    expect(p.onRowDimensionChange).toHaveBeenLastCalledWith('a', 'old1', 'old2', 'z');
    choose('Cost centre 1', 'X Xn');
    expect(p.onRowDimensionChange).toHaveBeenLastCalledWith('a', 'x', 'old2', 'oldbu');
  });
});
