// AP aging: the supplier table and its invoice drill-down become labelled cards below lg, and the controls are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, asPath: '/', isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({
    success: true,
    data: !String(url).includes('supplier_id')
      ? [{ entityId: 's1', entityName: 'Acme Supplies', current: 100, days30: 0, days60: 50, days90: 0, days120Plus: 0, total: 150 }]
      : { invoices: [{ id: 'i1', invoiceNumber: 'SI-1', entityId: 's1', entityName: 'Acme Supplies', dueDate: '2026-05-01', totalAmount: 100, amountPaid: 0, balance: 100 }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/ap-aging/index';

afterEach(cleanup);
const heads = (table: Element) => [...table.querySelectorAll(':scope > thead th')].map(th => th.textContent);
const labels = (table: Element) => [...table.querySelectorAll(':scope > tbody > tr:first-child > td')].map(td => td.getAttribute('data-label'));

describe('AP aging on touch', () => {
  it('turns the supplier table into labelled cards; the name cell has no label so it spans the card', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme Supplies');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect(heads(table)).toEqual(['', 'Supplier', 'Current', '30 Days', '60 Days', '90 Days', '120+ Days', 'Total']);
    expect(labels(table)).toEqual([null, null, 'Current', '30 Days', '60 Days', '90 Days', '120+ Days', 'Total']);
    // The footer totals row carries the same labels, and its empty chevron cell is hidden on phones.
    const foot = [...table.querySelectorAll(':scope > tfoot > tr > td')];
    expect(foot.map(td => td.getAttribute('data-label'))).toEqual([null, null, 'Current', '30 Days', '60 Days', '90 Days', '120+ Days', 'Total']);
    expect(foot[0].className).toContain('max-lg:hidden');
  });

  it('keeps the expand chevron reachable at 44px and the supplier link at 44px', async () => {
    const { container } = render(<Page />);
    await screen.findByText('Acme Supplies');
    const row = container.querySelector('tbody tr')!;
    expect(row.className).toContain('max-lg:relative');
    const chevron = row.querySelector('td')!;
    for (const c of ['max-lg:absolute', 'max-lg:min-h-11', 'max-lg:min-w-11']) expect(chevron.className).toContain(c);
    expect(screen.getByRole('link', { name: 'Acme Supplies' }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('button', { name: /Export CSV/ }).className).toContain('max-lg:min-h-11');
  });

  it('turns the expanded invoice list into cards with a 44px invoice link', async () => {
    const { container } = render(<Page />);
    fireEvent.click(await screen.findByText('Acme Supplies', { selector: 'a' }).then(a => a.closest('tr')!));
    const link = await screen.findByRole('link', { name: 'SI-1' });
    expect(link.className).toContain('max-lg:min-h-11');
    const inner = container.querySelectorAll('table')[1];
    expect(inner.className).toContain('table-cards');
    expect(labels(inner)).toEqual(heads(inner));
  });
});
