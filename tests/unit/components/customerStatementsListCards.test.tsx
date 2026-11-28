// Customer statements list: the table becomes labelled cards below lg; the search box, Download All and both links are 44px.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ customers: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { customers: state.customers } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/customer-statements/index';

const cust = (id: string) => ({ client_id: id, client_name: `Customer ${id}`, total_invoiced: 1000, total_paid: 400, total_credits: 50, balance: 550, last_payment_date: '2026-11-10', invoice_count: 3 });
afterEach(() => { cleanup(); state.customers = []; });
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const HEADS = ['Customer', 'Invoiced', 'Paid', 'Credits', 'Balance', '# Invoices', 'Last Payment', 'Actions'];

describe('Customer statements list on touch', () => {
  it('turns the table into labelled cards matching its headers; the customer and actions cells are the unlabelled heading and footer', async () => {
    state.customers = [cust('a'), cust('b')];
    const { container } = render(<Page />);
    await screen.findByText('Customer a');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect([...row.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, 'Invoiced', 'Paid', 'Credits', 'Balance', '# Invoices', 'Last Payment', null]);
    }
  });

  it('the search box takes the width and is 44px; Download All is 44px', async () => {
    state.customers = [cust('a')];
    render(<Page />);
    await screen.findByText('Customer a');
    const search = screen.getByPlaceholderText('Search customer...');
    expect(cls(search)).toEqual(expect.arrayContaining([MIN, 'max-lg:w-full']));
    expect(cls(search.parentElement!)).toContain('max-lg:w-full');
    expect(cls(screen.getByRole('button', { name: /Download All/ }))).toContain(MIN);
  });

  it('the customer name link and the View link are 44px', async () => {
    state.customers = [cust('a')];
    render(<Page />);
    await screen.findByText('Customer a');
    expect(cls(screen.getByRole('link', { name: 'Customer a' }))).toEqual(expect.arrayContaining([MIN, 'max-lg:inline-flex', 'max-lg:items-center']));
    expect(cls(screen.getByRole('link', { name: /View/ }))).toContain(MIN);
  });
});
