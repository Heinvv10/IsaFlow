/**
 * Wave 6 DBF (#1571 review M1): the employee profile's "Defined-benefit fund contributions (para 12D)" card lists the factor
 * rows, offers only 3817 / 3825 earnings, holds the factor to 0 < f <= 1 at four decimals, says it is the value on the fund's
 * certificate, and posts it with amount 0 (the server judges it again and refuses a Login-as session).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async (res: { ok: boolean }) => { if (!res.ok) throw new Error('refused'); },
  apiErrorMessage: (e: unknown, fallback: string) => (e instanceof Error && e.message !== 'refused' ? e.message : fallback),
}));

import { EmployeeDbFundCard, isDbEligible, parseFactor } from '@/components/payroll/EmployeeDbFundCard';

const json = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
afterEach(() => { cleanup(); apiFetch.mockReset(); });

describe('parseFactor and isDbEligible', () => {
  it('accepts a fraction above 0 and at most 1 to four decimals only', () => {
    expect(['0.12', '1', '.5', '0.1234', ' 0.4 '].map(parseFactor)).toEqual([0.12, 1, 0.5, 0.1234, 0.4]);
    expect(['', '0', '1.01', '0.12345', '12', '-0.1', 'abc', '0.1e1'].map(parseFactor)).toEqual(Array(8).fill(null));
  });
  it('offers only employer pension (3817) and provident (3825) earnings', () => {
    const c = (code: string, componentType: string) => ({ id: code, name: code, sarsSourceCode: code, componentType });
    expect([c('3817', 'earning'), c(' 3825 ', 'earning')].every(isDbEligible)).toBe(true);
    expect([c('3828', 'earning'), c('4001', 'deduction'), c('3601', 'earning'), c('3817', 'deduction')].some(isDbEligible)).toBe(false);
  });
});

const catalogue = [
  { id: 'db', name: 'Employer DB pension', sarsSourceCode: '3817', componentType: 'earning' },
  { id: 'ra', name: 'Employer RA', sarsSourceCode: '3828', componentType: 'earning' },
];

it('lists only the factor rows, and says the factor is the value on the fund\'s certificate', async () => {
  apiFetch.mockImplementation(async (url: string) => (url === '/api/payroll/components' ? json(catalogue) : json([
    { id: 'a', componentId: 'db', componentName: 'Employer DB pension', effectiveFrom: '2026-11-01', effectiveTo: null, dbMemberCategoryFactor: 0.12 },
    { id: 'b', componentId: 'x', componentName: 'Basic Salary', effectiveFrom: '2026-01-01', effectiveTo: null, dbMemberCategoryFactor: null },
  ])));
  render(<EmployeeDbFundCard employeeId="e1" />);
  await waitFor(() => expect(screen.getByText('Employer DB pension')).toBeTruthy());
  expect(screen.getByText(/factor 0\.12,/)).toBeTruthy();
  expect(screen.queryByText('Basic Salary')).toBeNull();
  expect(screen.getByLabelText('DB fund member category factor').getAttribute('aria-describedby')).toBe('db-factor-help');
  expect(document.getElementById('db-factor-help')!.textContent).toMatch(/on the fund's certificate .*para 12D\(4\)/);
});

it('holds Add until the factor is valid, then posts it with amount 0 and recurring', async () => {
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return json({ id: 'new' });
    return url === '/api/payroll/components' ? json(catalogue) : json([]);
  });
  render(<EmployeeDbFundCard employeeId="e1" />);
  await waitFor(() => expect(screen.getByText('None set by a fund member category factor.')).toBeTruthy());
  fireEvent.click(screen.getByRole('combobox'));
  expect(screen.queryByText('Employer RA (3828)')).toBeNull();
  fireEvent.click(await screen.findByText('Employer DB pension (3817)'));
  const input = screen.getByLabelText('DB fund member category factor');
  const add = screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: '1.5' } });
  expect(add.disabled).toBe(true);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText(/Enter a fraction above 0 and at most 1/)).toBeTruthy();
  fireEvent.change(input, { target: { value: '0.12' } });
  await waitFor(() => expect(add.disabled).toBe(false));
  fireEvent.click(add);
  await waitFor(() => expect(apiFetch.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
  const [url, init] = apiFetch.mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(url).toBe('/api/payroll/employees/e1/components');
  expect(JSON.parse(init.body)).toMatchObject({ componentId: 'db', amount: 0, dbMemberCategoryFactor: 0.12, isRecurring: true });
});

it('shows the server\'s refusal (a Login-as session, a wrong component) and keeps the form', async () => {
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return { ok: false, json: async () => ({}) };
    return url === '/api/payroll/components' ? json(catalogue) : json([]);
  });
  render(<EmployeeDbFundCard employeeId="e1" />);
  await waitFor(() => expect(screen.getByText('None set by a fund member category factor.')).toBeTruthy());
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.click(await screen.findByText('Employer DB pension (3817)'));
  fireEvent.change(screen.getByLabelText('DB fund member category factor'), { target: { value: '0.12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Could not add the defined-benefit contribution - try again');
  expect((screen.getByLabelText('DB fund member category factor') as HTMLInputElement).value).toBe('0.12');
});
