/**
 * The employee drawer on /payroll/employees: a row click opens it, a link in the row still navigates, a names-only
 * reader gets no pay and no request for it, and a slow answer for the previous row never lands on the next one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/payroll/MedicalAidReviewBanner', () => ({ MedicalAidReviewBanner: () => null }));
const company = vi.hoisted(() => ({ companyRole: 'owner' as string }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));

import Page from '@/../pages/payroll/employees/index';
import { EmployeeDrawerBody } from '@/components/payroll/EmployeeDrawerBody';

const A = { id: 'a1', employeeNumber: 'E-1', firstName: 'Thandi', lastName: 'Nkosi', employmentType: 'permanent', startDate: '2026-03-01T00:00:00.000Z', taxNumber: '0123456789' };
const B = { id: 'b2', employeeNumber: 'E-2', firstName: 'Sipho', lastName: 'Dube', employmentType: 'contract', startDate: '2026-04-01T00:00:00.000Z' };
const NAMES_ONLY = { id: 'a1', employeeNumber: 'E-1', firstName: 'Thandi', lastName: 'Nkosi', employmentType: 'permanent' };
const assignment = (over: Record<string, unknown> = {}) => ({
  id: 'x', componentId: 'c1', componentName: 'Basic Salary', componentType: 'earning', componentActive: true, amount: 25000,
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

  it('the role decides, not the shape of the answer: a write role with no start date still sees pay', async () => {
    routes['/api/payroll/employees/a1'] = () => json({ ...A, startDate: undefined });
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    expect(await within(await drawer()).findByText('Basic Salary')).toBeTruthy();
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

  it('a component made inactive is not shown as current pay: the run does not pay it', async () => {
    routes['/api/payroll/employees/a1/components'] = () => json([
      assignment({ id: 'off', componentName: 'Retired Allowance', componentActive: false }), assignment(),
    ]);
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    const panel = within(await drawer());
    await panel.findByText('Basic Salary');
    expect(panel.queryByText('Retired Allowance')).toBeNull();
  });

  it('an employer contribution says so: the employee is not paid it', async () => {
    routes['/api/payroll/employees/a1/components'] = () => json([
      assignment(), assignment({ id: 'e', componentName: 'Pension match', componentType: 'employer_contribution' }),
    ]);
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    const panel = within(await drawer());
    expect((await panel.findByText('Pension match')).textContent).toMatch(/Employer contribution, recurring, from/);
  });

  it('a deduction says so, so it does not read as an amount earned', async () => {
    routes['/api/payroll/employees/a1/components'] = () => json([
      assignment(), assignment({ id: 'd', componentName: 'Union fees', componentType: 'deduction', isRecurring: false }),
    ]);
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    const panel = within(await drawer());
    expect((await panel.findByText('Union fees')).textContent).toMatch(/Deduction, once-off, from/);
    expect(panel.getByText('Basic Salary').textContent).toMatch(/^Basic SalaryRecurring, from/);
  });

  it('an employee number is shown exactly as captured', async () => {
    routes['/api/payroll/employees/a1'] = () => json({ ...A, employeeNumber: 'abc-1' });
    render(<Page />);
    fireEvent.click(within(await rowOf('Thandi Nkosi')).getByText('permanent'));
    const value = await within(await drawer()).findByText('abc-1');
    expect(value.className).not.toContain('capitalize');
  });
});

describe('focus stays in the drawer while it is open', () => {
  const open = async () => {
    render(<Page />);
    const quickView = within(await rowOf('Thandi Nkosi')).getByRole('button', { name: 'Quick view of Thandi Nkosi' });
    quickView.focus();
    fireEvent.click(quickView);
    const panel = await drawer();
    await within(panel).findByText('Basic Salary');
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    return {
      quickView,
      close: within(panel).getByRole('button', { name: 'Close drawer' }),
      link: within(panel).getByRole('link', { name: /full profile/i }),
    };
  };

  it('Tab on the last control goes to the first, Shift+Tab on the first to the last', async () => {
    const { close, link } = await open();
    link.focus();
    fireEvent.keyDown(link, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(link);
  });

  it('the content can be reached by keyboard, so a long one can be scrolled', async () => {
    await open();
    const content = screen.getByRole('region', { name: 'Thandi Nkosi content' });
    expect(content.tabIndex).toBe(0);
    expect(content.className).toContain('overflow-y-auto');
  });

  it('focus that got out is brought back by the next Tab', async () => {
    const { quickView, close } = await open();
    quickView.focus();
    fireEvent.keyDown(quickView, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
  });

  it('Escape closes it once and gives focus back', async () => {
    const { quickView } = await open();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(quickView);
  });

  it('the page behind does not scroll while it is open, and does again after', async () => {
    const { close } = await open();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(close);
    await waitFor(() => expect(document.body.style.overflow).toBe(''));
  });
});

describe('EmployeeDrawerBody', () => {
  it("a slow answer for the previous employee does not replace the next one's", async () => {
    let releaseA: (r: Response) => void = () => undefined;
    routes['/api/payroll/employees/a1'] = () => new Promise<Response>(r => { releaseA = r; });
    const { rerender } = render(<EmployeeDrawerBody employeeId="a1" mayWrite />);
    await waitFor(() => expect(called('/api/payroll/employees/a1')).toBe(1));
    rerender(<EmployeeDrawerBody employeeId="b2" mayWrite />);
    await screen.findByText('E-2');
    releaseA(json(A));
    // The previous load finishes with its pay read: past that point it would have landed.
    await waitFor(() => expect(called('/api/payroll/employees/a1/components')).toBe(1));
    await act(async () => { await fetchMock.mock.results.at(-1)!.value; });
    expect(screen.queryByText('E-1')).toBeNull();
    expect(screen.getByText('E-2')).toBeTruthy();
  });
});
