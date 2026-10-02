/**
 * D3 round 5: a viewer is not offered write-only actions on the payroll pages that stay visible to them
 * (they would only answer 403), and the viewer employee list has no Start column (its body carries no
 * dates). A manager gets every one. `fetch` is stubbed; every list answers an empty list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const router = vi.hoisted(() => ({ isReady: true, query: { id: '11111111-1111-4111-8111-111111111111' }, push: () => undefined, replace: () => undefined, pathname: '/' }));
vi.mock('next/router', () => ({ useRouter: () => router }));
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
import LeaveRequestPage from '@/../pages/payroll/leave/[id]';
import PayPackagePage from '@/../pages/payroll/pay-packages/[id]';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fetchMock = vi.fn();
const PACKAGE = { id: 'p1', code: 'EXEC', name: 'Executive', description: null, isActive: true, components: [{ id: 'pc1', componentId: 'c1', componentName: 'Basic', sarsSourceCode: '3601', componentType: 'earning', amount: 100, isRecurring: true }] };
const comp = (id: string, name: string) => ({ id, name, sarsSourceCode: '3601', componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true, isActive: true });
const LEAVE = { id: '11111111-1111-4111-8111-111111111111', employeeName: 'Wanda Test', employeeNumber: 'E-1', leaveTypeName: 'Annual', startDate: '2026-11-02', endDate: '2026-11-03', days: 2, reason: null, status: 'pending', approvedAt: null, createdAt: '2026-10-01T00:00:00Z' };
/** Every list answers one row carrying a unique marker text, so each page has a real "my data arrived" signal. */
const ANSWERS: Array<[RegExp, unknown]> = [
  [/\/employees$/, [{ id: 'e1', employeeNumber: 'E-1', firstName: 'Marker', lastName: 'employee', employmentType: 'permanent', startDate: '2020-01-01T00:00:00Z' }]],
  [/\/pay-packages\/[^/]+$/, PACKAGE],
  [/\/pay-packages$/, [{ id: 'pk1', code: 'MK', name: 'Marker package', description: null, isActive: true }]],
  [/\/leave\/balances$/, [{ employeeId: 'e1', employeeName: 'Marker balance', leaveTypeId: 't1', leaveTypeName: 'Annual', accrued: 10, taken: 1, pending: 0, balance: 9 }]],
  [/\/leave\/[^/]+$/, LEAVE],
  [/\/leave$/, [{ ...LEAVE, employeeName: 'Marker leave' }]],
  [/\/loans$/, [{ id: 'l1', employeeId: 'e1', loanNumber: 'L-1', description: 'Marker loan', principal: 1000, outstandingBalance: 900, annualInterestRate: 0, termMonths: 10, method: 'interest_free', status: 'active', startDate: '2026-01-01' }]],
  [/\/batches$/, [{ id: 'b1', batchType: 'component_values', description: 'Marker batch', periodYear: 2026, periodMonth: 9, status: 'draft', lineCount: 1, totalAmount: 10, isRecurring: false, createdAt: '2026-09-01' }]],
  [/\/pay-scales$/, [{ id: 's1', code: 'G1', name: 'Marker scale', gradeLevel: 1, minSalary: 1, midSalary: 2, maxSalary: 3, currency: 'ZAR', isActive: true, notes: null }]],
  [/\/components$/, [comp('c1', 'Basic'), comp('c2', 'Marker component')]],
  [/\/cost-centres$/, [{ id: 'cc1', code: 'MKCC', name: 'Marker centre', parentId: null, isActive: true, notes: null }]],
  [/\/parallel-run\/imports$/, { imports: [{ id: 'i1', periodMonth: 9, periodYear: 2026, source: 'Marker source', fileName: null, payslipCount: 1, createdAt: '2026-09-01' }] }],
  [/\/uif$/, [{ id: 'u1', periodYear: 2026, periodMonth: 9, totalEmployees: 7777, totalLeviableSalary: 1, totalEmployeeContribution: 1, totalEmployerContribution: 1, totalUif: 2, status: 'draft', submittedAt: null }]],
  [/\/training-events$/, [{ id: 'ev1', employeeId: 'e1', category: 'Safety', description: 'Marker training', provider: null, nqfLevel: null, plannedStart: null, plannedEnd: null, actualStart: null, actualEnd: null, costPlanned: 1, costActual: 1, status: 'planned' }]],
];
let inFlight = 0;
beforeEach(() => {
  fetchMock.mockReset();
  inFlight = 0;
  fetchMock.mockImplementation(async (url: string) => {
    inFlight += 1;
    try {
      await (String(url).includes('/slow') ? new Promise((r) => setTimeout(r, 150)) : Promise.resolve());
      const path = String(url).split('?')[0]!;
      const hit = ANSWERS.find(([re]) => re.test(path));
      return ok(hit ? hit[1] : []);
    } finally { inFlight -= 1; }
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); company.role = 'viewer'; });

const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
/**
 * Run after the page's own marker is on screen, before claiming a control is absent. It covers: no fetch in
 * flight, no new fetch started, and every timer shorter than the 350 ms window fired (two consecutive passes
 * see the same call count). It does NOT cover a leak driven by an arbitrary later timer: no page has one, and
 * the cases that matter (WriteOnly unwrapped, data-driven leaks) are covered. Bounded: a page that keeps
 * fetching (polling) fails the probe instead of looping, and stops there, so it cannot leak into later probes.
 */
async function quiet(): Promise<void> {
  let seen = -1;
  for (let pass = 0; pass < 10; pass += 1) {
    if (seen === fetchMock.mock.calls.length && inFlight === 0) return;
    seen = fetchMock.mock.calls.length;
    await sleep(350);
  }
  throw new Error('page never goes quiet (polling?)');
}

const hrefs = () => Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
const button = (re: RegExp) => screen.queryAllByRole('button', { name: re }).length;

type Probe = [string, () => React.ReactElement, () => number, string | RegExp];
const probes: Probe[] = [
  ['employees: New Employee', () => <EmployeesPage />, () => hrefs().filter((h) => h === '/payroll/employees/new').length, 'Marker employee'],
  ['loans: New Loan', () => <LoansPage />, () => hrefs().filter((h) => h === '/payroll/loans/new').length, 'Marker loan'],
  ['leave: New request', () => <LeavePage />, () => hrefs().filter((h) => h === '/payroll/leave/new').length, /Marker leave/],
  ['batches: New batch', () => <BatchesPage />, () => hrefs().filter((h) => h === '/payroll/batches/new').length, 'Marker batch'],
  ['pay packages: Create package', () => <PayPackagesPage />, () => button(/create package/i), 'Marker package'],
  ['pay scales: Create', () => <PayScalesPage />, () => button(/^create$/i), 'Marker scale'],
  ['components: Add component', () => <ComponentsPage />, () => button(/add component/i), 'Marker component'],
  ['cost centres: Add', () => <CostCentresPage />, () => button(/^add$/i), 'Marker centre'],
  ['parallel run: upload card', () => <ParallelRunPage />, () => button(/choose csv/i), 'Marker source'],
  ['UIF: Generate Declaration', () => <UifPage />, () => button(/generate declaration/i), '7777'],
  ['training: New event', () => <TrainingPage />, () => button(/new event/i), 'Marker training'],
  ['pay package: Add component', () => <PayPackagePage />, () => button(/add component/i), 'Executive'],
  ['pay package: per-row Remove', () => <PayPackagePage />, () => button(/^remove basic$/i), 'Executive'],
  ['leave request: Approve', () => <LeaveRequestPage />, () => button(/^approve$/i), 'Wanda Test (E-1)'],
  ['leave request: Reject', () => <LeaveRequestPage />, () => button(/^reject$/i), 'Wanda Test (E-1)'],
  ['leave request: Delete', () => <LeaveRequestPage />, () => button(/^delete$/i), 'Wanda Test (E-1)'],
  ['pay package: Save components', () => <PayPackagePage />, () => button(/save components/i), 'Executive'],
  ['leave balances: Run Monthly Accrual', () => <LeaveBalancesPage />, () => button(/run monthly accrual/i), 'Marker balance'],
];

describe('write-only actions', () => {
  it.each(probes)('%s: hidden from a viewer, shown to a manager', async (_n, element, count, marker) => {
    // Manager first: proves the page renders the control once its data is on screen, so the viewer's 0 means "hidden".
    company.role = 'manager';
    render(element());
    await screen.findByText(marker);
    await waitFor(() => expect(count(), 'manager sees it').toBeGreaterThan(0));
    cleanup();
    company.role = 'viewer';
    render(element());
    await screen.findByText(marker);
    await quiet();
    expect(count(), 'viewer sees it').toBe(0);
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

describe('pay package inputs', () => {
  it('are display-only for a viewer and editable for a manager', async () => {
    const editable = () => Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('select, input[type="number"], input[type="checkbox"]')).filter((e) => !e.disabled).length;
    company.role = 'manager';
    render(<PayPackagePage />);
    await screen.findByText('Executive');
    await waitFor(() => expect(editable()).toBeGreaterThan(0));
    cleanup();
    company.role = 'viewer';
    render(<PayPackagePage />);
    await screen.findByText('Executive');
    await quiet();
    expect(editable()).toBe(0);
  });
});

describe('quiet() is bounded', () => {
  it('a page that polls every 100 ms fails with a clear message, and the next probe is unaffected', async () => {
    const Poller = () => { React.useEffect(() => { const t = setInterval(() => { void fetch('/api/payroll/poll'); }, 100); return () => clearInterval(t); }, []); return <h1>Poller</h1>; };
    render(<Poller />);
    await screen.findByText('Poller');
    await expect(quiet()).rejects.toThrow('page never goes quiet (polling?)');
    cleanup(); // the interval is cleared on unmount: nothing keeps fetching into the next probe
    fetchMock.mockClear();
    await sleep(250);
    expect(fetchMock).not.toHaveBeenCalled();
    company.role = 'manager';
    render(<EmployeesPage />);
    expect(await screen.findByText('Marker employee')).toBeTruthy();
    await quiet();
  });
});
