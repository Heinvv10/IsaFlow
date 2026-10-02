/**
 * D3 round 2: every payroll page that reads a per-employee route says
 * "You don't have access to payroll detail." when the server answers 403 (the
 * real error envelope through the real apiFetch), never a generic load failure.
 * A 500 on the same page shows the server's own message (D2), so the 403 branch
 * is not the page's only message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const ID = '11111111-1111-4111-8111-111111111111';
// One router object for every render: a fresh one each time is not what Next gives a page.
const router = vi.hoisted(() => ({ isReady: true, query: { id: '11111111-1111-4111-8111-111111111111' }, push: () => undefined, replace: () => undefined, pathname: '/' }));
vi.mock('next/router', () => ({ useRouter: vi.fn(() => router) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'viewer' }) }));

import VariancePage from '@/../pages/payroll/runs/[id]/variance';
import CashRegisterPage from '@/../pages/payroll/runs/[id]/cash-register';
import LoansPage from '@/../pages/payroll/loans/index';
import LoanDetailPage from '@/../pages/payroll/loans/[id]';
import Irp5Page from '@/../pages/payroll/irp5/index';
import BatchDetailPage from '@/../pages/payroll/batches/[id]';
import EmployeePage from '@/../pages/payroll/employees/[id]';
import DuplicatesPage from '@/../pages/payroll/duplicates';
import Eea2Page from '@/../pages/payroll/equity/eea2';
import LeaveBalancesPage from '@/../pages/payroll/leave/balances';
import LeaveRequestPage from '@/../pages/payroll/leave/[id]';
import LeaveIndexPage from '@/../pages/payroll/leave/index';
import TaxDirectivesPage from '@/../pages/payroll/tax-directives/index';
import TrainingPage from '@/../pages/payroll/training/index';
import WspAtrPage from '@/../pages/payroll/training/wsp-atr';
import { EmployeeTerminationCard } from '@/components/payroll/EmployeeTerminationCard';

const NO_ACCESS = "You don't have access to payroll detail.";
const envelope = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code, message } }), { status });
const forbidden = () => envelope(403, 'FORBIDDEN', 'Your role (viewer) does not allow viewing payroll detail.');

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const pages: Array<[string, () => React.ReactElement, RegExp]> = [
  ['run variance', () => <VariancePage />, /boom/],
  ['cash register', () => <CashRegisterPage />, /boom/],
  ['loans list', () => <LoansPage />, /boom/],
  ['loan detail', () => <LoanDetailPage />, /boom/],
  ['IRP5 summary', () => <Irp5Page />, /boom/],
  ['batch detail', () => <BatchDetailPage />, /boom/],
  ['employee components', () => <EmployeePage />, /boom/],
  ['duplicates', () => <DuplicatesPage />, /boom/],
  ['EEA2 report', () => <Eea2Page />, /boom/],
  ['leave balances', () => <LeaveBalancesPage />, /boom/],
  ['leave request', () => <LeaveRequestPage />, /boom/],
  ['leave list', () => <LeaveIndexPage />, /boom/],
  ['tax directives', () => <TaxDirectivesPage />, /boom/],
  ['training events', () => <TrainingPage />, /boom/],
  ['WSP/ATR report', () => <WspAtrPage />, /boom/],
  ['termination preview', () => <EmployeeTerminationCard employeeId={ID} />, /boom/],
];

describe('payroll detail pages — 403 says so', () => {
  it.each(pages)('%s shows the no-access message', async (_name, element) => {
    fetchMock.mockImplementation(async (url: string) => {
      // The employee page's own record loads (it is not payroll detail); only the detail read is refused.
      if (/\/api\/payroll\/employees\/[^/]+$/.test(String(url))) {
        return new Response(JSON.stringify({ success: true, data: { id: ID, firstName: 'Wanda', lastName: 'Test', employmentType: 'permanent' } }), { status: 200 });
      }
      if (String(url).includes('/api/payroll/components')) return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
      return forbidden();
    });
    render(element());
    expect(await screen.findByText(NO_ACCESS)).toBeTruthy();
  });

  it.each(pages)('%s shows the server message on a 500', async (_name, element, generic) => {
    fetchMock.mockImplementation(async () => envelope(500, 'INTERNAL_ERROR', 'boom'));
    render(element());
    await waitFor(() => expect(screen.queryByText(NO_ACCESS)).toBeNull());
    expect(await screen.findAllByText(generic)).toBeTruthy();
  });
});

describe('bulk update — the preview (a POST read) says so on 403', () => {
  it('shows the no-access message', async () => {
    const BulkPage = (await import('@/../pages/payroll/employees/bulk-update')).default;
    fetchMock.mockImplementation(async () => forbidden());
    render(<BulkPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^preview/i }));
    expect(await screen.findByText(NO_ACCESS)).toBeTruthy();
  });
});

describe('leave request page — the router object is not a reason to fetch again', () => {
  it('a router whose identity changes every render still fetches the request once and keeps its 403 message', async () => {
    const LeaveRequest = (await import('@/../pages/payroll/leave/[id]')).default;
    const leaveCalls: string[] = [];
    fetchMock.mockImplementation(async (url: string) => { leaveCalls.push(String(url)); return forbidden(); });
    const unstable = vi.mocked((await import('next/router')).useRouter);
    unstable.mockImplementation(() => ({ isReady: true, query: { id: ID }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) as never);
    try {
      render(<LeaveRequest />);
      expect(await screen.findByText(NO_ACCESS)).toBeTruthy();
      await new Promise((r) => setTimeout(r, 150));
      expect(screen.getByText(NO_ACCESS)).toBeTruthy();
      expect(leaveCalls.filter((u) => u.endsWith(`/api/payroll/leave/${ID}`))).toHaveLength(1);
    } finally {
      unstable.mockImplementation(() => router as never);
    }
  });
});

