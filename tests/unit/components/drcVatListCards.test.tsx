// DRC VAT: the invoices table becomes labelled cards below lg; the tabs and Apply DRC are 44px; the header wraps.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ eligible: [] as unknown[], history: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({ success: true, data: { items: String(url).includes('tab=history') ? state.history : state.eligible } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/drc-vat/index';

const inv = (id: string) => ({ id, invoiceNumber: `SI-${id}`, supplierName: `Supplier ${id}`, totalAmount: 1000, vatAmount: 150, invoiceDate: '2026-11-18' });
afterEach(() => { cleanup(); state.eligible = []; state.history = []; });
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';

describe('DRC VAT on touch', () => {
  it('turns the table into labelled cards matching its headers; the invoice cell is the heading and Apply DRC the footer', async () => {
    state.eligible = [inv('1'), inv('2')];
    const { container } = render(<Page />);
    await screen.findByText('SI-1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Invoice', 'Supplier', 'Date', 'Amount (excl)', 'VAT (15%)', 'Action']);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, 'Supplier', 'Date', 'Amount (excl)', 'VAT (15%)', null]);
  });

  it('the Processed tab has no action column: five cells, four labelled', async () => {
    state.history = [inv('9')];
    const { container } = render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: /Processed/ }));
    await screen.findByText('SI-9');
    const cells = [...container.querySelectorAll('tbody tr')[0]!.querySelectorAll('td')];
    expect(cells.map((td) => td.getAttribute('data-label'))).toEqual([null, 'Supplier', 'Date', 'Amount (excl)', 'VAT (15%)']);
  });

  it('both tabs and Apply DRC are 44px; the header wraps', async () => {
    state.eligible = [inv('1')];
    render(<Page />);
    await screen.findByText('SI-1');
    for (const name of [/Eligible/, /Processed/]) expect(cls(screen.getByRole('button', { name })), String(name)).toContain(MIN);
    expect(cls(screen.getByRole('button', { name: /Apply DRC/ }))).toContain(MIN);
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('the loading and empty rows are centred full-width blocks', async () => {
    const { container } = render(<Page />);
    const loading = container.querySelector('tbody td')!;
    expect(loading.textContent).toBe('Loading...');
    expect(cls(loading)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
    const empty = (await screen.findByText('No eligible invoices for DRC VAT.')).closest('td')!;
    expect(cls(empty)).toEqual(expect.arrayContaining(['max-lg:!py-8', 'max-lg:!text-center']));
    expect(container.querySelector('tbody td[data-label]')).toBeNull();
  });
});
