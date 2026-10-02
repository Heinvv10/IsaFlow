/**
 * D3 round 5: a viewer is not offered write-only actions on the payroll pages that stay visible to them
 * (they would only answer 403), and the viewer employee list has no Start column (its body carries no
 * dates). A manager gets every one. `fetch` is stubbed; every list answers an empty list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: {}, push: vi.fn(), pathname: '/' }) }));
const company = vi.hoisted(() => ({ role: 'viewer' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: company.role }) }));

import EmployeesPage from '@/../pages/payroll/employees/index';
import LoansPage from '@/../pages/payroll/loans/index';
import LeavePage from '@/../pages/payroll/leave/index';
import BatchesPage from '@/../pages/payroll/batches/index';
import PayPackagesPage from '@/../pages/payroll/pay-packages/index';
import PayScalesPage from '@/../pages/payroll/pay-scales/index';
import ComponentsPage from '@/../pages/payroll/components/index';
import CostCentresPage from '@/../pages/payroll/cost-centres/index';
import ParallelRunPage from '@/../pages/payroll/parallel-run/index';
import UifPage from '@/../pages/payroll/uif/index';
import TrainingPage from '@/../pages/payroll/training/index';
import LeaveBalancesPage from '@/../pages/payroll/leave/balances';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); fetchMock.mockImplementation(async () => ok([])); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); company.role = 'viewer'; });

const hrefs = () => Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
const button = (re: RegExp) => screen.queryAllByRole('button', { name: re }).length;

type Probe = [string, () => React.ReactElement, () => number];
const probes: Probe[] = [
  ['employees: New Employee', () => <EmployeesPage />, () => hrefs().filter((h) => h === '/payroll/employees/new').length],
  ['loans: New Loan', () => <LoansPage />, () => hrefs().filter((h) => h === '/payroll/loans/new').length],
  ['leave: New request', () => <LeavePage />, () => hrefs().filter((h) => h === '/payroll/leave/new').length],
  ['batches: New batch', () => <BatchesPage />, () => hrefs().filter((h) => h === '/payroll/batches/new').length],
  ['pay packages: Create package', () => <PayPackagesPage />, () => button(/create package/i)],
  ['pay scales: Create', () => <PayScalesPage />, () => button(/^create$/i)],
  ['components: Add component', () => <ComponentsPage />, () => button(/add component/i)],
  ['cost centres: Add', () => <CostCentresPage />, () => button(/^add$/i)],
  ['parallel run: upload card', () => <ParallelRunPage />, () => button(/choose csv/i)],
  ['UIF: Generate Declaration', () => <UifPage />, () => button(/generate declaration/i)],
  ['training: New event', () => <TrainingPage />, () => button(/new event/i)],
  ['leave balances: Run Monthly Accrual', () => <LeaveBalancesPage />, () => button(/run monthly accrual/i)],
];

describe('write-only actions', () => {
  it.each(probes)('%s: hidden from a viewer, shown to a manager', async (_n, element, count) => {
    render(element());
    await screen.findAllByRole('heading');
    const forViewer = count();
    cleanup();
    company.role = 'manager';
    render(element());
    await screen.findAllByRole('heading');
    expect(count(), 'manager sees it').toBeGreaterThan(0);
    expect(forViewer, 'viewer sees it').toBe(0);
  });

  it('employee list: a viewer has no Start column and no New Employee; a manager has both', async () => {
    const row = { id: 'e1', employeeNumber: 'E-1', firstName: 'Wanda', lastName: 'Test', employmentType: 'permanent' };
    fetchMock.mockImplementation(async () => ok([row]));
    render(<EmployeesPage />);
    expect(await screen.findByText(/Wanda/)).toBeTruthy();
    expect(screen.queryByText('Start')).toBeNull();
    expect(screen.queryByText('—')).toBeNull();
    cleanup();
    company.role = 'manager';
    fetchMock.mockImplementation(async () => ok([{ ...row, startDate: '2020-01-01T00:00:00Z' }]));
    render(<EmployeesPage />);
    expect(await screen.findByText('2020-01-01')).toBeTruthy();
    expect(screen.getByText('Start')).toBeTruthy();
  });
});
