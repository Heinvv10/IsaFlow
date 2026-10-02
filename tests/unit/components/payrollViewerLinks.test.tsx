/**
 * D3 round 2: a viewer keeps the run totals but is not offered links that lead
 * only to per-employee detail (run detail, batch detail) or to creating a run.
 * Write roles still get them. `fetch` is stubbed with the real envelope.
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

import RunsPage from '@/../pages/payroll/runs/index';
import BatchesPage from '@/../pages/payroll/batches/index';
import { PayrollPeriodBar } from '@/components/payroll/PayrollPeriodBar';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const RUN = { id: 'run-1', periodMonth: 9, periodYear: 2026, status: 'approved', totalGross: 75000, totalPaye: 19966, totalNet: 41681, employeeCount: 1, journalEntryId: null };
const BATCH = { id: 'b-1', batchType: 'component_values', description: 'Sept bonuses', periodMonth: 9, periodYear: 2026, status: 'draft', lineCount: 2, totalAmount: 5000, isRecurring: false, createdAt: '2026-09-01' };
const CTX = { periodMonth: 9, periodYear: 2026, status: 'approved', runId: 'run-1' };

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('period-context')) return ok(CTX);
    if (u.includes('/api/payroll/batches')) return ok([BATCH]);
    return ok([RUN]);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); company.role = 'viewer'; });

const hrefs = () => Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));

describe('viewer sees totals, not links to per-employee detail', () => {
  it('runs list: totals shown, no View link, no New Payroll Run', async () => {
    render(<RunsPage />);
    expect(await screen.findByText(/Sep 2026/)).toBeTruthy();
    expect(hrefs()).not.toContain('/payroll/runs/run-1');
    expect(hrefs()).not.toContain('/payroll/runs/new');
  });
  it('runs list: a manager gets both', async () => {
    company.role = 'manager';
    render(<RunsPage />);
    await screen.findByText(/Sep 2026/);
    expect(hrefs()).toContain('/payroll/runs/run-1');
    expect(hrefs()).toContain('/payroll/runs/new');
  });
  it('batches list: a viewer gets no Open link, a manager does', async () => {
    render(<BatchesPage />);
    await screen.findByText('Sept bonuses');
    expect(hrefs()).not.toContain('/payroll/batches/b-1');
    cleanup();
    company.role = 'manager';
    render(<BatchesPage />);
    await screen.findByText('Sept bonuses');
    expect(hrefs()).toContain('/payroll/batches/b-1');
  });
  it('period bar: the run link is for write roles only', async () => {
    render(<PayrollPeriodBar />);
    expect(await screen.findByText(/Sep 2026/)).toBeTruthy();
    expect(hrefs()).not.toContain('/payroll/runs/run-1');
    cleanup();
    company.role = 'admin';
    render(<PayrollPeriodBar />);
    await screen.findByText(/Sep 2026/);
    expect(hrefs()).toContain('/payroll/runs/run-1');
  });
});
