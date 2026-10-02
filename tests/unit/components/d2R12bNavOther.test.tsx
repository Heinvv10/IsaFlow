// D2 round 12b: navigation after a successful write (leave request, accept-invite), plus forgot-password and the
// payment-link page. A failed navigation is not a failed write; the busy flag never stays stuck.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), back: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/contexts/CompanyContext', () => { const v = { activeCompany: { id: 'co1' }, loading: false, companyRole: 'owner' }; return { useCompany: () => v }; });
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import NewLeavePage from '../../../pages/payroll/leave/new';
import LeaveDetailPage from '../../../pages/payroll/leave/[id]';
import AcceptInvitePage from '../../../pages/accept-invite';
import ForgotPasswordPage from '../../../pages/forgot-password';
import PortalPayPage from '../../../pages/portal/pay/[token]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.push.mockReset(); router.query = {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const LEAVE_ID = '11111111-1111-4111-8111-111111111111';
const submitBtn = (c: HTMLElement) => c.querySelector('button[type="submit"]') as HTMLButtonElement;

describe('new leave request', () => {
  const setup = async () => {
    serve(
      on('POST', '/api/payroll/leave', () => ok({ id: 'l1' })),
      on('GET', '/api/payroll/employees', () => ok([{ id: 'e1', firstName: 'Ann', lastName: 'Lee', employeeNumber: 'E1' }])),
      on('GET', '/api/payroll/leave/types', () => ok([{ id: 't1', name: 'Annual', isPaid: true }])),
    );
    const { container } = render(<NewLeavePage />);
    await screen.findByText(/Ann Lee/);
    const sel = container.querySelectorAll('select');
    fireEvent.change(sel[0]!, { target: { value: 'e1' } });
    fireEvent.change(sel[1]!, { target: { value: 't1' } });
    const dates = container.querySelectorAll('input[type="date"]');
    fireEvent.change(dates[0]!, { target: { value: '2026-10-05' } });
    fireEvent.change(dates[1]!, { target: { value: '2026-10-07' } });
    fireEvent.submit(container.querySelector('form')!);
    return container;
  };
  it('a rejecting push is not "could not save" and frees the button', async () => {
    router.push.mockRejectedValue(new Error('Route Cancelled'));
    const c = await setup();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/payroll/leave'));
    await waitFor(() => expect(submitBtn(c).disabled).toBe(false));
    expect(document.body.textContent).not.toContain('Could not save the leave request');
  });
  it('a push that resolves false frees the button', async () => {
    router.push.mockResolvedValue(false);
    const c = await setup();
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    await waitFor(() => expect(submitBtn(c).disabled).toBe(false));
  });
});

describe('leave request delete', () => {
  const setup = async () => {
    router.query = { id: LEAVE_ID };
    vi.stubGlobal('confirm', () => true);
    serve(
      on('DELETE', '/api/payroll/leave/', () => ok({})),
      on('GET', '/api/payroll/leave/', () => ok({ id: LEAVE_ID, employeeName: 'Ann Lee', leaveTypeName: 'Annual', startDate: '2026-10-05', endDate: '2026-10-07', days: 3, reason: null, status: 'pending', approvedAt: null, createdAt: '2026-10-01' })),
    );
    render(<LeaveDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /delete/i }));
  };
  it('a rejecting push is not "could not delete" and the delete button comes back', async () => {
    router.push.mockRejectedValue(new Error('Route Cancelled'));
    await setup();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/payroll/leave'));
    await waitFor(() => expect((screen.getByRole('button', { name: /delete/i }) as HTMLButtonElement).disabled).toBe(false));
    expect(document.body.textContent).not.toContain('Could not delete the leave request');
  });
});

describe('accept invite', () => {
  const setup = async () => {
    router.query = { token: 'tok' };
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => init?.method === 'POST'
      ? ok({})
      : ok({ email: 'a@b.test', role: 'admin', company_name: 'D2 Co' })));
    const { container } = render(<AcceptInvitePage />);
    await screen.findByText(/Join D2 Co/);
    fireEvent.change(container.querySelector('input[type="password"]')!, { target: { value: 'correct horse battery' } });
    fireEvent.submit(container.querySelector('form')!);
    return container;
  };
  it('a rejecting push does not say "Network error" for an accepted invite and the button is not stuck', async () => {
    router.push.mockRejectedValue(new Error('Route Cancelled'));
    const c = await setup();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/accounting/dashboard'));
    await waitFor(() => expect(submitBtn(c).disabled).toBe(false));
    expect(document.body.textContent).not.toMatch(/Network error|could not submit|Could not accept/i);
  });
  it('a push that resolves false frees the button', async () => {
    router.push.mockResolvedValue(false);
    const c = await setup();
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    await waitFor(() => expect(submitBtn(c).disabled).toBe(false));
  });
  it('a dropped connection says what could not be done', async () => {
    router.query = { token: 'tok' };
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('socket hang up');
      return ok({ email: 'a@b.test', role: 'admin', company_name: 'D2 Co' });
    }));
    const { container } = render(<AcceptInvitePage />);
    await screen.findByText(/Join D2 Co/);
    fireEvent.change(container.querySelector('input[type="password"]')!, { target: { value: 'correct horse battery' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByText('Could not accept the invitation - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('Network error');
    expect(submitBtn(container).disabled).toBe(false);
  });
});

describe('forgot password', () => {
  const SENT = 'Could not send the reset link - try again';
  const run = async (fetchImpl: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    const { container } = render(<ForgotPasswordPage />);
    fireEvent.change(container.querySelector('input[type="email"]')!, { target: { value: 'd2@example.test' } });
    fireEvent.submit(container.querySelector('form')!);
  };
  it.each([[502], [400]])('a %i shows an error, not the success screen', async (status) => {
    await run(async () => new Response('', { status }));
    expect(await screen.findByText(SENT)).toBeDefined();
    expect(screen.queryByText('Check your email')).toBeNull();
  });
  it('a rejected fetch shows an error', async () => {
    await run(async () => { throw new Error('socket hang up'); });
    expect(await screen.findByText(SENT)).toBeDefined();
    expect(screen.queryByText('Check your email')).toBeNull();
  });
  it('a 429 keeps its own message', async () => {
    await run(async () => new Response('', { status: 429 }));
    expect(await screen.findByText(/Too many requests/)).toBeDefined();
  });
  it('a 200 shows the same non-revealing success screen', async () => {
    await run(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await screen.findByText('Check your email')).toBeDefined();
    expect(document.body.textContent).toContain('If an account exists for');
    expect(screen.queryByText(SENT)).toBeNull();
  });
});

describe('portal payment link', () => {
  const NF = 'This payment link was not found or has expired.';
  beforeEach(() => { router.query = { token: 'tok' }; });
  it.each([[404], [410]])('a %i with no message says the link was not found or has expired', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
    render(<PortalPayPage />);
    expect(await screen.findByText(NF)).toBeDefined();
  });
  it('the server message still wins on a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, error: { message: 'Link was cancelled by the sender.' } }), { status: 404 })));
    render(<PortalPayPage />);
    expect(await screen.findByText('Link was cancelled by the sender.')).toBeDefined();
  });
  it('a 5xx keeps the load sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    render(<PortalPayPage />);
    expect(await screen.findByText('Could not load the payment details - try again')).toBeDefined();
  });
});
