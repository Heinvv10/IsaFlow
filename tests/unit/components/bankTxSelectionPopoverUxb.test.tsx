/**
 * UXB (wave 5): the Selection popover's options are plain buttons inside the grid. Enter on one chooses it and must
 * not reach the row-stream hotkeys (Enter there accepts the row, which posts a journal). Rows are 41 px comfortable
 * and 33 px compact: the cells are py-1 and the kit selects are sm (32 px) / xs (24 px).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
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

describe('Selection popover: focus', () => {
  const openByKey = () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    fireEvent.keyDown(screen.getByRole('group', { name: /Bank transactions/ }), { key: 'ArrowDown' });
    const row = document.querySelector('tbody tr') as HTMLElement;
    fireEvent.keyDown(row, { key: 'e' }); // the grid's Edit hotkey opens the popover
    return { p, row };
  };

  it('Escape in the search box closes the popover and returns focus to the row (golden y2)', () => {
    const { row } = openByKey();
    const search = screen.getByRole('textbox', { name: /^Search accounts$/ });
    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: /^Search accounts$/ })).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('choosing an option leaves focus on the row, not on the removed button', () => {
    const { row } = openByKey();
    const option = screen.getByRole('button', { name: /7000/ });
    option.focus();
    fireEvent.click(option);
    expect(document.activeElement).toBe(row);
  });

  it('Enter on the toggle presses it: the row is not accepted, and the picker opens', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    fireEvent.keyDown(screen.getByRole('group', { name: /Bank transactions/ }), { key: 'ArrowDown' }); // row a: can be accepted
    const toggle = screen.getByRole('button', { name: new RegExp(`Choose account, ${label}`) });
    toggle.focus();
    const notPrevented = fireEvent.keyDown(toggle, { key: 'Enter' });
    expect(notPrevented, 'the browser turns Enter into the click').toBe(true);
    expect(p.onAccept).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(screen.getByRole('textbox', { name: /^Search accounts$/ })).toBeInTheDocument();
  });

  it('Escape with focus on the toggle closes an open popover and keeps focus on the row', () => {
    const { row } = openByKey();
    const toggle = row.querySelector('[data-bank-toggle]') as HTMLElement;
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: /^Search accounts$/ })).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('with keyboard nav off (not the New tab) choosing an option leaves focus on the toggle, not the body', () => {
    render(<BankTxTable {...tableProps({ tab: 'reviewed' })} />);
    const toggle = screen.getByRole('button', { name: new RegExp(`Choose account, ${label}`) });
    fireEvent.click(toggle);
    const option = screen.getByRole('button', { name: /7000/ });
    option.focus();
    fireEvent.click(option);
    expect(document.activeElement).toBe(toggle);
  });
});

describe('row hotkeys belong to the row itself', () => {
  // Click row a (the stream's current row: suggested, can be accepted), then press keys on controls of row c.
  const setup = () => {
    const p = tableProps({ onOpenDetails: vi.fn() });
    render(<BankTxTable {...p} />);
    const rows = Array.from(document.querySelectorAll('tbody tr')) as HTMLElement[];
    fireEvent.click(rows[0]!); // focusedIndex = row a
    const rowC = rows.find(r => r.textContent?.includes('Client pay'))!;
    return { p, rowC };
  };
  const controls: [string, (row: HTMLElement) => HTMLElement][] = [
    ['Notes button', row => row.querySelector('button[aria-label^="Add note"], button[aria-label^="Note,"]') as HTMLElement],
    ['row checkbox', row => row.querySelector('input[type="checkbox"]') as HTMLElement],
    ['Choose toggle', row => row.querySelector('[data-bank-toggle]') as HTMLElement],
    ['Details button', row => row.querySelector('button[aria-label^="Details,"]') as HTMLElement],
  ];

  it.each(controls)('Enter, X and S on the %s of another row act on no row', (_name, find) => {
    const { p, rowC } = setup();
    const el = find(rowC);
    expect(el, 'the control exists').toBeTruthy();
    el.focus();
    for (const key of ['Enter', 'x', 's', 'e']) {
      const notPrevented = fireEvent.keyDown(el, { key });
      expect(notPrevented, `${key} is left to the control`).toBe(true);
    }
    expect(p.onAccept).not.toHaveBeenCalled();
    expect(p.onExclude).not.toHaveBeenCalled();
    expect(p.onSplit).not.toHaveBeenCalled();
  });

  it('on the row itself the hotkeys still work: Enter accepts, X excludes', () => {
    const p = tableProps();
    render(<BankTxTable {...p} />);
    const rowA = document.querySelector('tbody tr') as HTMLElement;
    fireEvent.click(rowA);
    fireEvent.keyDown(rowA, { key: 'x' });
    expect(p.onExclude).toHaveBeenCalledWith('a');
    fireEvent.keyDown(rowA, { key: 'Enter' });
    expect(p.onAccept).toHaveBeenCalledWith('a');
  });

  it('a row that is not the stream\'s current row ignores its own hotkeys', () => {
    const { p, rowC } = setup();
    fireEvent.keyDown(rowC, { key: 'Enter' });
    expect(p.onAccept).not.toHaveBeenCalled();
  });
});

describe('row density', () => {
  const trigger = () => screen.getByRole('combobox', { name: `VAT, ${label}` });

  it('comfortable: py-1 cells and sm selects (32 + 8 + 1 = 41 px)', () => {
    const { container } = render(<TableDensityProvider><BankTxTable {...tableProps()} /></TableDensityProvider>);
    expect(trigger().className).toContain('min-h-[32px]');
    const cells = container.querySelectorAll('tbody tr:first-child > td');
    expect(cells.length).toBeGreaterThan(0);
    cells.forEach(td => { expect(td.className).toMatch(/\bpy-1\b/); expect(td.className).not.toMatch(/\bpy-2\b/); });
  });

  it('compact: xs selects (24 + 8 + 1 = 33 px)', () => {
    localStorage.setItem('isaflow.tableDensity', 'compact');
    render(<TableDensityProvider><BankTxTable {...tableProps()} /></TableDensityProvider>);
    expect(trigger().className).toContain('min-h-[24px]');
  });
});
