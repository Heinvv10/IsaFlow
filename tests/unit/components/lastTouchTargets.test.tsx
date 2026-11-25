// Phone gaps: the My Reports "New Report"/"Create Report" links (36 px, found by the prod proof at 390 px) and the per-row Run/Edit/Delete (about 24 px, found in review) and the employee-portal sign-in (email, password,
// Sign in: 36 px, and the employer choices after a multi-employer login).
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ items: [] as unknown[] }));
const router = vi.hoisted(() => ({ push: () => undefined, replace: () => undefined, query: {}, pathname: '/', asPath: '/', isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { items: state.items } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));
vi.mock('@/components/employeePortal/portalFetch', () => {
  class PortalCallError extends Error { status = 409; reason = 'CHOOSE_EMPLOYER'; details = { employers: [{ accessId: 'a1', employer: 'Acme Fibre' }, { accessId: 'a2', employer: 'Blitz Co' }] }; }
  return { PortalCallError, portalCall: vi.fn(async () => { throw new PortalCallError('choose'); }) };
});

import MyReports from '../../../pages/accounting/reports/my-reports';
import PortalLogin from '../../../pages/employee-portal/login';

afterEach(() => { cleanup(); state.items = []; });
const cls = (el: Element) => el.className.split(' ');

describe('My Reports links on touch', () => {
  it('the header New Report and the empty-state Create Report links are 44px tap targets', async () => {
    render(<MyReports />);
    const create = await screen.findByRole('link', { name: /Create Report/ });
    expect(cls(create)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('link', { name: /New Report/ }))).toContain('max-lg:min-h-11');
  });
});

describe('My Reports template list on touch', () => {
  it('is labelled cards (name = heading, actions unlabelled) and the Shared cell hides itself when empty', async () => {
    state.items = [
      { id: 'r1', name: 'Aged debtors', description: 'd', dataSource: 'invoices', isShared: true, updatedAt: '2026-11-20T08:00:00Z' },
      { id: 'r2', name: 'Stock by bin', description: 'd', dataSource: 'invoices', isShared: false, updatedAt: '2026-11-21T08:00:00Z' },
    ];
    const { container } = render(<MyReports />);
    await screen.findByText('Aged debtors');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Name', 'Data Source', 'Last Updated', 'Shared', '']);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, 'Data Source', 'Last Updated', 'Shared', null]);
    for (const r of rows) expect(cls(r.querySelector('td[data-label="Shared"]')!)).toContain('max-lg:empty:!hidden');
    expect(rows[0]!.querySelector('td[data-label="Shared"]')!.childElementCount).toBe(1); // shared: has content
    expect(rows[1]!.querySelector('td[data-label="Shared"]')!.matches(':empty')).toBe(true); // not shared: truly empty, so max-lg:empty:!hidden applies
  });
});

describe('My Reports row actions on touch', () => {
  it('Run, Edit and Delete are 44px targets on phones', async () => {
    state.items = [{ id: 'r1', name: 'Aged debtors by branch', description: 'd', dataSource: 'invoices', isShared: false, updatedAt: '2026-11-20T08:00:00Z' }];
    render(<MyReports />);
    await screen.findByText('Aged debtors by branch');
    for (const el of [screen.getByRole('button', { name: /Run/ }), screen.getByRole('link', { name: /Edit/ }), screen.getByRole('button', { name: /Delete/ })]) {
      expect(cls(el)).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:min-w-11', 'max-lg:justify-center']));
    }
  });
});

describe('Employee portal sign-in on touch', () => {
  it('the email and password fields and the Sign in button are 44px', () => {
    render(<PortalLogin />);
    expect(cls(screen.getByLabelText('Email address'))).toContain('max-lg:min-h-11');
    expect(cls(screen.getByLabelText('Password'))).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('button', { name: 'Sign in' }))).toContain('max-lg:min-h-11');
  });

  it('the employer choices shown after a multi-employer sign-in are 44px too', async () => {
    render(<PortalLogin />);
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const choice = await screen.findByRole('button', { name: 'Acme Fibre' });
    await waitFor(() => expect(cls(choice)).toContain('max-lg:min-h-11'));
    expect(cls(screen.getByRole('button', { name: 'Blitz Co' }))).toContain('max-lg:min-h-11');
  });
});
