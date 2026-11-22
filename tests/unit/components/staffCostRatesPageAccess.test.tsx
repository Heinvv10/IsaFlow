/**
 * #1656 round 10: the Staff Cost Rates page (a person's internal cost per hour is Payroll's). When the server answers 403 to the rate list it
 * shows a clear "needs Payroll access" state and offers nothing (no add form, no table, no delete); it is not the generic load error. With
 * access the form and the rates are there. A 500 is still the server's own message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/forms/GatedDateField', () => ({
  GatedDateField: () => <div data-testid="date-field" />,
  useDateGate: () => ({ blocked: false, reset: () => undefined }),
}));

import StaffCostRatesPage from '@/../pages/accounting/practice/staff-cost-rates/index';

const envelope = (status: number, code: string, message: string) => new Response(JSON.stringify({ success: false, error: { code, message } }), { status });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const route = (rates: () => Response) => fetchMock.mockImplementation(async (url: string) =>
  String(url).includes('staff-cost-rates') ? rates() : ok([{ id: 'u1', displayName: 'Thandi N' }]));

describe('Staff Cost Rates page', () => {
  it('403 on the rate list: the Payroll-access state, no add form, no table, no delete, no generic error', async () => {
    route(() => envelope(403, 'FORBIDDEN', 'Your permissions do not include Payroll.'));
    render(<StaffCostRatesPage />);
    expect(await screen.findByText('Staff cost rates need Payroll access.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/You don't have access to payroll detail/);
    expect(screen.queryByText('Add cost rate')).toBeNull();
    expect(screen.queryByText('Cost rate/hr')).toBeNull();
    expect(screen.queryByTitle('Delete')).toBeNull();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it('with access: the form and the rates are there, and no access message', async () => {
    route(() => ok([{ id: 'r1', userId: 'u1', costRate: 350, currency: 'ZAR', effectiveFrom: '2026-01-01', effectiveTo: null, notes: null }]));
    render(<StaffCostRatesPage />);
    await waitFor(() => expect(screen.getByTitle('Delete')).toBeTruthy());
    expect(screen.getAllByText('Thandi N').length).toBe(2); // the option and the table row
    expect(screen.getByText('Add cost rate')).toBeTruthy();
    expect(screen.getByTitle('Delete')).toBeTruthy();
    expect(screen.queryByText('Staff cost rates need Payroll access.')).toBeNull();
  });

  it('a 500 is the server\'s message, not the access state', async () => {
    route(() => envelope(500, 'INTERNAL', 'boom'));
    render(<StaffCostRatesPage />);
    expect(await screen.findByText(/boom/)).toBeTruthy();
    expect(screen.queryByText('Staff cost rates need Payroll access.')).toBeNull();
  });
});
