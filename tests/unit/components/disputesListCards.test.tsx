// Disputes queue: the table becomes labelled cards below lg; the status filters, the invoice links, Resolve and the pager are 44px; the header and pager wrap.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ disputes: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { disputes: state.disputes, total: state.disputes.length, openTotal: 1, openDisputedAmount: 100 } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/disputes/index';

const dispute = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id, raisedAt: '2026-11-18T08:00:00Z', clientName: `Client ${id}`, customerInvoiceId: `inv-${id}-00000000`, invoiceNumber: `INV-${id}`, customerInvoiceLineId: null,
  reason: 'Goods not received: the delivery note was never signed by anyone on site', disputedAmount: 100, status, resolutionMode: null, ...over,
});
afterEach(() => { cleanup(); state.disputes = []; });
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';
const HEADS = ['Raised', 'Customer', 'Invoice', 'Reason', 'Amount', 'Status', 'Actions'];

describe('Disputes queue on touch', () => {
  it('turns the table into labelled cards matching its headers; the actions cell is the unlabelled footer', async () => {
    state.disputes = [dispute('1', 'open'), dispute('2', 'resolved', { resolutionMode: 'credit_note' })];
    const { container } = render(<Page />);
    await screen.findByText('Client 1');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(['Raised', 'Customer', 'Invoice', 'Reason', 'Amount', 'Status', null]);
  });

  it('the reason wraps on cards instead of truncating, and the invoice cell is one value (link and "(line-level)" together)', async () => {
    state.disputes = [dispute('1', 'open', { customerInvoiceLineId: 'line1' })];
    const { container } = render(<Page />);
    await screen.findByText('Client 1');
    const reason = screen.getByText(/Goods not received/);
    expect(cls(reason)).toEqual(expect.arrayContaining(['truncate', 'max-lg:whitespace-normal', 'max-lg:max-w-none']));
    const cell = container.querySelector('tbody td[data-label="Invoice"]')!;
    expect(cell.children).toHaveLength(1); // one flex item, not link + span spread apart
    expect(cls(cell.children[0]!)).toContain('max-lg:text-right');
    expect(cell.textContent).toContain('(line-level)');
  });

  it('the status filters, the invoice link, Resolve and the pager are 44px; the header, filter row and pager wrap', async () => {
    state.disputes = [dispute('1', 'open')];
    render(<Page />);
    await screen.findByText('Client 1');
    const filters = screen.getByRole('button', { name: 'Open' }).parentElement!;
    expect(cls(filters)).toContain('max-lg:flex-wrap');
    expect([...filters.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Open', 'Resolved', 'Withdrawn', 'Rejected', 'All']);
    for (const b of filters.querySelectorAll('button')) expect(cls(b), b.textContent ?? '').toContain(MIN);
    expect(cls(screen.getByRole('link', { name: 'INV-1' }))).toEqual(expect.arrayContaining([MIN, 'max-lg:inline-flex', 'max-lg:items-center']));
    expect(cls(screen.getByRole('button', { name: 'Resolve' }))).toContain(MIN);
    for (const name of ['Previous', 'Next']) expect(cls(screen.getByRole('button', { name })), name).toContain(MIN);
    expect(cls(screen.getByRole('button', { name: 'Next' }).parentElement!.parentElement!)).toContain('max-lg:flex-wrap');
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-4']));
  });

  it('the empty row is a centred full-width block', async () => {
    const { container } = render(<Page />);
    const td = (await screen.findByText('No disputes.')).closest('td')!;
    expect(cls(td)).toEqual(expect.arrayContaining(['max-lg:!py-10', 'max-lg:!text-center']));
    expect(container.querySelector('tbody td[data-label]')).toBeNull();
  });
});
