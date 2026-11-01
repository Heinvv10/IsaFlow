/**
 * The employee drawer on /payroll/employees: a row click opens it, a link in the row still navigates, a names-only
 * reader gets no pay and no request for it, and a slow answer for the previous row never lands on the next one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/payroll/MedicalAidReviewBanner', () => ({ MedicalAidReviewBanner: () => null }));
const company = vi.hoisted(() => ({ companyRole: 'owner' as string }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));

import Page from '@/../pages/payroll/employees/index';

const A = { id: 'a1', employeeNumber: 'E-1', firstName: 'Thandi', lastName: 'Nkosi', employmentType: 'permanent', startDate: '2026-03-01T00:00:00.000Z', taxNumber: '0123456789' };
const B = { id: 'b2', employeeNumber: 'E-2', firstName: 'Sipho', lastName: 'Dube', employmentType: 'contract', startDate: '2026-04-01T00:00:00.000Z' };
const NAMES_ONLY = { id: 'a1', employeeNumber: 'E-1', firstName: 'Thandi', lastName: 'Nkosi', employmentType: 'permanent' };
const assignment = (over: Record<string, unknown> = {}) => ({
  id: 'x', componentId: 'c1', componentName: 'Basic Salary', componentType: 'earning', amount: 25000,
  effectiveFrom: '2026-03-01T00:00:00.000Z', effectiveTo: null, isRecurring: true, ...over,
});

type Answer = () => Response | Promise<Response>;
const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const failure = (status: number) => new Response(JSON.stringify({ success: false, error: { message: 'no' } }), { status });
let routes: Record<string, Answer>;
const fetchMock = vi.fn();
const called = (url: string) => fetchMock.mock.calls.filter(([u]) => u === url).length;

beforeEach(() => {
  company.companyRole = 'owner';
  routes = {
    '/api/payroll/employees': () => json([A, B]),
    '/api/payroll/employees/a1': () => json(A),
    '/api/payroll/employees/a1/components': () => json([assignment()]),
    '/api/payroll/employees/b2': () => json(B),
    '/api/payroll/employees/b2/components': () => json([]),
  };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const rowOf = async (text: string) => (await screen.findByText(text)).closest('tr') as HTMLElement;
const drawer = () => screen.findByRole('dialog');

describe('employee drawer', () => {
  it('a row click opens it with the employee and their pay', async () => {
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    const panel = within(await drawer());
    expect(await panel.findByText('Basic Salary')).toBeTruthy();
    expect(panel.getByText('0123456789')).toBeTruthy();
    expect(panel.getByText(/25[\s ,]?000\.00/)).toBeTruthy();
    expect(panel.getByRole('link', { name: /full profile/i }).getAttribute('href')).toBe('/payroll/employees/a1');
  });

  it('a link in the row navigates and does not open it', async () => {
    render(<Page />);
    const row = await rowOf('Thandi Nkosi');
    const link = within(row).getByRole('link', { name: 'View' });
    link.addEventListener('click', e => e.preventDefault());
    fireEvent.click(link);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(called('/api/payroll/employees/a1')).toBe(0);
  });

  it('the keyboard has a way in: a button in the row', async () => {
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByRole('button', { name: 'Quick view of Thandi Nkosi' }));
    expect(await within(await drawer()).findByText('Basic Salary')).toBeTruthy();
  });

  it('focus moves into the drawer, and back to the row button on close', async () => {
    render(<Page />);
    const open = within(await rowOf('Thandi Nkosi')).getByRole('button', { name: 'Quick view of Thandi Nkosi' });
    open.focus();
    fireEvent.click(open);
    const panel = await drawer();
    await within(panel).findByText('Basic Salary');
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(panel).getByRole('button', { name: 'Close drawer' }));
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it('a names-only reader sees no pay, and pay is never requested', async () => {
    company.companyRole = 'viewer';
    routes['/api/payroll/employees'] = () => json([NAMES_ONLY]);
    routes['/api/payroll/employees/a1'] = () => json(NAMES_ONLY);
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    const panel = within(await drawer());
    expect(await panel.findByText('Pay details hidden for your role')).toBeTruthy();
    expect(called('/api/payroll/employees/a1/components')).toBe(0);
    expect(panel.queryByText(/Start date|Tax number/)).toBeNull();
  });

  it('a 403 on pay reads as hidden, not as a failure', async () => {
    routes['/api/payroll/employees/a1/components'] = () => failure(403);
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    expect(await within(await drawer()).findByText('Pay details hidden for your role')).toBeTruthy();
  });

  it('a failed load says so, with no pay claimed', async () => {
    routes['/api/payroll/employees/a1/components'] = () => failure(500);
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    const panel = within(await drawer());
    expect(await panel.findByRole('alert')).toBeTruthy();
    expect(panel.queryByText('No pay components yet.')).toBeNull();
  });

  it('an employee with no pay says so', async () => {
    render(<Page />);
    fireEvent.click(within(await rowOf('Sipho Dube')).getByText('contract'));
    expect(await within(await drawer()).findByText('No pay components yet.')).toBeTruthy();
  });

  it('an ended assignment is not shown as current pay', async () => {
    routes['/api/payroll/employees/a1/components'] = () => json([
      assignment({ id: 'old', componentName: 'Old Salary', effectiveTo: '2026-03-31T00:00:00.000Z' }), assignment(),
    ]);
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    const panel = within(await drawer());
    await panel.findByText('Basic Salary');
    expect(panel.queryByText('Old Salary')).toBeNull();
  });

  it("a slow answer for the previous employee does not land on the next one's drawer", async () => {
    let releaseA: (r: Response) => void = () => undefined;
    routes['/api/payroll/employees/a1'] = () => new Promise<Response>(r => { releaseA = r; });
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    const first = await drawer();
    fireEvent.click(within(first).getByRole('button', { name: 'Close drawer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within(await rowOf('Sipho Dube')).getByText('contract'));
    const panel = within(await drawer());
    await panel.findByText('E-2');
    releaseA(json(A));
    await new Promise(r => setTimeout(r, 20));
    expect(panel.queryByText('E-1')).toBeNull();
    expect(panel.getByText('E-2')).toBeTruthy();
  });
});
