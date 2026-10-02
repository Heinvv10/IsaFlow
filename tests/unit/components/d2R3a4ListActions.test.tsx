/**
 * D2 round 3 (a4): list pages whose row actions / loads treated any HTTP response as success or
 * parsed the body before the status. Real apiFetch helpers over a scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, PLAIN_BAD, empty500, envelope, ok } from '../helpers/d2R3a4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import RecurringInvoicesPage from '../../../pages/accounting/recurring-invoices/index';
import BatchPaymentsPage from '../../../pages/accounting/batch-payments/index';
import StaffRatesPage from '../../../pages/accounting/practice/staff-rates/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const TEMPLATE = { id: 'r1', templateName: 'D2 Retainer', clientId: 'c1', clientName: 'D2 Client', frequency: 'monthly',
  nextRunDate: '2099-01-01', runCount: 0, status: 'active', totalAmount: 100 };
const isRun = (u: string) => u.includes('recurring-invoices-run');
const isAction = (u: string) => u.includes('recurring-invoices-action');
const noJsonLeak = () => expect(screen.queryByText(PLAIN_BAD)).toBeNull();

function scriptInvoices(write: (u: string) => Response | null, listAfter?: () => Response, row = TEMPLATE) {
  let writes = 0;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST') { writes++; const r = write(u); if (r) return r; }
    if (writes > 0 && listAfter) return listAfter();
    return ok({ items: [row] });
  });
}

describe('recurring invoices list', () => {
  it('a refused pause shows the server message', async () => {
    scriptInvoices((u) => (isAction(u) ? envelope() : null));
    render(<RecurringInvoicesPage />);
    fireEvent.click(await screen.findByTitle('Pause'));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });

  it('a pause answered with an empty 500 shows a plain sentence', async () => {
    scriptInvoices((u) => (isAction(u) ? empty500() : null));
    render(<RecurringInvoicesPage />);
    fireEvent.click(await screen.findByTitle('Pause'));
    expect(await screen.findByText(/Could not update the recurring invoice - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a refused run shows the server message, not "Run failed"', async () => {
    scriptInvoices((u) => (isRun(u) ? envelope() : null));
    render(<RecurringInvoicesPage />);
    fireEvent.click(await screen.findByTitle('Run Now'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(/^Run failed$/)).toBeNull();
    expect(screen.queryByText(/invoices? generated/)).toBeNull();
  });

  it('a run answered with an empty 500 shows a plain sentence and no result', async () => {
    scriptInvoices((u) => (isRun(u) ? empty500() : null));
    render(<RecurringInvoicesPage />);
    fireEvent.click(await screen.findByTitle('Run Now'));
    expect(await screen.findByText(/Could not run the recurring invoice - try again/)).toBeTruthy();
    noJsonLeak();
    expect(screen.queryByText(/invoices? generated/)).toBeNull();
  });

  it('Run All Due: a refusal shows the server message', async () => {
    scriptInvoices((u) => (isRun(u) ? envelope() : null), undefined, { ...TEMPLATE, nextRunDate: '2000-01-01' });
    render(<RecurringInvoicesPage />);
    await screen.findByText('D2 Retainer');
    fireEvent.click(await screen.findByRole('button', { name: /run due/i }));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });

  it('a successful run shows the result, and a failing reload keeps it, shows the error, and clears the stale row', async () => {
    scriptInvoices((u) => (isRun(u) ? ok({ generated: 1, invoice_ids: ['i1'], errors: [] }) : null), empty500);
    render(<RecurringInvoicesPage />);
    fireEvent.click(await screen.findByTitle('Run Now'));
    expect(await screen.findByText(/1 invoice generated/)).toBeTruthy();
    expect(await screen.findByText(/Could not load recurring invoices - try again/)).toBeTruthy();
    expect(screen.queryByText('D2 Retainer')).toBeNull();
    expect(screen.queryByTitle('Run Now')).toBeNull();
  });

  it('a failed load shows the error and no rows', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => envelope());
    render(<RecurringInvoicesPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('D2 Retainer')).toBeNull();
  });
});

const BATCH = { id: 'b1', batchNumber: 'BP-D2-1', batchDate: '2026-01-01', paymentCount: 2, totalAmount: 50, paymentMethod: 'eft', status: 'draft' };

describe('batch payments list', () => {
  const script = (action: () => Response) => vi.mocked(apiFetch).mockImplementation(async (url, init) =>
    init?.method === 'POST' ? action() : ok({ items: [BATCH] }));

  it('a refused approve shows the server message and clears busy', async () => {
    script(() => envelope());
    render(<BatchPaymentsPage />);
    fireEvent.click(await screen.findByTitle('Approve'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    await waitFor(() => expect((screen.getByTitle('Approve') as HTMLButtonElement).disabled).toBe(false));
  });

  it('an approve answered with an empty 500 shows a plain sentence and clears busy', async () => {
    script(empty500);
    render(<BatchPaymentsPage />);
    fireEvent.click(await screen.findByTitle('Approve'));
    expect(await screen.findByText(/Could not update the batch - try again/)).toBeTruthy();
    noJsonLeak();
    await waitFor(() => expect((screen.getByTitle('Approve') as HTMLButtonElement).disabled).toBe(false));
  });

  it('a successful approve reloads the list', async () => {
    script(() => ok({}));
    render(<BatchPaymentsPage />);
    fireEvent.click(await screen.findByTitle('Approve'));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).endsWith('/batch-payments')).length).toBe(2));
    expect(screen.queryByText(/Could not update/)).toBeNull();
  });

  it('a failed load shows no rows', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => empty500());
    render(<BatchPaymentsPage />);
    expect(await screen.findByText(/Could not load batch payments - try again/)).toBeTruthy();
    noJsonLeak();
  });
});

const USER = { id: 'u1', displayName: 'D2 Staffer' };
const RATE = { id: 'r1', rate: 850, currency: 'ZAR', effectiveFrom: '2026-01-01', effectiveTo: null, createdAt: '2026-01-01' };

describe('practice staff rates', () => {
  const script = (users: () => Response, rates: () => Response, add?: () => Response) =>
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('practice/users')) return users();
      if (init?.method === 'POST') return (add ?? (() => ok({})))();
      return rates();
    });

  it('a refused user load shows the server message, not "Failed to load users"', async () => {
    script(() => envelope(), () => ok([]));
    render(<StaffRatesPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(/Failed to load users/)).toBeNull();
  });

  it('an empty-500 user load shows a plain sentence', async () => {
    script(empty500, () => ok([]));
    render(<StaffRatesPage />);
    expect(await screen.findByText(/Could not load the staff members - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a failed rates load shows the error, not "No rates set"', async () => {
    script(() => ok([USER]), () => envelope());
    render(<StaffRatesPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('No rates set for this staff member')).toBeNull();
  });

  it('an empty-500 rates load shows a plain sentence', async () => {
    script(() => ok([USER]), empty500);
    render(<StaffRatesPage />);
    expect(await screen.findByText(/Could not load the rates - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('rates render on success', async () => {
    script(() => ok([USER]), () => ok([RATE]));
    render(<StaffRatesPage />);
    expect(await screen.findByText(/ZAR 850[.,]00 \/hr/)).toBeTruthy();
  });

  it('a refused add shows the server message and keeps the typed rate', async () => {
    script(() => ok([USER]), () => ok([RATE]), () => envelope());
    render(<StaffRatesPage />);
    await screen.findByText(/ZAR 850[.,]00 \/hr/);
    const rate = screen.getByPlaceholderText('e.g. 850.00') as HTMLInputElement;
    fireEvent.change(rate, { target: { value: '900' } });
    fireEvent.submit(screen.getByRole('button', { name: /add rate/i }).closest('form')!);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(rate.value).toBe('900');
  });

  it('an add that succeeds and a reload that fails still reports the reload error and clears the stale rate', async () => {
    let added = false;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('practice/users')) return ok([USER]);
      if (init?.method === 'POST') { added = true; return ok({}); }
      return added ? empty500() : ok([RATE]);
    });
    render(<StaffRatesPage />);
    await screen.findByText(/ZAR 850[.,]00 \/hr/);
    fireEvent.change(screen.getByPlaceholderText('e.g. 850.00'), { target: { value: '900' } });
    fireEvent.submit(screen.getByRole('button', { name: /add rate/i }).closest('form')!);
    expect(await screen.findByText(/Could not load the rates - try again/)).toBeTruthy();
    expect(screen.queryByText(/ZAR 850[.,]00 \/hr/)).toBeNull();
    expect(screen.queryByText(/Could not add the rate/)).toBeNull();
  });
});
