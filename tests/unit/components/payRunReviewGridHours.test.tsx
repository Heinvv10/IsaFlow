/**
 * Hours and days on the review grid (master plan wave 5, HD). `fetch` is stubbed, so the real apiFetch/apiJson run.
 * The grid sends the quantity only: the amount is the server's (quantity x rate), so no amount is ever in the body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { inputsBody, ok, line, runBody } from './payroll/payrollRunFixtures';
import { body, cell, fetchMock, puts, serve, settle, type } from './payroll/payRunGridHarness';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const route = vi.hoisted(() => ({ id: '11111111-1111-4111-8111-111111111111' }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: route.id }, push: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';

const BASIC = 'c-basic';
const lines = [line('1', 'Riaan Smit'), line('2', 'Thandi Nkosi')];
const run = runBody({ lines });
const withHours = (amounts: Array<Record<string, unknown>> = []) => ({
  hours: { componentId: BASIC, employees: [{ employeeId: 'e-1', unit: 'hour', rate: 85.5, componentId: BASIC, duplicate: false }] },
  amounts,
});
const stored = (quantity: number, amount: number) => ({ employeeId: 'e-1', componentId: BASIC, amount, quantity, conflict: false });

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('hours cell', () => {
  it('shows an Hours cell for the hourly employee only; the monthly one has none', async () => {
    serve(() => ok(inputsBody(run)), { run, inputs: withHours() });
    render(<PayrollRunDetailPage />);
    expect(await cell('Riaan Smit', 'Hours')).toBeTruthy();
    expect(screen.queryByLabelText('Hours, Thandi Nkosi')).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Hours' })).toBeTruthy();
  });

  it('sends the quantity and what the cell held, never an amount', async () => {
    serve(() => ok(inputsBody(run, withHours([stored(160, 13680)]))), { run, inputs: withHours([stored(150, 12825)]) });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit', 'Hours');
    expect(input.value).toBe('150');
    type(input, '160');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toEqual({ employeeId: 'e-1', quantity: 160, expectedQuantity: 150 });
    expect(JSON.stringify(body(0))).not.toContain('amount');
  });

  it('reads 7,5 as 7.5 and refuses text it cannot read, sending nothing', async () => {
    serve(() => ok(inputsBody(run, withHours())), { run, inputs: withHours() });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit', 'Hours');
    type(input, '7,5');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toMatchObject({ quantity: 7.5, expectedQuantity: null });
    type(input, '1,234.5');
    fireEvent.blur(input);
    await settle();
    expect(puts()).toHaveLength(1);
    expect(await screen.findByText(/as a number, like 7\.5/)).toBeTruthy();
    type(input, '745');
    fireEvent.blur(input);
    expect(await screen.findByText(/at most 744 hours/)).toBeTruthy();
    expect(puts()).toHaveLength(1);
  });

  it('0 is an entered nil, sent as 0; emptying the cell clears the row, sent as null', async () => {
    serve(() => ok(inputsBody(run, withHours([stored(160, 13680)]))), { run, inputs: withHours([stored(160, 13680)]) });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit', 'Hours');
    type(input, '0');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toEqual({ employeeId: 'e-1', quantity: 0, expectedQuantity: 160 });
    type(input, '');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(body(1)).toMatchObject({ quantity: null });
  });

  it('a plain basic-pay amount from before hours existed is offered for replacement, sending that amount as the check', async () => {
    const plain = { employeeId: 'e-1', componentId: BASIC, amount: 500, quantity: null, conflict: false };
    serve(() => ok(inputsBody(run, withHours([plain]))), { run, inputs: withHours([plain]) });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit', 'Hours');
    expect(input.value).toBe('');
    expect(screen.getByText(/Replaces .*500\.00 entered as an amount/)).toBeTruthy();
    type(input, '160');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toEqual({ employeeId: 'e-1', quantity: 160, expectedQuantity: null, expectedAmount: 500 });
  });

  it('shows what the server priced it at', async () => {
    serve(() => ok(inputsBody(run)), { run, inputs: withHours([stored(160, 13680)]) });
    render(<PayrollRunDetailPage />);
    await cell('Riaan Smit', 'Hours');
    expect(screen.getByText(/13[\s ]680\.00 at .*85\.50 per hour/)).toBeTruthy();
  });

  it('with no rate, links to the employee instead of offering a cell', async () => {
    const inputs = { hours: { componentId: BASIC, employees: [{ employeeId: 'e-1', unit: 'hour', rate: null, componentId: BASIC, duplicate: false }] }, amounts: [] };
    serve(() => ok(inputsBody(run)), { run, inputs });
    render(<PayrollRunDetailPage />);
    expect(await screen.findByRole('link', { name: /Set the hourly rate first/ })).toBeTruthy();
    expect(screen.queryByLabelText('Hours, Riaan Smit')).toBeNull();
  });

  it('a monthly-only company has no Hours column at all', async () => {
    serve(() => ok(inputsBody(run)), { run });
    render(<PayrollRunDetailPage />);
    await cell('Riaan Smit');
    expect(screen.queryByRole('columnheader', { name: /^Hours|^Days/ })).toBeNull();
  });
});

