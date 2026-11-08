/**
 * UXB (wave 5): the Selection popover's options are plain buttons inside the grid. Enter on one chooses it and must
 * not reach the row-stream hotkeys (Enter there accepts the row, which posts a journal). Rows are 41 px comfortable
 * and 33 px compact: the cells are py-1 and the kit selects are sm (32 px) / xs (24 px).
 */
import { afterEach, describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BankTxTable } from '@/components/accounting/BankTxTable';
import { TableDensityProvider } from '@/contexts/TableDensityContext';
import { rowLabel } from '@/components/accounting/bankTx/bankTxRowLabel';
import { TXS, tableProps } from './bankTxTableFixture';

afterEach(() => { cleanup(); localStorage.clear(); });

const label = rowLabel(TXS.find(t => t.id === 'a')!);

describe('Selection popover: Enter on an option', () => {
  it('is not an Accept: the keydown is left alone, and no row hotkey fires', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    fireEvent.keyDown(screen.getByRole('group', { name: /Bank transactions/ }), { key: 'ArrowDown' }); // row a: can be accepted
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Choose account, ${label}`) }));
    const option = screen.getByRole('button', { name: /7000/ });
    option.focus(); // keyboard users Tab from the search box to an option
    const notPrevented = fireEvent.keyDown(option, { key: 'Enter' });
    expect(notPrevented, 'the browser may still turn Enter into the button click').toBe(true);
    expect(p.onAccept).not.toHaveBeenCalled();
    fireEvent.click(option); // what the browser does next
    expect(p.onRowEntityChange).toHaveBeenCalledWith('a', 'g2', '7000 Donations');
  });
});

describe('row density', () => {
  const trigger = () => screen.getByRole('combobox', { name: `VAT, ${label}` });

  it('comfortable: py-1 cells and sm selects (32 + 8 + 1 = 41 px)', () => {
    const { container } = render(<TableDensityProvider><BankTxTable {...tableProps()} /></TableDensityProvider>);
    expect(trigger().className).toContain('min-h-[32px]');
    const cells = container.querySelectorAll('tbody tr:first-child > td');
    expect(cells.length).toBeGreaterThan(0);
    cells.forEach(td => { expect(td.className).toContain('py-1 '); expect(td.className).not.toMatch(/\bpy-2\b/); });
  });

  it('compact: xs selects (24 + 8 + 1 = 33 px)', () => {
    localStorage.setItem('isaflow.tableDensity', 'compact');
    render(<TableDensityProvider><BankTxTable {...tableProps()} /></TableDensityProvider>);
    expect(trigger().className).toContain('min-h-[24px]');
  });
});
