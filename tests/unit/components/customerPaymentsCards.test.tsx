// Customer receipts list: the table becomes labelled cards below lg, and its controls are 44px on phones.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({
    success: true,
    data: { total: 1, payments: [{ id: 'p1', paymentNumber: 'RCT-1', clientName: 'Acme', paymentDate: '2026-08-01', totalAmount: 100, paymentMethod: 'eft', status: 'confirmed' }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/customer-payments/index';

afterEach(cleanup);

describe('Customer receipts on touch', () => {
  it('turns the table into labelled cards on phones', async () => {
    const { container } = render(<Page />);
    await screen.findByText('RCT-1');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    const labels = [...table.querySelectorAll('tbody tr:first-child td')].map(td => td.getAttribute('data-label'));
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent);
    expect(heads).toHaveLength(6);
    expect(labels).toEqual(heads);
  });

  it('gives every control 44px on phones', async () => {
    const { container } = render(<Page />);
    await screen.findByText('RCT-1');
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(7); // Export, Record Payment, 5 tabs
    for (const b of buttons) expect(b.className, b.textContent ?? '').toContain('max-lg:min-h-11');
    const search = container.querySelector('input')!;
    expect(search.className).toContain('max-lg:min-h-11');
    expect(search.className).toContain('max-lg:w-full');
  });
});
