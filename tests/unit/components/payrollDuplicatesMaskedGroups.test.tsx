// Wave 3 K1: a manager's bank-account duplicates arrive masked to the last four, so two different accounts can show
// the same value. They are still two groups: `value` alone cannot be the React key.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import DuplicatesPage from '../../../pages/payroll/duplicates';

useApiJsonOverMock();
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
});
