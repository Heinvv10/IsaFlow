/**
 * #1653: on a bank row the CC2 (project) select offers exactly the active CC2s under the chosen CC1 (FNO). A CC2
 * belongs to the CC1 its parent chain reaches (`fnoCode`), so a project under a programme counts, and an overhead
 * CC2 under Head Office is offered for Head Office (bank charges and other non-project costs). Changing the CC1
 * clears a CC2 that belongs to another CC1, because the server derives CC1 from CC2 and would refuse the pair.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { rowLabel } from '@/components/accounting/bankTx/bankTxRowLabel';
import type { SelectOption } from '@/components/accounting/bankTx/bankTxTypes';
import { TXS, SELECTIONS, tableProps } from './bankTxTableFixture';

const CC1: SelectOption[] = [
  { id: 'fa', code: 'FNO-A', name: 'Alpha Fibre' },
  { id: 'fb', code: 'FNO-B', name: 'Beta Networks' },
  { id: 'ho', code: 'HO', name: 'Head Office' },
];
const CC2: SelectOption[] = [
  { id: 'pa1', code: 'PA1', name: 'Alpha build', fnoCode: 'FNO-A' },
  { id: 'prgb', code: 'PRGB', name: 'Beta programme', fnoCode: 'FNO-B' },
  // Under the Beta programme, not directly under FNO-B: it still rolls up to FNO-B.
  { id: 'pb1', code: 'PB1', name: 'Beta phase 1', fnoCode: 'FNO-B' },
  { id: 'oh', code: 'OH-BANK', name: 'Bank charges', fnoCode: 'HO' },
  { id: 'orph', code: 'ORPH', name: 'No parent', fnoCode: null },
];

const row = rowLabel(TXS[0]!);
const cell = (name: string) => screen.getByRole('combobox', { name: `${name}, ${row}` });
function offered(name: string): string[] {
  fireEvent.click(cell(name));
  const names = within(screen.getByRole('listbox')).getAllByRole('option').map(o => o.textContent ?? '');
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
  return names;
}
function choose(name: string, option: string) {
  fireEvent.click(cell(name));
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }));
}
function props(cc1Id: string, cc2Id = '') {
  return tableProps({
    cc1Options: CC1, cc2Options: CC2,
    rowSelections: { ...SELECTIONS, a: { ...SELECTIONS.a!, cc1Id, cc2Id } },
  });
}

describe('bank grid: CC2 options follow the chosen CC1 (#1653)', () => {
  it('a CC1 offers only its own projects', () => {
    render(<BankTxTable {...props('fa')} />);
    expect(offered('Cost centre 2')).toEqual(['—', 'PA1 Alpha build']);
  });

  it('another CC1 offers its own projects, including one under a programme', () => {
    render(<BankTxTable {...props('fb')} />);
    expect(offered('Cost centre 2')).toEqual(['—', 'PRGB Beta programme', 'PB1 Beta phase 1']);
  });

  it('Head Office offers its overhead CC2, and choosing it sends both ids', () => {
    const p = props('ho');
    render(<BankTxTable {...p} />);
    expect(offered('Cost centre 2')).toEqual(['—', 'OH-BANK Bank charges']);
    choose('Cost centre 2', 'OH-BANK Bank charges');
    expect(p.onRowDimensionChange).toHaveBeenLastCalledWith('a', 'ho', 'oh', '');
  });

  it('no CC1 offers every active CC2', () => {
    render(<BankTxTable {...props('')} />);
    expect(offered('Cost centre 2')).toHaveLength(CC2.length + 1);
  });

  it('keeps showing a chosen CC2 that belongs to another CC1 instead of calling it inactive', () => {
    render(<BankTxTable {...props('fa', 'oh')} />);
    expect(cell('Cost centre 2')).toHaveTextContent('OH-BANK Bank charges');
  });

  it('a CC1 change clears a CC2 under another CC1', () => {
    const p = props('fa', 'pa1');
    render(<BankTxTable {...p} />);
    choose('Cost centre 1', 'HO Head Office');
    expect(p.onRowDimensionChange).toHaveBeenLastCalledWith('a', 'ho', '', '');
  });

  it('a CC1 chosen after its own CC2 keeps that CC2', () => {
    const p = props('', 'pa1');
    render(<BankTxTable {...p} />);
    choose('Cost centre 1', 'FNO-A Alpha Fibre');
    expect(p.onRowDimensionChange).toHaveBeenLastCalledWith('a', 'fa', 'pa1', '');
  });
});
