/**
 * Wave 5 RF: the employee profile's "Retirement fund contributions (% of RFI)" card lists the percent rows, offers only the
 * components a percentage may go on, and posts the percentage as a fraction with amount 0 (the server judges it again).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async (res: { ok: boolean }) => { if (!res.ok) throw new Error('refused'); },
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

import { EmployeeRfiContributionsCard, isRfiEligible, overlapMessage, percentToFraction } from '@/components/payroll/EmployeeRfiContributionsCard';

const json = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
afterEach(() => { cleanup(); apiFetch.mockReset(); });

it('percentToFraction: 7.5 → 0.075; nothing, 0 and above 100 are not percentages', () => {
  expect([percentToFraction('7.5'), percentToFraction('15'), percentToFraction('100')]).toEqual([0.075, 0.15, 1]);
  expect([percentToFraction(''), percentToFraction('0'), percentToFraction('101'), percentToFraction('abc')]).toEqual([null, null, null, null]);
});

it('isRfiEligible: 4001/4003/4006 deductions and 3817/3825/3828 earnings only', () => {
  const c = (code: string, componentType: string) => ({ id: code, name: code, sarsSourceCode: code, componentType });
  expect([c('4001', 'deduction'), c('4006', 'deduction'), c('3817', 'earning'), c(' 3828 ', 'earning')].every(isRfiEligible)).toBe(true);
  expect([c('3601', 'earning'), c('4005', 'deduction'), c('3817', 'deduction'), c('4001', 'earning')].some(isRfiEligible)).toBe(false);
});

it('lists only the percent rows, as a percentage of RFI', async () => {
  apiFetch.mockImplementation(async (url: string) => (url === '/api/payroll/components' ? json([]) : json([
    { id: 'a', componentId: 'x', componentName: 'Employer pension', effectiveFrom: '2026-11-01', effectiveTo: null, percentOfRfi: 0.15 },
    { id: 'b', componentId: 'y', componentName: 'Basic Salary', effectiveFrom: '2026-01-01', effectiveTo: null, percentOfRfi: null },
  ])));
  render(<EmployeeRfiContributionsCard employeeId="e1" />);
  await waitFor(() => expect(screen.getByText('Employer pension')).toBeTruthy());
  expect(screen.getByText(/15% of retirement-funding income/)).toBeTruthy();
  expect(screen.queryByText('Basic Salary')).toBeNull();
});

const row = (over: Record<string, unknown>) => ({ id: 'a', componentId: 'x', componentName: 'Employer pension', amount: 0, effectiveFrom: '2026-11-01',
  effectiveTo: null, percentOfRfi: 0.075, ...over });

it('overlapMessage names the open row in plain words, and is null when it ended before the new start', () => {
  expect(overlapMessage([row({})], 'x', '2026-12-01')).toBe(
    'Employer pension already runs from 01 Nov 2026 (7.5% of retirement-funding income). End it, or edit its dates, before adding another.');
  expect(overlapMessage([row({ effectiveTo: '2026-11-30' })], 'x', '2026-12-01')).toBeNull();
  expect(overlapMessage([row({})], 'other', '2026-12-01')).toBeNull();
});

it('End and Edit dates on a percent row call the page actions', async () => {
  apiFetch.mockImplementation(async (url: string) => (url === '/api/payroll/components' ? json([]) : json([row({})])));
  const onEnd = vi.fn();
  const onEditDates = vi.fn();
  render(<EmployeeRfiContributionsCard employeeId="e1" onEnd={onEnd} onEditDates={onEditDates} />);
  fireEvent.click(await screen.findByRole('button', { name: 'End Employer pension' }));
  expect(onEnd).toHaveBeenCalledWith('a');
  fireEvent.click(screen.getByRole('button', { name: 'Edit dates for Employer pension' }));
  expect(await screen.findByRole('group', { name: 'Edit dates for Employer pension' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save dates' })).toBeTruthy();
});

it('a pre-RF row kept as cash gets a note saying how to switch', async () => {
  apiFetch.mockImplementation(async (url: string) => (url === '/api/payroll/components' ? json([]) : json([
    row({ id: 'k', componentName: 'Old employer pension', amount: 1500, percentOfRfi: null, employerFundAsCash: true, effectiveFrom: '2025-03-01' }),
  ])));
  render(<EmployeeRfiContributionsCard employeeId="e1" />);
  const note = await screen.findByRole('note');
  expect(note.textContent).toMatch(/Old employer pension .*still paid as cash.*end it and add it here as a % of retirement-funding income/);
});
