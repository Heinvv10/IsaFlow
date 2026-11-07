/**
 * Wave 4 PS, the screens: the run page's Payslip action opens the slip in a drawer (a blob:
 * iframe of the inline PDF, plus Download), "Payslips (PDF)" downloads every slip, the
 * "Payslips are ready" banner follows `payslipsFinal` (the R-035 guard on the server), and the
 * employee's payslips card lists each run with Final or Draft. `fetch` is stubbed, so the real
 * apiFetch/apiJson run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RUN_ID, RUN_URL, ok, fail } from './payroll/payrollRunFixtures';
import { fetchMock, rowOf, twoRuns } from './payroll/payRunGridHarness';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: RUN_ID }, push: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';
import { EmployeePayslipsCard } from '@/components/payroll/EmployeePayslipsCard';

const PDF = () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
const slipUrl = (employeeId: string, disposition: string) => `/api/payroll/runs/${RUN_ID}/payslips?disposition=${disposition}&employeeId=${employeeId}`;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'about:blank#payslip-1'), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serveRun(run: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === RUN_URL) return ok(run);
    if (url.startsWith(`/api/payroll/runs/${RUN_ID}/payslips?`)) return PDF();
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe('the run page', () => {
  const approved = (payslipsFinal: boolean) => twoRuns({ status: 'approved', journalEntryId: 'je-1', approval: null, payslipsFinal });

  it('a row\'s Payslip opens that employee\'s slip in a drawer, inline, with Download', async () => {
    serveRun(approved(true));
    render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    fireEvent.click(within(rowOf('Riaan Smit')).getByRole('button', { name: 'Payslip for Riaan Smit' }));
    const drawer = await screen.findByRole('dialog', { name: /^Payslip: Riaan Smit, [A-Z][a-z]{2} \d{4}$/ });
    await waitFor(() => expect(within(drawer).getByTitle('Payslip PDF').getAttribute('src')).toBe('about:blank#payslip-1'));
    expect(fetchMock.mock.calls.map(([u]) => u)).toContain(slipUrl('e-1', 'inline'));
    expect(within(drawer).getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(slipUrl('e-1', 'attachment'));
  });

  it('says the payslips are ready, with every slip as one download, only when the server says they are final', async () => {
    serveRun(approved(true));
    render(<PayrollRunDetailPage />);
    const banner = (await screen.findByText(/^Payslips are ready\./)).closest('div')!;
    expect(within(banner).getByRole('link', { name: 'Download all payslips (PDF)' }).getAttribute('href'))
      .toBe(`/api/payroll/runs/${RUN_ID}/payslips?disposition=attachment`);
    expect(screen.getByRole('link', { name: 'Payslips (PDF)' }).getAttribute('href')).toBe(`/api/payroll/runs/${RUN_ID}/payslips?disposition=attachment`);
  });

  it('an approved run the R-035 guard has not cleared shows no "ready" banner (the slips print DRAFT)', async () => {
    serveRun(approved(false));
    render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    expect(screen.queryByText(/Payslips are ready/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Payslips (PDF)' })).toBeTruthy();
  });
});

describe('EmployeePayslipsCard', () => {
  const URL_ = '/api/payroll/employees/e-1/payslips';

  it('lists each run, newest first, with Final or Draft and the stored net, and opens a slip', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === URL_) {
        return ok([
          { runId: 'r-2', periodMonth: 11, periodYear: 2026, final: false, netPay: 41681.55 },
          { runId: RUN_ID, periodMonth: 10, periodYear: 2026, final: true, netPay: 40000 },
        ]);
      }
      if (url.startsWith(`/api/payroll/runs/${RUN_ID}/payslips?`)) return PDF();
      throw new Error(`unexpected fetch ${url}`);
    });
    render(<EmployeePayslipsCard employeeId="e-1" employeeName="Riaan Smit" />);
    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => li.textContent?.replace(/\s/g, ' '))).toEqual([
      'November 2026DraftR 41 681.55 netView', 'October 2026FinalR 40 000.00 netView',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'View payslip for October 2026' }));
    expect(await screen.findByRole('dialog', { name: 'Payslip: Riaan Smit, October 2026' })).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.map(([u]) => u)).toContain(slipUrl('e-1', 'inline')));
  });

  it('says so when there are none, and when they cannot be read', async () => {
    fetchMock.mockImplementation(async () => ok([]));
    render(<EmployeePayslipsCard employeeId="e-1" employeeName="Riaan Smit" />);
    expect(await screen.findByText(/No payslips yet/)).toBeTruthy();
    cleanup();
    fetchMock.mockImplementation(async () => fail(403, 'Your role (viewer) does not allow viewing payroll detail.'));
    render(<EmployeePayslipsCard employeeId="e-1" employeeName="Riaan Smit" />);
    expect((await screen.findByRole('alert')).textContent).toContain('does not allow viewing payroll detail');
  });
});
