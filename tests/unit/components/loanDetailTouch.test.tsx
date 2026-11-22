// Loan detail: the header, tab row, status select and Events tab are phone-sized (the five tabs scroll instead of clipping).
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ query: { id: 'l1' }, asPath: '/', isReady: true, push: () => undefined, replace: () => undefined }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const loan = { id: 'l1', companyId: 'c', curveId: null, reference: 'LN-001', product: 'bond', description: 'Depot bond', principal: 1000, startDate: '2026-01-01', termMonths: 12, rateMode: 'FIXED', margin: 0, fixedRate: 10, residual: 0, dayCount: 'ACT/365', repriceMode: 'x', skipMode: 'x', lumpMode: 'x', recurringSkipMonths: [], status: 'active', ncaCompliant: true, currency: 'ZAR', createdAt: '2026-01-01' };
const events = [{ id: 'e1', loanId: 'l1', kind: 'LUMP', date: '2026-03-01', amount: 500, note: 'Bonus payment', createdAt: '2026-03-01' }];
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => {
    const u = String(url);
    const data = /loans\/l1$/.test(u) ? loan : u.includes('/events') ? events : [];
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

import Page from '../../../pages/accounting/loans/[id]';

afterEach(cleanup);
const SQUARE = ['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center'];

describe('Loan detail on touch', () => {
  it('makes the back link and refresh 44px squares', async () => {
    render(<Page />);
    await screen.findByRole('heading', { level: 1, name: /LN-001/ });
    const back = screen.getAllByRole('link').find(a => a.getAttribute('href') === '/accounting/loans')!;
    for (const c of SQUARE) expect(back.className, c).toContain(c);
    for (const c of SQUARE) expect(screen.getByTitle('Refresh').className, c).toContain(c);
    // Back + icon + reference + badge on one row squeezed the reference onto three lines: the group wraps on phones.
    expect(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!.className).toContain('max-lg:flex-wrap');
  });

  it('lets the five tabs scroll sideways on a phone instead of clipping, each tab 44px and never shrinking', async () => {
    render(<Page />);
    await screen.findByRole('heading', { level: 1, name: /LN-001/ });
    const tabs = ['Overview', 'Schedule', 'Events', 'Rate Curve', 'Compliance'].map(name => screen.getByRole('button', { name }));
    expect(tabs[0].parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:overflow-x-auto', 'max-lg:flex-nowrap']));
    for (const t of tabs) for (const c of ['max-lg:min-h-11', 'max-lg:shrink-0', 'max-lg:whitespace-nowrap']) expect(t.className.split(' '), t.textContent ?? '').toContain(c);
  });

  it('makes the status select 44px and lets the status row wrap', async () => {
    const { container } = render(<Page />);
    await screen.findByRole('heading', { level: 1, name: /LN-001/ });
    const select = container.querySelector('select')!;
    expect(select.className).toContain('max-lg:min-h-11');
    expect(select.parentElement!.parentElement!.className).toContain('max-lg:flex-wrap');
  });

  it('turns the events table into cards and makes its controls 44px', async () => {
    const { container } = render(<Page />);
    await screen.findByRole('heading', { level: 1, name: /LN-001/ });
    fireEvent.click(screen.getByRole('button', { name: 'Events' }));
    await screen.findByText('Bonus payment');
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(['Date', 'Kind', 'Amount', 'Note']);
    const row = table.querySelector(':scope > tbody > tr')!;
    expect([...row.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual(['Date', 'Kind', 'Amount', 'Note']);
    expect(row.querySelectorAll(':scope > td')[3].className.split(' ')).toEqual(expect.arrayContaining(['max-lg:max-w-none', 'max-lg:whitespace-normal']));
    const add = screen.getByRole('button', { name: /Add Event/ });
    expect(add.className).toContain('max-lg:min-h-11');
    fireEvent.click(add);
    const form = container.querySelector('form')!;
    // The date field is already 44px on phones (DateField), so every other control of the form is named here.
    const controls = [form.querySelector('select')!, screen.getByPlaceholderText('Amount (ZAR)'), screen.getByPlaceholderText('Note (optional)'),
      screen.getByRole('button', { name: 'Cancel' }), screen.getByRole('button', { name: 'Save Event' })];
    for (const c of controls) expect(c.className, c.outerHTML.slice(0, 50)).toContain('max-lg:min-h-11');
  });
});
