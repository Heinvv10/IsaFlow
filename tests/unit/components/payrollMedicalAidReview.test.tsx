/**
 * D1 — the new-employee form no longer pre-ticks "Medical aid main member", and
 * the employees list shows a dismissible review banner for main members with no
 * medical-aid deduction (dismissal in localStorage; a newly flagged employee
 * brings it back; a viewer neither sees it nor triggers the fetch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, serve } from '../helpers/d2R3a6';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), back: vi.fn() }));
const company = vi.hoisted(() => ({ role: 'owner' as string | null }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => { const r = { ...router, isReady: true, replace: vi.fn(), pathname: '/' }; return { useRouter: () => r }; });
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ companyRole: company.role, activeCompany: { id: 'co-1' } }),
}));

import { apiFetch } from '@/lib/apiFetch';
import NewEmployeePage from '../../../pages/payroll/employees/new';
import EmployeesListPage from '../../../pages/payroll/employees/index';

useApiJsonOverMock();
const KEY = 'isaflow:payroll:medical-aid-review-dismissed:co-1';
const REVIEW_URL = '/api/payroll/employees/medical-aid-review';
const E1 = { id: 'e1', employeeNumber: 'E1', firstName: 'Ann', lastName: 'Lee', medicalAidDependantsCount: 0 };
const E2 = { id: 'e2', employeeNumber: 'E2', firstName: 'Bob', lastName: 'Ng', medicalAidDependantsCount: 1 };

beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.push.mockReset(); window.localStorage.clear(); company.role = 'owner'; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const reviewCalls = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes(REVIEW_URL)).length;
const serveReview = (employees: unknown[]) => serve(
  (u) => (u.includes(REVIEW_URL) ? ok({ count: employees.length, employees }) : undefined),
);

describe('new employee form', () => {
  it('"Medical aid main member" is unticked by default and submits false', async () => {
    serve((u, m) => (m === 'POST' && u.endsWith('/api/payroll/employees') ? ok({ id: 'new1' }) : undefined));
    const { container } = render(<NewEmployeePage />);
    const box = screen.getByLabelText('Medical aid main member') as HTMLInputElement;
    expect(box.checked).toBe(false);
    const text = (i: number, v: string) => fireEvent.change(container.querySelectorAll('input')[i]!, { target: { value: v } });
    text(0, 'Ann'); text(1, 'Lee'); text(2, 'E1');
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    const post = vi.mocked(apiFetch).mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body)).medicalAidMainMember).toBe(false);
  });

  it('ticking the box submits true', async () => {
    serve((u, m) => (m === 'POST' && u.endsWith('/api/payroll/employees') ? ok({ id: 'new1' }) : undefined));
    const { container } = render(<NewEmployeePage />);
    fireEvent.click(screen.getByLabelText('Medical aid main member'));
    const text = (i: number, v: string) => fireEvent.change(container.querySelectorAll('input')[i]!, { target: { value: v } });
    text(0, 'Ann'); text(1, 'Lee'); text(2, 'E1');
    fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    const post = vi.mocked(apiFetch).mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body)).medicalAidMainMember).toBe(true);
  });
});

describe('employees list — medical-aid review banner', () => {
  it('names the count and links each flagged employee', async () => {
    serveReview([E1, E2]);
    render(<EmployeesListPage />);
    const banner = await screen.findByTestId('medical-aid-review-banner');
    expect(banner.textContent).toContain('2 employees are marked as medical-aid main members but have no medical-aid deduction');
    expect(screen.getByText('Ann Lee (E1)').closest('a')!.getAttribute('href')).toBe('/payroll/employees/e1');
    expect(screen.getByText('Bob Ng (E2)').closest('a')!.getAttribute('href')).toBe('/payroll/employees/e2');
  });

  it('dismiss hides it, stores the ids, and a remount stays hidden', async () => {
    serveReview([E1]);
    const first = render(<EmployeesListPage />);
    await screen.findByTestId('medical-aid-review-banner');
    fireEvent.click(screen.getByLabelText('Dismiss medical-aid review'));
    expect(screen.queryByTestId('medical-aid-review-banner')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(['e1']);
    first.unmount();
    render(<EmployeesListPage />);
    await waitFor(() => expect(reviewCalls()).toBe(2));
    expect(screen.queryByTestId('medical-aid-review-banner')).toBeNull();
  });

  it('an employee flagged after the dismissal brings the banner back', async () => {
    window.localStorage.setItem(KEY, JSON.stringify(['e1']));
    serveReview([E1, E2]);
    render(<EmployeesListPage />);
    expect((await screen.findByTestId('medical-aid-review-banner')).textContent).toContain('2 employees');
  });

  it('nothing flagged → no banner', async () => {
    serveReview([]);
    render(<EmployeesListPage />);
    await waitFor(() => expect(reviewCalls()).toBe(1));
    expect(screen.queryByTestId('medical-aid-review-banner')).toBeNull();
  });

  it('a viewer gets no banner and no review request', async () => {
    company.role = 'viewer';
    serveReview([E1]);
    render(<EmployeesListPage />);
    await screen.findByText('No employees yet');
    expect(reviewCalls()).toBe(0);
    expect(screen.queryByTestId('medical-aid-review-banner')).toBeNull();
  });

  it('a refused review request shows no banner and no error', async () => {
    serve((u) => (u.includes(REVIEW_URL) ? new Response('', { status: 500 }) : undefined));
    render(<EmployeesListPage />);
    await waitFor(() => expect(reviewCalls()).toBe(1));
    expect(screen.queryByTestId('medical-aid-review-banner')).toBeNull();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it('a localStorage that throws does not stop the banner or its dismissal', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    serveReview([E1]);
    render(<EmployeesListPage />);
    await screen.findByTestId('medical-aid-review-banner');
    fireEvent.click(screen.getByLabelText('Dismiss medical-aid review'));
    expect(screen.queryByTestId('medical-aid-review-banner')).toBeNull();
  });
});
