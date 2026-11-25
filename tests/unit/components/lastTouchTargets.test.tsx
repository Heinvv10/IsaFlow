// Two phone gaps the prod proof found at 390 px: the My Reports "New Report"/"Create Report" links (36 px) and the employee-portal sign-in (email, password,
// Sign in: 36 px, and the employer choices after a multi-employer login).
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ push: () => undefined, replace: () => undefined, query: {}, pathname: '/', asPath: '/', isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { items: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));
vi.mock('@/components/employeePortal/portalFetch', () => {
  class PortalCallError extends Error { status = 409; reason = 'CHOOSE_EMPLOYER'; details = { employers: [{ accessId: 'a1', employer: 'Acme Fibre' }, { accessId: 'a2', employer: 'Blitz Co' }] }; }
  return { PortalCallError, portalCall: vi.fn(async () => { throw new PortalCallError('choose'); }) };
});

import MyReports from '../../../pages/accounting/reports/my-reports';
import PortalLogin from '../../../pages/employee-portal/login';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');

describe('My Reports links on touch', () => {
  it('the header New Report and the empty-state Create Report links are 44px tap targets', async () => {
    render(<MyReports />);
    const create = await screen.findByRole('link', { name: /Create Report/ });
    expect(cls(create)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('link', { name: /New Report/ }))).toContain('max-lg:min-h-11');
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
