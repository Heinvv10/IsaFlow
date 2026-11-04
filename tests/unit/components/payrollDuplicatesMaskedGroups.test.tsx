// Wave 3 K1: bank-account duplicate groups go to owners and admins only (managers get none). In a Login-as or token
// session they arrive masked to the last four, so two different accounts can show the same value. They are still
// two groups: `value` alone cannot be the React key. The server is the gate; the page shows what it is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const company = vi.hoisted(() => ({ companyRole: 'admin' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));

import DuplicatesPage from '../../../pages/payroll/duplicates';

useApiJsonOverMock();
beforeEach(() => { company.companyRole = 'admin'; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const person = (id: string) => ({ id, employeeNumber: id, name: `Person ${id}`, status: 'active' });
const RESULT = {
  idNumber: [], taxNumber: [], passportNumber: [], employeeNumber: [],
  bankAccount: [
    { value: '…9333', employees: [person('e1'), person('e2')] },
    { value: '…9333', employees: [person('e3'), person('e4')] },
  ],
  totals: { totalConflicts: 2, affectedEmployees: 4 },
};

describe('payroll duplicates, masked bank accounts', () => {
  it('shows two groups sharing a masked value, with no duplicate React key', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    serve(on('GET', '/api/payroll/duplicates', () => ok(RESULT)));
    render(<DuplicatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Bank Account/ }));
    expect(screen.getAllByText('…9333')).toHaveLength(2);
    expect(screen.getByText(/Person e4/)).toBeDefined();
    const keyErrors = consoleError.mock.calls.filter((c) => String(c[0]).includes('same key'));
    expect(keyErrors).toEqual([]);
  });

  const NOTE = 'Bank-account duplicates are visible to owners and admins.';
  const MANAGER_RESULT = {
    ...RESULT,
    idNumber: [{ value: '8001015009087', employees: [person('e1'), person('e2')] }],
    bankAccount: [],
    totals: { totalConflicts: 1, affectedEmployees: 2 },
  };

  it('a manager (sent no bank groups) gets no Bank Account tab and a fixed note', async () => {
    company.companyRole = 'manager';
    serve(on('GET', '/api/payroll/duplicates', () => ok(MANAGER_RESULT)));
    render(<DuplicatesPage />);
    expect(await screen.findByText('1 conflict group(s)')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Bank Account/ })).toBeNull();
    expect(screen.getByText(NOTE)).toBeDefined();
  });

  it('shows the note to a manager on a clean result too', async () => {
    company.companyRole = 'manager';
    const clean = { ...MANAGER_RESULT, idNumber: [], totals: { totalConflicts: 0, affectedEmployees: 0 } };
    serve(on('GET', '/api/payroll/duplicates', () => ok(clean)));
    render(<DuplicatesPage />);
    expect(await screen.findByText('No duplicates found')).toBeDefined();
    expect(screen.getByText(NOTE)).toBeDefined();
    expect(screen.getByText('No duplicates in the fields you can see.')).toBeDefined();
    expect(screen.queryByText('Employee master data is clean.')).toBeNull();
  });

  it('tells an admin with a clean result that the master data is clean', async () => {
    const clean = { ...MANAGER_RESULT, idNumber: [], totals: { totalConflicts: 0, affectedEmployees: 0 } };
    serve(on('GET', '/api/payroll/duplicates', () => ok(clean)));
    render(<DuplicatesPage />);
    expect(await screen.findByText('Employee master data is clean.')).toBeDefined();
    expect(screen.queryByText('No duplicates in the fields you can see.')).toBeNull();
  });

  it('shows the Bank Account tab for groups the server sent while the role is still loading', async () => {
    company.companyRole = null;
    serve(on('GET', '/api/payroll/duplicates', () => ok(RESULT)));
    render(<DuplicatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Bank Account/ }));
    expect(screen.getAllByText('…9333')).toHaveLength(2);
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('an admin keeps an empty Bank Account tab and gets no note', async () => {
    serve(on('GET', '/api/payroll/duplicates', () => ok(MANAGER_RESULT)));
    render(<DuplicatesPage />);
    expect(await screen.findByRole('button', { name: /Bank Account/ })).toBeDefined();
    expect(screen.queryByText(NOTE)).toBeNull();
  });
});
