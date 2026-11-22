// AR aging: the client table becomes labelled cards below lg, the controls are 44px on phones, and the shared invoice drill-down stays cards.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, asPath: '/', isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({
    success: true,
    data: !String(url).includes('client_id')
      ? [{ entityId: 'c1', entityName: 'Acme Clients', current: 100, days30: 0, days60: 50, days90: 0, days120Plus: 0, disputed: 25, total: 175 }]
      : { invoices: [{ id: 'i1', invoiceNumber: 'INV-1', entityId: 'c1', entityName: 'Acme Clients', dueDate: '2026-05-01', totalAmount: 100, amountPaid: 0, balance: 100 }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/ar-aging/index';

afterEach(cleanup);
const LABELS = ['Current', '1-30 Days', '31-60 Days', '61-90 Days', '90+ Days', 'Disputed', 'Total'];
const dataLabels = (row: Element) => [...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'));

describe('AR aging on touch', () => {
  it('turns the client table into labelled cards; the chevron and name cells have no label', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme Clients');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(['', 'Client', 'Current', '1-30', '31-60', '61-90', '90+', 'Disputed', 'Total']);
    expect(dataLabels(table.querySelector(':scope > tbody > tr')!)).toEqual([null, null, ...LABELS]);
    // The totals row carries the same labels; its empty chevron cell must really hide on phones (`!`: the card CSS on td out-ranks a plain utility).
    const foot = table.querySelector(':scope > tbody > tr:last-child')!;
    expect(dataLabels(foot)).toEqual([null, null, ...LABELS]);
    expect(foot.querySelector('td')!.className.split(' ')).toContain('max-lg:!hidden');
  });

  it('keeps the expand chevron and client link at 44px and the name clear of the chevron', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme Clients');
    const row = container.querySelector('tbody tr')!;
    expect(row.className).toContain('max-lg:relative');
    for (const c of ['max-lg:absolute', 'max-lg:min-h-11', 'max-lg:min-w-11']) expect(row.querySelector('td')!.className).toContain(c);
    const name = screen.getByRole('link', { name: 'Acme Clients' });
    expect(name.className).toContain('max-lg:min-h-11');
    expect(name.closest('td')!.className.split(' ')).toContain('max-lg:!pr-14');
    expect(screen.getByRole('button', { name: /Export CSV/ }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!.className).toContain('max-lg:flex-wrap');
  });

  it('keeps the expanded invoice list as cards with a 44px invoice link', async () => {
    const { container } = render(<Page />);
    fireEvent.click((await screen.findByText('Acme Clients', { selector: 'a' })).closest('tr')!);
    const link = await screen.findByRole('link', { name: 'INV-1' });
    expect(link.className).toContain('max-lg:min-h-11');
    expect(container.querySelectorAll('table')[1].className).toContain('table-cards');
  });
});
