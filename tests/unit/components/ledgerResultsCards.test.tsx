// Customer and supplier ledger results: the transactions table becomes labelled cards below lg (it used to clip its right-hand columns).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CustomerLedgerResults } from '../../../src/components/reports/CustomerLedgerResults';
import { SupplierLedgerResults } from '../../../src/components/reports/SupplierLedgerResults';

afterEach(cleanup);
const HEADS = ['Date', 'Type', 'Reference', 'Debit', 'Credit', 'Balance'];
const tx = [{ type: 'invoice', transaction_id: 't1', reference: 'INV-1', transaction_date: '2026-05-01', debit: 100, credit: 0, status: 'posted', running_balance: 100 }];
const customer = { customer_name: 'Acme', opening_balance: 0, closing_balance: 100, transactions: tx };
const supplier = { supplier_name: 'Bolt', opening_balance: 0, closing_balance: 100, transactions: tx };
const cases: Array<[string, () => ReturnType<typeof render>, () => ReturnType<typeof render>]> = [
  ['customer', () => render(<CustomerLedgerResults ledger={customer} />), () => render(<CustomerLedgerResults ledger={{ ...customer, transactions: [] }} />)],
  ['supplier', () => render(<SupplierLedgerResults ledger={supplier as never} />), () => render(<SupplierLedgerResults ledger={{ ...supplier, transactions: [] } as never} />)],
];

describe.each(cases)('%s ledger results on touch', (_name, withRows, empty) => {
  it('turns the transactions table into labelled cards; the Totals cell heads its card', () => {
    const { container } = withRows();
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(HEADS);
    const labels = (tr: Element) => [...tr.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'));
    const [row, totals] = [...table.querySelectorAll(':scope > tbody > tr')];
    expect(labels(row)).toEqual(HEADS);
    // Totals: the "Totals" cell spans the card (no label); the three sums keep theirs.
    expect(labels(totals)).toEqual([null, 'Debit', 'Credit', 'Balance']);
  });

  it('keeps the no-transactions message centred and roomy on a card', () => {
    const { container } = empty();
    const cell = container.querySelector('tbody td')!;
    expect(cell.textContent).toContain('No transactions');
    expect(cell.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
    expect(screen.queryByText('Totals')).toBeNull();
  });
});
