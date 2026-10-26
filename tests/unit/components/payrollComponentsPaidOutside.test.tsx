// PAYE 4c: the pay components page offers "Paid outside payroll" only for a deduction coded 4001/4003/4006
// (the route and the payroll_components CHECK refuse it elsewhere), sends it, and labels such a component.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => { const v = { activeCompany: { id: 'co1' }, loading: false, companyRole: 'owner' }; return { useCompany: () => v }; });

import { apiFetch } from '@/lib/apiFetch';
import ComponentsPage from '../../../pages/payroll/components/index';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const PRIVATE_RA = {
  id: 'c1', name: 'Private RA', sarsSourceCode: '4006', componentType: 'deduction',
  isTaxable: false, isUifApplicable: false, isSdlApplicable: false, paidOutsidePayroll: true,
};
const box = () => screen.queryByRole('checkbox', { name: /paid outside payroll/i });

describe('pay components: paid outside payroll', () => {
  it('appears only for a 4001/4003/4006 deduction, and is sent with the new component', async () => {
    serve(on('GET', '/api/payroll/components', () => ok([])), on('POST', '/api/payroll/components', () => ok(PRIVATE_RA)));
    render(<ComponentsPage />);
    fireEvent.change(await screen.findByPlaceholderText('e.g. Basic Salary'), { target: { value: 'Private RA' } });
    expect(box()).toBeNull(); // an earning, 3601
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'deduction' } });
    expect(box()).toBeNull(); // a deduction, still 3601
    fireEvent.change(screen.getByDisplayValue('3601'), { target: { value: '4005' } });
    expect(box()).toBeNull(); // medical aid: out of scope
    fireEvent.change(screen.getByDisplayValue('4005'), { target: { value: '4006' } });
    fireEvent.click(box()!);
    fireEvent.click(screen.getByRole('button', { name: /add component/i }));
    await waitFor(() => {
      const post = vi.mocked(apiFetch).mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST');
      expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ sarsSourceCode: '4006', componentType: 'deduction', paidOutsidePayroll: true });
    });
  });

  it('labels a component paid outside payroll in the list', async () => {
    serve(on('GET', '/api/payroll/components', () => ok([PRIVATE_RA])));
    render(<ComponentsPage />);
    expect(await screen.findByText('paid outside payroll')).toBeDefined();
  });
});
