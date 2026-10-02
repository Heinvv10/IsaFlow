/**
 * D3: the run detail page tells a viewer plainly that payroll detail is not
 * theirs (the route answers 403), and says "Pay run not found" for an id that
 * is no run (404). Neither reads "Failed to load run". `fetch` is stubbed, so
 * the real apiFetch/apiJson parse the real error envelope.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { RUN_ID, RUN_URL, runBody, ok } from './payroll/payrollRunFixtures';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: RUN_ID }, push: vi.fn() }) }));
const company = vi.hoisted(() => ({ role: 'viewer' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: company.role }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';

const envelope = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code, message } }), { status });

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('payroll run page — refusals on load', () => {
  it('403 shows the no-access message, not "Failed to load run"', async () => {
    fetchMock.mockImplementation(async () => envelope(403, 'FORBIDDEN', 'Your role (viewer) does not allow viewing payroll detail.'));
    render(<PayrollRunDetailPage />);
    expect(await screen.findByText("You don't have access to payroll detail.")).toBeTruthy();
    expect(screen.queryByText('Failed to load run')).toBeNull();
  });

  it('404 shows "Pay run not found"', async () => {
    fetchMock.mockImplementation(async () => envelope(404, 'NOT_FOUND', 'PayrollRun not found'));
    render(<PayrollRunDetailPage />);
    expect(await screen.findByText('Pay run not found')).toBeTruthy();
    expect(screen.queryByText('Failed to load run')).toBeNull();
  });

  it('a 500 still says "Failed to load run"', async () => {
    fetchMock.mockImplementation(async () => envelope(500, 'INTERNAL_ERROR', 'boom'));
    render(<PayrollRunDetailPage />);
    expect(await screen.findByText('Failed to load run')).toBeTruthy();
  });

  it('a write role served the run sees its figures', async () => {
    company.role = 'admin';
    fetchMock.mockImplementation(async (url: string) => { if (url === RUN_URL) return ok(runBody()); throw new Error(`unexpected ${url}`); });
    render(<PayrollRunDetailPage />);
    expect(await screen.findByText('Riaan Smit')).toBeTruthy();
    company.role = 'viewer';
  });
});
