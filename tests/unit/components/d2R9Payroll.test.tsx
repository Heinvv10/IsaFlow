// D2 round 9 (pages/payroll, portal, contact, audit-portal): a failed bulk update is reported (it used to be an
// unhandled rejection), a loan-components setup failure uses the inline banner, a 4xx on the pay run keeps the
// server message, a failed import list clears the stale comparison, the payment button stays busy during the
// redirect, and the two public pages say what could not be done.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ ...router, isReady: true, replace: vi.fn(), pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => { const v = { activeCompany: { id: 'co1' }, loading: false, companyRole: 'owner' }; return { useCompany: () => v }; });
vi.mock('@/components/payroll/parallelRun/ParallelRunUploadCard', () => ({ ParallelRunUploadCard: () => null }));
vi.mock('@/components/payroll/parallelRun/ParallelRunReportView', () => ({ ParallelRunReportView: () => <p>REPORT SHOWN</p> }));

import { apiFetch } from '@/lib/apiFetch';
import BulkUpdatePage from '../../../pages/payroll/employees/bulk-update';
import LoansPage from '../../../pages/payroll/loans/index';
import RunPage from '../../../pages/payroll/runs/[id]';
import ParallelRunPage from '../../../pages/payroll/parallel-run/index';
import NewLeavePage from '../../../pages/payroll/leave/new';
import PayPage from '../../../pages/portal/pay/[token]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.query = {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('bulk employee update', () => {
  const PREVIEW = { matchCount: 2, sample: [] };
  const open = async (preview: () => Response, apply: () => Response = () => ok({ updated: 2 })) => {
    serve(on('GET', 'cost-centres', () => ok([])), on('POST', 'bulk/preview', preview), on('POST', 'bulk/apply', apply));
    render(<BulkUpdatePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
  };
  it('preview: an empty 500 gives a plain sentence', async () => {
    await open(empty500);
    expect(await screen.findByText('Could not preview the update - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('Preview failed'); expectNoJargon();
  });
  it('preview: a 400 shows the server message', async () => {
    await open(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('preview: a 403 shows the no-access message', async () => {
    await open(() => refuse('x', 403));
    expect(await screen.findByText("You don't have access to payroll detail.")).toBeDefined();
  });
  it('preview: a dropped connection is reported and the button is free again', async () => {
    await open(() => { throw new Error('socket hang up'); });
    expect(await screen.findByText('Could not preview the update - try again')).toBeDefined();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(false));
  });
  const applyAfterPreview = async (apply: () => Response) => {
    await open(() => ok(PREVIEW), apply);
    fireEvent.click(await screen.findByRole('button', { name: /Apply to 2 employees/ }));
  };
  it('apply: an empty 500 gives a plain sentence', async () => {
    await applyAfterPreview(empty500);
    expect(await screen.findByText('Could not apply the update - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('Apply failed');
  });
  it('apply: a 400 shows the server message', async () => {
    await applyAfterPreview(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('apply: a dropped connection is reported, not an unhandled rejection', async () => {
    await applyAfterPreview(() => { throw new Error('socket hang up'); });
    expect(await screen.findByText('Could not apply the update - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('socket hang up');
  });
  it('apply: a 200 shows the count', async () => {
    await applyAfterPreview(() => ok({ updated: 2 }));
    await waitFor(() => expect(document.body.textContent).toMatch(/2/));
    expect(screen.queryByText(/Could not apply/)).toBeNull();
  });
});

describe('loans setup components', () => {
  it('a refused setup shows the inline banner and keeps the loan list', async () => {
    const LOAN = { id: 'l1', employeeId: 'e1', loanNumber: 'LN-D2-1', description: 'D2 loan', principal: 1000, outstandingBalance: 500, annualInterestRate: 5, termMonths: 12, method: 'straight_line', status: 'active', startDate: '2026-01-01' };
    serve(
      on('POST', 'setup-components', () => refuse()),
      on('GET', '/api/payroll/components', () => ok([])),
      on('GET', '/api/payroll/loans', () => ok([LOAN])),
    );
    render(<LoansPage />);
    fireEvent.click(await screen.findByRole('button', { name: /create loan components/i }));
    expect(await screen.findByText(MSG)).toBeDefined();
    // the loans table is still there: the failure is not the full-page error
    expect(document.querySelector('table')).not.toBeNull();
    expect(document.querySelector('.text-red-400')).toBeNull();
  });
});

describe('pay run load', () => {
  beforeEach(() => { router.query = { id: '11111111-1111-4111-8111-111111111111' }; });
  it('a 400 keeps the server message', async () => {
    serve(on('GET', '/api/payroll/runs/', () => refuse()));
    render(<RunPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
  });
  it('a 500 says the run could not be loaded', async () => {
    serve(on('GET', '/api/payroll/runs/', () => refuse('boom', 500)));
    render(<RunPage />);
    expect(await screen.findByText('Could not load the payroll run - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('boom');
  });
});

describe('parallel run', () => {
  const IMP = (id: string, m: number) => ({ id, source: 'sage', fileName: `${id}.csv`, periodMonth: m, periodYear: 2026, payslipCount: 3, createdAt: '2026-01-01T00:00:00Z' });
  it('a failed import-list reload clears the selection and the comparison', async () => {
    vi.stubGlobal('confirm', () => true);
    let lists = 0;
    serve(
      (url, m) => (m === 'GET' && url.includes('/parallel-run/imports') ? (++lists === 1 ? ok({ imports: [IMP('a', 1), IMP('b', 2)] }) : empty500()) : undefined),
      on('GET', '/parallel-run/compare', () => ok({ import: IMP('a', 1), run: null, comparison: { rows: [] } })),
      on('DELETE', '/parallel-run/imports/b', () => ok({})),
    );
    render(<ParallelRunPage />);
    fireEvent.click(await screen.findByText('Jan 2026'));
    expect(await screen.findByText('REPORT SHOWN')).toBeDefined();
    fireEvent.click(screen.getAllByTitle('Delete import')[1]!);
    expect(await screen.findByText('Could not load the imports - try again')).toBeDefined();
    expect(screen.queryByText('REPORT SHOWN')).toBeNull();
  });
});

describe('portal payment', () => {
  const LINK = { invoiceId: 'i1', clientId: 'c1', amount: 100, status: 'sent', expiresAt: null, companyName: 'D2 Co', invoiceNumber: 'INV-1' };
  const open = (create: () => Response) => {
    router.query = { token: 'tok' };
    serve(
      (url, m) => (m === 'POST' && url.includes('paystack/create') ? create() : undefined),
      (url) => (url.includes('payment-link') ? ok(LINK) : undefined),
    );
    render(<PayPage />);
  };
  it('stays busy while the browser redirects to the checkout (no second payment request)', async () => {
    const loc = { href: '' }; vi.stubGlobal('location', loc);
    open(() => ok({ checkoutUrl: 'https://checkout.test/x' }));
    fireEvent.click(await screen.findByRole('button', { name: /pay with paystack/i }));
    await waitFor(() => expect(loc.href).toBe('https://checkout.test/x'));
    await new Promise(r => setTimeout(r, 50));
    expect((screen.getByRole('button', { name: /redirecting/i }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('a refused payment start (empty 500) says what could not be done', async () => {
    open(empty500);
    fireEvent.click(await screen.findByRole('button', { name: /pay with paystack/i }));
    expect(await screen.findByText('Could not start the payment - try again')).toBeDefined();
  });
  it('an empty 500 on the link says what could not be loaded, not "not found or expired"', async () => {
    router.query = { token: 'tok' };
    serve(() => empty500());
    render(<PayPage />);
    expect(await screen.findByText('Could not load the payment details - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('not found or expired');
  });
});

describe('new leave request', () => {
  const submit = async (post: () => Response) => {
    serve(
      on('POST', '/api/payroll/leave', post),
      on('GET', '/api/payroll/employees', () => ok([{ id: 'e1', firstName: 'D2', lastName: 'Emp', employeeNumber: 'E1' }])),
      on('GET', '/api/payroll/leave/types', () => ok([{ id: 't1', name: 'Annual', isPaid: true }])),
    );
    const { container } = render(<NewLeavePage />);
    await screen.findByText(/D2 Emp/);
    const [emp, type] = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[];
    fireEvent.change(emp!, { target: { value: 'e1' } });
    fireEvent.change(type!, { target: { value: 't1' } });
    const [from, to] = Array.from(container.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    fireEvent.change(from!, { target: { value: '2026-03-02' } });
    fireEvent.change(to!, { target: { value: '2026-03-03' } });
    fireEvent.submit(container.querySelector('form')!);
  };
  it('empty 500 and a dropped connection give the same plain sentence', async () => {
    await submit(empty500);
    expect(await screen.findByText('Could not save the leave request - try again')).toBeDefined();
    cleanup();
    await submit(() => { throw new Error('socket hang up'); });
    expect(await screen.findByText('Could not save the leave request - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('Could not save - try again');
  });
});
