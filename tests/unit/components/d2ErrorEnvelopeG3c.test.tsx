/**
 * D2: home, bureau and payroll-leave pages show the server's own message from the real error envelope
 * `{ success:false, error:{ code, message } }`, not a generic fallback.
 */
import { cleanup, fireEvent, render, screen, configure } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const LEAVE_ID = '11111111-2222-4333-8444-555555555555';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
// One stable router object: [id].tsx lists `router` in a useCallback dep, so a fresh object per render would refetch forever.
const router = vi.hoisted(() => ({ query: { id: '11111111-2222-4333-8444-555555555555' }, isReady: true, push: vi.fn(), replace: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({
    activeCompany: { id: 'co-1' }, companyRole: 'owner', loading: false, switchCompany: vi.fn(),
    companies: [{ companyId: 'co-2', companyName: 'Second Co' }],
  }),
}));

import { apiFetch } from '@/lib/apiFetch';
import HomePage from '../../../pages/home';
import BureauDashboardPage from '../../../pages/bureau/index';
import BureauClientsPage from '../../../pages/bureau/clients/index';
import LeaveDetailPage from '../../../pages/payroll/leave/[id]';
import NewLeaveRequestPage from '../../../pages/payroll/leave/new';

useApiJsonOverMock();
configure({ asyncUtilTimeout: 4000 });   // the full suite runs on a loaded host
afterEach(cleanup);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.stubGlobal('confirm', () => true); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ success: true, data });
const refuse = (msg: string, status: number) => msg === '' ? new Response('', { status: 500 }) : json({ success: false, error: { code: 'REFUSED', message: msg } }, status);
const method = (init: unknown) => String((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase();

/** `refused(path, method)` true -> real error envelope; otherwise `answer(path, method)` success data. */
function script(refused: (p: string, m: string) => boolean, msg: string, status: number, answer: (p: string, m: string) => unknown) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const p = String(url); const m = method(init);
    return refused(p, m) ? refuse(msg, status) : ok(answer(p, m));
  });
}

describe('home and bureau dashboards show the server message', () => {
  it('home: /api/home refused', async () => {
    const msg = 'D2 server says no: home refused';
    script((p) => p === '/api/home', msg, 500, () => ({}));
    render(<HomePage />);
    expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
  });

  it('bureau dashboard: /api/bureau refused', async () => {
    const msg = 'D2 server says no: bureau dashboard refused';
    script((p) => p === '/api/bureau', msg, 403, () => ({}));
    render(<BureauDashboardPage />);
    expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
  });
});

/** The clients page loads /api/bureau twice (the active bureau id is a dep of its own loader); wait for both. */
const settled = () => vi.waitFor(() =>
  expect(vi.mocked(apiFetch).mock.calls.filter(c => c[0] === '/api/bureau')).toHaveLength(2), { timeout: 4000 });

describe('bureau clients page shows the server message', () => {
  const bureaus = { bureaus: [{ id: 'b1', name: 'Bureau One', ownerUserId: 'u1', role: 'owner' }] };
  const clients = { companies: [{ bureauId: 'b1', companyId: 'co-9', companyName: 'Linked Co', addedAt: '2026-01-01T00:00:00Z' }] };
  const answer = (p: string) => (p === '/api/bureau' ? bureaus : p.startsWith('/api/bureau/clients') ? clients : {});

  it('when loading the clients is refused', async () => {
    const msg = 'D2 server says no: clients load refused';
    script((p, m) => p.startsWith('/api/bureau/clients') && m === 'GET', msg, 500, answer);
    render(<BureauClientsPage />);
    expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
  });

  it('when linking a company is refused', async () => {
    const msg = 'D2 server says no: link refused';
    script((p, m) => p.startsWith('/api/bureau/clients') && m === 'POST', msg, 409, answer);
    render(<BureauClientsPage />);
    await settled();
    fireEvent.click(await screen.findByRole('button', { name: /link to bureau/i }));
    expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
  });

  it('when unlinking a company is refused', async () => {
    const msg = 'D2 server says no: unlink refused';
    script((p, m) => p.startsWith('/api/bureau/clients') && m === 'DELETE', msg, 409, answer);
    render(<BureauClientsPage />);
    await settled();
    fireEvent.click(await screen.findByRole('button', { name: /unlink/i }));
    expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
  });
});

describe('payroll leave pages show the server message', () => {
  it.each([
    ['server message', 'D2 server says no: approve refused', /D2 server says no: approve refused/],
    ['empty 500: a plain sentence', '', /Could not update the leave request - try again/],
  ])('detail: approving a request is refused (%s)', async (_n, msg, expected) => {
    const request = { id: LEAVE_ID, employeeName: 'Ann', employeeNumber: 'E1', leaveTypeName: 'Annual', startDate: '2026-10-01',
      endDate: '2026-10-02', days: 2, reason: null, status: 'pending', approvedAt: null, createdAt: '2026-09-30T00:00:00Z' };
    script((_p, m) => m === 'PUT', msg, 409, () => request);
    render(<LeaveDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.queryByText(/HTTP \d+|Unexpected end/)).toBeNull();
  });

  it.each([
    ['server message', 'D2 server says no: leave request refused', /D2 server says no: leave request refused/],
    ['empty 500: a plain sentence', '', /Could not save the leave request - try again/],
  ])('new: submitting the request is refused (%s)', async (_n, msg, expected) => {
    script((p, m) => p === '/api/payroll/leave' && m === 'POST', msg, 422, (p) =>
      p.includes('employees') ? [{ id: 'e1', firstName: 'Ann', lastName: 'Lee', employeeNumber: 'E1' }]
        : p.includes('leave/types') ? [{ id: 't1', name: 'Annual', isPaid: true }] : {});
    const { container } = render(<NewLeaveRequestPage />);
    const [emp, type] = Array.from(await vi.waitFor(() => {
      const s = container.querySelectorAll('select');
      if (s.length < 2 || s[0]!.options.length < 2) throw new Error('options not loaded');
      return s;
    }));
    fireEvent.change(emp!, { target: { value: 'e1' } });
    fireEvent.change(type!, { target: { value: 't1' } });
    const [start, end] = Array.from(container.querySelectorAll('input[type="date"]'));
    fireEvent.change(start!, { target: { value: '2026-10-05' } });
    fireEvent.change(end!, { target: { value: '2026-10-07' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.queryByText(/HTTP \d+|Unexpected end/)).toBeNull();
  });
});

describe('success: pages render and complete with a valid envelope', () => {
  const none = () => false;
  const stats = { overdue: 0, dueSoon: 0, info: 1, total: 1 };
  const item = (task: string) => ({ bureauId: 'b1', bureauName: 'B', companyId: 'co-9', companyName: 'C', task, detail: 'd', dueAt: null, href: '/x', severity: 'info' });

  it('success: home renders the data it received', async () => {
    script(none, '', 0, () => ({ metrics: { cash: 1, ar: 2, ap: 3, revenueMtd: 4, profitMtd: 5 }, workItems: [item('Chase Hippo Debtors')] }));
    render(<HomePage />);
    expect(await screen.findByText('Chase Hippo Debtors')).toBeTruthy();
  });

  it('success: bureau dashboard renders the data it received', async () => {
    script(none, '', 0, () => ({ bureaus: [{ id: 'b1', name: 'Okapi Practice', ownerUserId: 'u1', role: 'owner' }],
      workItems: [item('Reconcile Okapi bank')], stats, companyCount: 1 }));
    render(<BureauDashboardPage />);
    expect(await screen.findByText('Reconcile Okapi bank')).toBeTruthy();
    expect(screen.getByText(/Okapi Practice/)).toBeTruthy();
  });

  it('success: bureau clients renders the data it received', async () => {
    script(none, '', 0, (p) => (p === '/api/bureau' ? { bureaus: [{ id: 'b1', name: 'Bureau One', ownerUserId: 'u1', role: 'owner' }] }
      : { companies: [{ bureauId: 'b1', companyId: 'co-9', companyName: 'Capybara Holdings', addedAt: '2026-01-01T00:00:00Z' }] }));
    render(<BureauClientsPage />);
    expect(await screen.findByText('Capybara Holdings')).toBeTruthy();
  });

  it('success: leave detail approve completes and shows the new status', async () => {
    const base = { id: LEAVE_ID, employeeName: 'Ann', employeeNumber: 'E1', leaveTypeName: 'Annual', startDate: '2026-10-01',
      endDate: '2026-10-02', days: 2, reason: null, approvedAt: null, createdAt: '2026-09-30T00:00:00Z' };
    let approved = false;
    script(none, '', 0, (_p, m) => { if (m === 'PUT') approved = true; return { ...base, status: approved ? 'approved' : 'pending' }; });
    render(<LeaveDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    expect(await screen.findByText('approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('success: leave new submit completes and returns to the list', async () => {
    router.push.mockClear();
    script(none, '', 0, (p) => (p.includes('employees') ? [{ id: 'e1', firstName: 'Ann', lastName: 'Lee', employeeNumber: 'E1' }]
      : p.includes('leave/types') ? [{ id: 't1', name: 'Annual', isPaid: true }] : {}));
    const { container } = render(<NewLeaveRequestPage />);
    const [emp, type] = Array.from(await vi.waitFor(() => {
      const s = container.querySelectorAll('select');
      if (s.length < 2 || s[0]!.options.length < 2) throw new Error('options not loaded');
      return s;
    }));
    fireEvent.change(emp!, { target: { value: 'e1' } });
    fireEvent.change(type!, { target: { value: 't1' } });
    const [start, end] = Array.from(container.querySelectorAll('input[type="date"]'));
    fireEvent.change(start!, { target: { value: '2026-10-05' } });
    fireEvent.change(end!, { target: { value: '2026-10-07' } });
    fireEvent.submit(container.querySelector('form')!);
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/payroll/leave'));
  });
});
