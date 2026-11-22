// Account ledger: the transactions table becomes labelled cards below lg (sentinel rows included); the pager is phone-sized.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLedgerTable } from '../../../src/components/reports/AccountLedgerTable';

afterEach(cleanup);
const HEADS = ['Date', 'Entry #', 'Description', 'Reference', 'Source', 'Debit', 'Credit', 'Balance'];
const rows = [
  { journalEntryId: 'j1', entryDate: '2026-05-01', entryNumber: 'JE-1', description: 'A very long journal description that must wrap on a phone card', reference: 'REF', source: 'manual', debit: 100, credit: 0, runningBalance: 100 },
  { journalEntryId: 'j2', entryDate: '2026-05-02', entryNumber: 'JE-2', description: 'Second', reference: '', source: 'manual', debit: 0, credit: 40, runningBalance: 60 },
] as never;
const base = { rows, openingBalance: 0, periodClosingBalance: 60, normalBalance: 'debit', page: 1, totalPages: 1, onPageChange: vi.fn() };
const labels = (tr: Element) => [...tr.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'));

describe('Account ledger on touch', () => {
  it('turns the table into labelled cards; each sentinel row keeps its label as a block and labels only its balance', () => {
    const { container } = render(<AccountLedgerTable {...base} />);
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const trs = [...table.querySelectorAll(':scope > tbody > tr')];
    expect(trs).toHaveLength(4); // opening, two rows, closing
    expect(labels(trs[0])).toEqual([null, 'Balance']);
    expect(labels(trs[1])).toEqual(HEADS);
    expect(labels(trs[3])).toEqual([null, 'Balance']);
  });

  it('hides the empty Debit or Credit line of a row on a card, and wraps a long description', () => {
    const { container } = render(<AccountLedgerTable {...base} />);
    const [, first, second] = [...container.querySelectorAll('tbody > tr')];
    const cell = (tr: Element, label: string) => tr.querySelector(`td[data-label="${label}"]`)!.className.split(' ');
    expect(cell(first, 'Credit')).toContain('max-lg:!hidden');
    expect(cell(first, 'Debit')).not.toContain('max-lg:!hidden');
    expect(cell(second, 'Debit')).toContain('max-lg:!hidden');
    expect(cell(second, 'Credit')).not.toContain('max-lg:!hidden');
    expect(cell(first, 'Description')).toEqual(expect.arrayContaining(['truncate', 'max-w-xs', 'max-lg:max-w-none', 'max-lg:whitespace-normal']));
  });

  it('keeps the empty-period message centred and roomy on a card', () => {
    render(<AccountLedgerTable {...base} rows={[]} />);
    const cell = screen.getByText('No transactions in this period').closest('td')!;
    expect(cell.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
  });

  it('makes both pager buttons 44px squares', () => {
    const { container } = render(<AccountLedgerTable {...base} totalPages={3} page={2} />);
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) for (const c of ['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']) expect(b.className, c).toContain(c);
  });
});
