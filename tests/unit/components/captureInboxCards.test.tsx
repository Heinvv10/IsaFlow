// Capture inbox: the queue becomes labelled cards below lg; the row actions are visible without hover (there is none on a phone) and 44px; header controls and toast close are 44px.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ events: [] as unknown[], addr: true, addrFails: false }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/capture/CaptureInboxPanel', async (orig) => ({ ...(await orig<typeof import('@/components/accounting/capture/CaptureInboxPanel')>()), CaptureInboxPanel: () => null }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { events: state.events } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  apiJson: vi.fn(async () => { if (state.addrFails) throw new Error('inbox address down'); return { inbox: state.addr ? { address: 'slips@in.isaflow.co.za' } : null }; }),
}));

import Page from '../../../pages/accounting/capture/inbox';

const ev = (id: string, status: string) => ({ eventId: id, channel: 'email', receivedAt: '2026-11-20T08:00:00Z', sender: 'supplier@example.com', vendorName: 'Acme Supplies', referenceNumber: 'INV-77', totalAmount: 1250.5, status, error: null });
afterEach(() => { cleanup(); state.addrFails = false; state.events = [ev('e1', 'extracted'), ev('e2', 'received')]; });
state.events = [ev('e1', 'extracted'), ev('e2', 'received')];
const cls = (el: Element) => el.className.split(' ');
const SQUARE = ['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center'];
const HEADS = ['Channel', 'Received', 'Sender', 'Vendor', 'Reference', 'Amount', 'Status', 'Actions'];

describe('Capture inbox on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findAllByText('Acme Supplies');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const tr of rows) expect([...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
    expect(cls(rows[0].querySelector('td[data-label="Sender"]')!)).toEqual(expect.arrayContaining(['max-lg:max-w-none', 'max-lg:whitespace-normal']));
  });

  it('the row actions show without hover on phones, and Post and the open chevron are 44px', async () => {
    const { container } = render(<Page />);
    await screen.findAllByText('Acme Supplies');
    const group = screen.getByRole('button', { name: 'Post' }).parentElement!;
    expect(cls(group)).toEqual(expect.arrayContaining(['opacity-0', 'group-hover:opacity-100', 'max-lg:opacity-100', 'max-lg:gap-2']));
    expect(cls(screen.getByRole('button', { name: 'Post' }))).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:px-4']));
    const chevrons = screen.getAllByRole('button', { name: 'Open details' });
    expect(chevrons).toHaveLength(2);
    for (const c of chevrons) expect(cls(c)).toEqual(expect.arrayContaining(SQUARE));
    expect(container.querySelectorAll('tbody td:last-child button')).toHaveLength(3); // Post + two chevrons
  });

  it('header: wraps; Show processed and Refresh are 44px', async () => {
    render(<Page />);
    await screen.findAllByText('Acme Supplies');
    expect(cls(screen.getByText('Show processed').closest('label')!)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByTitle('Refresh'))).toEqual(expect.arrayContaining(SQUARE));
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('empty state: the copy-address button is a 44px square', async () => {
    state.events = [];
    const { container } = render(<Page />);
    await screen.findByText('No pending captures');
    const copy = screen.getByRole('button', { name: 'Copy address' });
    expect(cls(copy)).toEqual(expect.arrayContaining(SQUARE));
  });

  it('the toast close button is a 44px square', async () => {
    state.addrFails = true;
    render(<Page />);
    const toast = (await screen.findByText(/inbox address down|Could not load the inbox address/)).closest('div')!;
    expect(cls(screen.getByRole('button', { name: 'Dismiss' }))).toEqual(expect.arrayContaining(SQUARE));
    expect(toast.contains(screen.getByRole('button', { name: 'Dismiss' }))).toBe(true);
  });
});
