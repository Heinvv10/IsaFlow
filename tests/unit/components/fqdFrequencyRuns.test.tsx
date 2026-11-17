/**
 * Wave 6 FQd in the browser: the employee's pay frequency field, and a weekly run on the new-run page (period list
 * from the company's pay week, posted as { frequency, periodStart }), with the pay-week card's owner/admin edit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { PayFrequencyField } from '@/components/payroll/PayFrequencyField';
import { periodsAround, DEFAULT_PAY_WEEK, formatPayDate, formatPeriodRange } from '@/modules/accounting/services/payroll/payrollPayWeek';

const router = vi.hoisted(() => ({ push: vi.fn(async () => true) }));
const company = vi.hoisted(() => ({ companyRole: 'owner' }));
vi.mock('next/router', () => ({ useRouter: () => ({ ...router, query: {}, isReady: true, pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));

import NewRunPage from '../../../pages/payroll/runs/new';

const fetchMock = vi.fn();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data }), { status });
beforeEach(() => {
  fetchMock.mockReset();
  router.push.mockClear();
  company.companyRole = 'owner';
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pick = async (name: string | RegExp, option: string | RegExp) => {
  fireEvent.click(screen.getByRole('combobox', { name }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
};
const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method);

describe('PayFrequencyField', () => {
  it('loads the frequency and saves a change as { payFrequency }', async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      json({ payFrequency: init?.method === 'PUT' ? 'weekly' : 'monthly' }));
    render(<PayFrequencyField employeeId="e1" canEdit />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Pay frequency' }).getAttribute('aria-disabled')).not.toBe('true'));
    await pick('Pay frequency', 'Weekly');
    fireEvent.click(screen.getByRole('button', { name: 'Save frequency' }));
    expect(await screen.findByText('Pay frequency saved.')).toBeTruthy();
    const [url, init] = calls('PUT')[0]!;
    expect([url, JSON.parse(String(init.body))]).toEqual(['/api/payroll/employees/e1/pay-frequency', { payFrequency: 'weekly' }]);
  });

  it('shows the server refusal and keeps the saved value', async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => (init?.method === 'PUT'
      ? json({ message: 'This employee has an approved run this tax year.' }, 409) : json({ payFrequency: 'monthly' })));
    render(<PayFrequencyField employeeId="e1" canEdit />);
    await waitFor(() => expect(calls('GET')).toHaveLength(1));
    await pick('Pay frequency', 'Fortnightly');
    fireEvent.click(screen.getByRole('button', { name: 'Save frequency' }));
    expect((await screen.findByRole('alert')).textContent).toContain('approved run this tax year');
    expect(screen.queryByText('Pay frequency saved.')).toBeNull();
  });

  it('is read-only with no save for anyone but an owner or admin', async () => {
    fetchMock.mockImplementation(async () => json({ payFrequency: 'weekly' }));
    render(<PayFrequencyField employeeId="e1" canEdit={false} />);
    await waitFor(() => expect(calls('GET')).toHaveLength(1));
    expect(screen.getByRole('combobox', { name: 'Pay frequency' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Save frequency' })).toBeNull();
  });
});

describe('a weekly run on the new-run page', () => {
  const week = { ...DEFAULT_PAY_WEEK, locked: { week: false, anchor: false } };
  const serve = () => fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/payroll/settings/pay-week') return json(init?.method === 'PUT' ? { ...week, payWeekday: 4 } : week);
    return json({ id: 'run-1' }, 201);
  });

  it('lists the pay week\'s periods and posts { frequency, periodStart }', async () => {
    serve();
    render(<NewRunPage />);
    await pick('Pay frequency', 'Weekly');
    const first = periodsAround('weekly', DEFAULT_PAY_WEEK, new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date()))[0]!;
    await screen.findByRole('combobox', { name: /^Period/ });
    await pick(/^Period/, `${formatPeriodRange(first.periodStart, first.periodEnd)} (paid ${formatPayDate(first.payDate)})`);
    fireEvent.click(screen.getByRole('button', { name: 'Create Run' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/payroll/runs/run-1'));
    const post = calls('POST')[0]!;
    expect([post[0], JSON.parse(String(post[1].body))]).toEqual(['/api/payroll/runs', { frequency: 'weekly', periodStart: first.periodStart }]);
  });

  it('refuses to post without a period', async () => {
    serve();
    render(<NewRunPage />);
    await pick('Pay frequency', 'Weekly');
    await screen.findByRole('combobox', { name: /Period/ });
    fireEvent.click(screen.getByRole('button', { name: 'Create Run' }));
    expect(await screen.findByText('Choose the period the run pays for.')).toBeTruthy();
    expect(calls('POST')).toHaveLength(0);
  });

  it('an owner saves the pay week; a manager sees it read-only', async () => {
    serve();
    render(<NewRunPage />);
    await pick('Pay frequency', 'Weekly');
    const card = await screen.findByTestId('pay-week-card');
    fireEvent.click(within(card).getByRole('combobox', { name: 'Paid on' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Thursday' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Save pay week' }));
    await waitFor(() => expect(calls('PUT')).toHaveLength(1));
    expect(JSON.parse(String(calls('PUT')[0]![1].body))).toEqual({ payWeekStartDow: 1, payWeekday: 4, fortnightAnchor: null });
    cleanup();
    company.companyRole = 'manager';
    render(<NewRunPage />);
    await pick('Pay frequency', 'Weekly');
    const ro = await screen.findByTestId('pay-week-card');
    expect(within(ro).queryByRole('button', { name: 'Save pay week' })).toBeNull();
    expect(within(ro).getByText('Only an owner or admin can change the pay week.')).toBeTruthy();
  });
});
