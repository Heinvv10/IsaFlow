/**
 * D2 round 7 (k1): VAT201 mark-submitted keeps the blocking counts, the tasks page says when a list does not load and
 * keeps the success message when only the reload fails, the AR template download is no dead button.
 * REAL assertOk / apiErrorMessage over a scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { tab: 'all' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'c1' }, companyRole: 'owner', loading: false }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/components/accounting/sars/VAT201SummaryForm', () => ({ VAT201SummaryForm: () => <div>summary</div> }));
vi.mock('@/components/accounting/sars/VAT201ExceptionsPanel', () => ({ VAT201ExceptionsPanel: () => <div>exceptions</div> }));
vi.mock('@/components/accounting/sars/VAT201SarsSubmit', () => ({ VAT201SarsSubmit: () => <div>sars</div> }));

import VAT201Page from '../../../pages/accounting/sars/vat201';
import TasksPage from '../../../pages/accounting/practice/tasks/index';
import ArInvoicesPage from '../../../pages/accounting/migration/ar-invoices';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('VAT201 mark-submitted', () => {
  const REPORT = { periodStart: '2026-01-01', periodEnd: '2026-02-28', field1_standardRatedSupplies: 0, field2_zeroRatedSupplies: 0,
    field3_exemptSupplies: 0, field4_totalImports: 0, field5_outputVAT: 0, field6_capitalGoods: 0, field7_otherGoods: 0, field8_services: 0,
    field9_imports: 0, field10_totalInputVAT: 0, field11_vatPayableOrRefundable: 0, sarsFields: [], warnings: [], filability: { filable: true, reason: null }, outputInvoices: [], inputInvoices: [] };
  const COUNTS = { totalExceptions: 2, unpostedInvoiceVatCount: 2 };
  const blocked = () => new Response(JSON.stringify({ success: false, error: { code: 'VAT_GATE', message: MSG, details: { counts: COUNTS } } }), { status: 400 });
  const open = async (submit: () => Response) => {
    route((u, m) => {
      if (u.includes('sars-submissions')) return submit();
      if (u.includes('sars-vat201')) return m === 'POST' ? ok({ id: 's1' }) : ok(REPORT);
      return ok({});
    });
    render(<VAT201Page />);
    fireEvent.click(await screen.findByRole('button', { name: /generate/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save draft/i }));
    fireEvent.click(await screen.findByRole('button', { name: /mark as submitted/i }));
    fireEvent.change(await screen.findByPlaceholderText('SARS reference number'), { target: { value: 'REF-1' } });
  };
  const confirm = () => fireEvent.click(screen.getByRole('button', { name: /^confirm$|override and confirm/i }));

  it('a 400 gate refusal shows the server message AND the blocking counts, with the modal kept open', async () => {
    await open(blocked);
    confirm();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(await screen.findByText(/2 blocking VAT exceptions/)).toBeTruthy();
    expect(screen.getByPlaceholderText('SARS reference number')).toBeTruthy();
    expect(screen.queryByText(/marked as submitted/i)).toBeNull();
  });
  it('an empty-body 500 shows a plain sentence and keeps the modal', async () => {
    await open(empty500);
    confirm();
    expect(await screen.findByText('Could not mark the VAT201 as submitted - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
    expect(screen.getByPlaceholderText('SARS reference number')).toBeTruthy();
  });
  it('a 200 reports success and closes the modal', async () => {
    await open(() => ok({}));
    confirm();
    expect(await screen.findByText('VAT201 marked as submitted to SARS')).toBeTruthy();
    await waitFor(() => expect(screen.queryByPlaceholderText('SARS reference number')).toBeNull());
  });
});

describe('practice tasks', () => {
  const TASK = { id: 't1', title: 'D2 task', status: 'pending', priority: 'normal', dueDate: null, assignedTo: null, jobId: null };
  const serve = (over: (u: string, m: string) => Response | null) => route((u, m) => {
    const o = over(u, m); if (o) return o;
    if (u.includes('transition')) return ok({});
    if (u.endsWith('/tasks')) return ok({ tasks: [TASK] });
    if (u.includes('/jobs')) return ok({ jobs: [] });
    return ok([]);
  });

  it('a failed reload after a good status change keeps "Status updated", clears the stale rows and shows the reload error', async () => {
    let taskGets = 0;
    serve((u, m) => (u.endsWith('/tasks') && m === 'GET' ? (++taskGets === 1 ? null : empty500()) : null));
    render(<TasksPage />);
    fireEvent.click((await screen.findByText('Pending')).closest('button')!);
    fireEvent.click(await screen.findByText(/→ Done/));
    expect(await screen.findByText('Could not load the tasks - try again')).toBeTruthy();
    expect(screen.getByText('Status updated')).toBeTruthy();
    expect(screen.queryByText('D2 task')).toBeNull();
    expect(spinnerGone()).toBe(true);
    expect(noRawText()).toBe(true);
  });
  it('a refused jobs list is said out loud instead of leaving a silent empty dropdown', async () => {
    serve((u) => (u.includes('/jobs') ? bad(403) : null));
    render(<TasksPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('a failing users list only costs the names: rows still render', async () => {
    serve((u) => (u.includes('/users') ? empty500() : null));
    render(<TasksPage />);
    expect(await screen.findByText('D2 task')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  const spinnerGone = () => document.querySelector('.animate-spin') === null;
});

describe('AR invoices template download', () => {
  beforeEach(() => { vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })); });
  const click = () => fireEvent.click(screen.getByRole('button', { name: /download csv template/i }));

  it('a 400 shows the server message', async () => {
    route(() => bad(400)); render(<ArInvoicesPage />); click();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-body 500 shows a plain sentence, not a dead button', async () => {
    route(() => empty500()); render(<ArInvoicesPage />); click();
    expect(await screen.findByText('Could not download the template - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a 200 downloads the file and shows no error', async () => {
    route(() => new Response('a,b', { status: 200 })); render(<ArInvoicesPage />); click();
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(screen.queryByText(/Could not download/)).toBeNull();
  });
});
