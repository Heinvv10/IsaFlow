/**
 * D3 round 3: the employee page for a viewer. The API sends names only, so the
 * page shows the name and number, the no-access message, and none of the
 * personal/pay cards (an empty ID field with a Save button would invite a
 * PATCH of blanks). A write role still gets the profile with its ID number,
 * and (wave 4 PS) its payslips card; a viewer gets no card and no payslip fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const ID = '11111111-1111-4111-8111-111111111111';
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: ID }, push: vi.fn(), pathname: '/' }) }));
const company = vi.hoisted(() => ({ role: 'viewer' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: company.role }) }));

import EmployeePage from '@/../pages/payroll/employees/[id]';

const NO_ACCESS = "You don't have access to payroll detail.";
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const forbidden = () => new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'no' } }), { status: 403 });
const NAMES = { id: ID, companyId: 'c1', employeeNumber: 'E-1', firstName: 'Wanda', lastName: 'Test', employmentType: 'permanent' };
const FULL = { ...NAMES, idNumber: '8001015009087', taxNumber: '0123456789', uifExcluded: false, medicalAidMainMember: true, medicalAidDependantsCount: 0, startDate: '2020-01-01' };

const SLIPS = [{ runId: 'r1', periodMonth: 10, periodYear: 2026, final: true, netPay: 23456.78 }];
const payslipCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('/payslips'));

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); company.role = 'viewer'; });

function serve(employee: unknown, detailAllowed: boolean) {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (/\/api\/payroll\/employees\/[^/]+$/.test(u)) return ok(employee);
    if (u.includes('/api/payroll/components')) return ok([]);
    if (u.includes('/bank-details')) return detailAllowed ? ok(null) : forbidden();
    if (u.endsWith(`/api/payroll/employees/${ID}/payslips`)) return detailAllowed ? ok(SLIPS) : forbidden();
    return detailAllowed ? ok([]) : forbidden();
  });
}

describe('employee page', () => {
  it('viewer: name, number and the no-access message; no profile fields, no cards', async () => {
    serve(NAMES, false);
    render(<EmployeePage />);
    expect(await screen.findByText('Wanda Test')).toBeTruthy();
    expect(screen.getAllByText(NO_ACCESS)).toHaveLength(1);
    expect(screen.queryByDisplayValue('8001015009087')).toBeNull();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.queryByText(/pay components|assign component|history/i)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Payslips' })).toBeNull();
    expect(payslipCalls()).toHaveLength(0);
  });

  it('write role: the profile carries the ID and tax numbers and no no-access message', async () => {
    company.role = 'owner';
    serve(FULL, true);
    render(<EmployeePage />);
    expect(await screen.findByDisplayValue('8001015009087')).toBeTruthy();
    expect(screen.getByDisplayValue('0123456789')).toBeTruthy();
    expect(screen.queryByText(NO_ACCESS)).toBeNull();
  });

  it('write role: the payslips card lists the run with its net and a View button', async () => {
    company.role = 'owner';
    serve(FULL, true);
    render(<EmployeePage />);
    expect(await screen.findByRole('heading', { name: 'Payslips' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'View payslip for October 2026' })).toBeTruthy();
    expect(screen.getByText('Final')).toBeTruthy();
    expect(screen.getByText(/23[\s,]?456[.,]78 net/)).toBeTruthy();
  });
});
