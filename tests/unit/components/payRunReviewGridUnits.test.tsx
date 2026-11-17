/**
 * Overtime hours and travel km on the review grid (wave 6 RI). `fetch` is stubbed, so the real apiFetch/apiJson run.
 * The grid sends the quantity (and, for travel, the rate a km): the amount is the server's, so no amount is ever in the body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { inputsBody, ok, line, runBody } from './payroll/payrollRunFixtures';
import { body, cell, choose, fetchMock, puts, serve, type } from './payroll/payRunGridHarness';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const route = vi.hoisted(() => ({ id: '11111111-1111-4111-8111-111111111111' }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: route.id }, push: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';

const run = runBody({ lines: [line('1', 'Riaan Smit'), line('2', 'Thandi Nkosi')] });
const units = (rows: Array<Record<string, unknown>> = [], more: Record<string, unknown> = {}) => ({
  units: {
    overtimeComponentId: 'c-ot', travelComponentId: 'c-travel', rows, conflicts: [], kmToDate: [],
    rates: [{ employeeId: 'e-1', hourlyRate: 115.38 }, { employeeId: 'e-2', hourlyRate: null }], ...more,
  },
});

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('overtime hours', () => {
  it('sends hours at the picked multiplier and what the cell held, never an amount', async () => {
    const held = { employeeId: 'e-1', kind: 'overtime', multiplier: 1.5, quantity: 10, amount: 1730.7 };
    serve(() => ok(inputsBody(run, units([held]))), { run, inputs: units([held]) });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit', 'Overtime hours at 1.5x');
    expect(input.value).toBe('10');
    type(input, '12');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toEqual({ employeeId: 'e-1', units: { kind: 'overtime', multiplier: 1.5, quantity: 12, ratePerKm: null, expectedQuantity: 10 } });
  });

  it('the 2x picker binds the column to the 2x row; an employee with no hourly rate cannot enter overtime', async () => {
    serve(() => ok(inputsBody(run, units())), { run, inputs: units() });
    render(<PayrollRunDetailPage />);
    await cell('Riaan Smit', 'Overtime hours at 1.5x');
    choose(screen.getByRole('combobox', { name: 'Overtime rate' }), '2x: Sunday or public holiday (s16, s18)');
    const input = await cell('Riaan Smit', 'Overtime hours at 2x');
    type(input, '8');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toMatchObject({ units: { kind: 'overtime', multiplier: 2, quantity: 8, expectedQuantity: null } });
    expect((await cell('Thandi Nkosi', 'Overtime hours at 2x')).disabled).toBe(true);
  });
});

describe('travel km', () => {
  it('waits for the rate a km, then sends km and rate together', async () => {
    serve(() => ok(inputsBody(run, units())), { run, inputs: units() });
    render(<PayrollRunDetailPage />);
    const kms = await cell('Riaan Smit', 'Travel km');
    type(kms, '1000');
    fireEvent.blur(kms);
    expect(puts()).toHaveLength(0);
    const rate = screen.getByLabelText('Rate a km, Travel km, Riaan Smit') as HTMLInputElement;
    type(rate, '6');
    fireEvent.blur(rate);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toEqual({ employeeId: 'e-1', units: { kind: 'travel', multiplier: null, quantity: 1000, ratePerKm: 6, expectedQuantity: null } });
  });

  it('shows the km recorded this tax year under the cell, and nothing for an employee with none', async () => {
    const held = { employeeId: 'e-1', kind: 'travel', multiplier: null, quantity: 1000, amount: 6000 };
    const read = units([held], { kmToDate: [{ employeeId: 'e-1', km: 9000 }] });
    serve(() => ok(inputsBody(run, read)), { run, inputs: read });
    render(<PayrollRunDetailPage />);
    await cell('Riaan Smit', 'Travel km');
    expect(screen.getByText(/^9\s000 km this tax year$/)).toBeTruthy();
    expect(screen.getAllByText(/km this tax year/)).toHaveLength(1);
  });

  it('no travel or overtime component: no column', async () => {
    serve(() => ok(inputsBody(run)), { run, inputs: units([], { overtimeComponentId: null, travelComponentId: null }) });
    render(<PayrollRunDetailPage />);
    await cell('Riaan Smit');
    expect(screen.queryByRole('columnheader', { name: 'Travel km' })).toBeNull();
    expect(screen.queryByLabelText('Overtime rate')).toBeNull();
  });
});
