/**
 * W2 PR I review fixes: scanned dates never reach DateField unvalidated, a legacy due-before-invoice draft shows the
 * problem on the Due field, Save & New honours a refused date, and the scan fetches the client list only when it needs it.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';
import { clickWhenEnabled, pickOption } from '../helpers/kitPick';

const push = vi.fn();
type Scan = { date: string | null; dueDate: string | null; customerName: string | null };
const scan = vi.hoisted(() => ({ current: { date: null, dueDate: null, customerName: null } as Scan }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <button onClick={() => onExtracted({ ...scan.current, vatRate: null, lineItems: [], confidence: 0.9 })}>scan stub</button>
  ),
}));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import { InvoiceHeaderFields } from '@/components/accounting/customer-invoices/InvoiceHeaderFields';
import type { InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); scan.current = { date: null, dueDate: null, customerName: null }; });

const LEGACY = { id: 'inv-1', invoice_number: 'INV-1', status: 'draft', client_id: 'c-1', invoice_date: '2026-09-15', due_date: '2026-09-01',
  billing_period_start: '2026-09-01', billing_period_end: '2026-09-30', tax_rate: 15, notes: '', currency_code: 'ZAR', exchange_rate: 1,
  items: [{ description: 'L', quantity: 1, unit_price: 10, amount: 10 }] };

function serve(opts: { customersFail?: boolean; listGate?: Promise<void> } = {}) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('customer-invoices-create') && init?.method === 'POST') return ok({ id: 'n1' });
    if (u.includes('customer-invoices-detail') && init?.method === 'PUT') return ok({});
    if (u.includes('customer-invoices-detail')) return ok(LEGACY);
    if (u.includes('/customers')) {
      if (opts.customersFail && u === '/api/accounting/customers') return new Response('{}', { status: 500 });
      if (u === '/api/accounting/customers') { await opts.listGate; return ok([{ id: 'c-1', name: 'Acme' }]); }
      return ok([{ id: 'c-1', name: 'Acme' }, { id: 'c-2', name: 'Beta' }]);
    }
    return ok([]);
  });
}
const calls = (method: string) => vi.mocked(apiFetch).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method).length;
const field = (label: string) => screen.getByLabelText(label === 'Invoice date' ? /^Invoice date/ : label);
const clientListCalls = () => vi.mocked(apiFetch).mock.calls.filter((c) => String(c[0]) === '/api/accounting/customers').length;
const alerts = () => screen.queryAllByRole('alert').map((a) => a.textContent).join('|');
const sentBody = (method: string): unknown => {
  const call = vi.mocked(apiFetch).mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === method);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};
async function completeAndSubmit() {
  await pickOption('Client', 'Acme');
  fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Work' } });
  fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '50' } });
  await clickWhenEnabled(/^create invoice$/i);
}
const scanNow = () => fireEvent.click(screen.getByRole('button', { name: 'scan stub' }));

describe('a scan cannot crash the form with a date DateField would refuse as a bound', () => {
  it.each([['2026-02-30'], ['1 Oct 2026'], ['2026-10-01T00:00:00Z']])('invoice date "%s" leaves the field empty and the form usable', async (bad) => {
    serve();
    scan.current = { date: bad, dueDate: '2026-10-31', customerName: null };
    render(<NewPage />);
    scanNow();
    await waitFor(() => expect((field('Due date') as HTMLInputElement).value).toBe('31 Oct 2026'));
    expect((field('Invoice date') as HTMLInputElement).value).toBe('');
    await completeAndSubmit();
    expect(await screen.findByText('Enter the invoice date')).toBeTruthy();
    expect(calls('POST')).toBe(0);
  });

  it.each([['2026-02-30'], ['1 Oct 2026']])('due date "%s" is dropped; a good invoice date is kept', async (bad) => {
    serve();
    scan.current = { date: '2026-08-01', dueDate: bad, customerName: null };
    render(<NewPage />);
    scanNow();
    await waitFor(() => expect((field('Invoice date') as HTMLInputElement).value).toBe('01 Aug 2026'));
    expect((field('Due date') as HTMLInputElement).value).toBe('');
    await completeAndSubmit();
    await waitFor(() => expect(calls('POST')).toBe(1));
    expect(sentBody('POST')).toMatchObject({ invoiceDate: '2026-08-01', dueDate: '' });
  });

  it('InvoiceHeaderFields given a non-ISO invoice date renders instead of throwing', () => {
    serve();
    const form: InvoiceHeaderForm = { clientId: '', invoiceDate: '1 Oct 2026', dueDate: '', billingPeriodStart: '', billingPeriodEnd: '', taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' };
    const opts = { projects: [], accounts: [], costCentres: [], businessUnits: [] } as never;
    expect(() => render(<InvoiceHeaderFields form={form} onChange={vi.fn()} currencies={[]} options={opts} onProjectChange={vi.fn()} onDateValidity={vi.fn()} refused={{}} />)).not.toThrow();
  });
});

describe('a legacy draft whose due date is before its invoice date', () => {
  it('marks the Due field and blocks save with the reason on screen', async () => {
    serve();
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    expect(field('Due date').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('The due date is before the invoice date')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await screen.findByText('The due date must be on or after the invoice date');
    expect(calls('PUT')).toBe(0);
  });

  it('clears the mark once the due date is fixed', async () => {
    serve();
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    typeDate(field('Due date'), '30 Sep 2026');
    await waitFor(() => expect(field('Due date').getAttribute('aria-invalid')).toBe('false'));
    expect(screen.queryByText('The due date is before the invoice date')).toBeNull();
  });
});

describe('Save & New', () => {
  it('with a refused date blocks and posts nothing', async () => {
    serve();
    render(<NewPage />);
    await pickOption('Client', 'Acme');
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '50' } });
    typeDate(field('Due date'), 'zz');
    await clickWhenEnabled(/save & new/i);
    expect(await screen.findByText('Fix the dates marked in red before saving')).toBeTruthy();
    expect(calls('POST')).toBe(0);
  });
});

describe('the client list for scan matching', () => {
  it('is not fetched on load (the picker fetches for itself), and not banner-reported', async () => {
    serve({ customersFail: true });
    render(<NewPage />);
    await screen.findByRole('combobox', { name: 'Client' });
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThan(0));
    expect(clientListCalls()).toBe(0);
    expect(alerts()).not.toContain('Could not load clients');
  });

  it('is fetched on a scan that names a customer, and the match is picked', async () => {
    serve();
    scan.current = { date: '2026-08-01', dueDate: null, customerName: 'Acme' };
    render(<NewPage />);
    scanNow();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Client' }).textContent).toContain('Acme'));
    expect(clientListCalls()).toBe(1);
  });

  it('a failed lookup during a scan is said on screen and the dates still fill', async () => {
    serve({ customersFail: true });
    scan.current = { date: '2026-08-01', dueDate: null, customerName: 'Acme' };
    render(<NewPage />);
    scanNow();
    await waitFor(() => expect(alerts()).toContain('Could not load clients'));
    expect((field('Invoice date') as HTMLInputElement).value).toBe('01 Aug 2026');
  });
});

describe('a slow scan lookup cannot overwrite what the user did meanwhile', () => {
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((r) => { release = r; });
    return { promise, release };
  }
  const clientBox = () => screen.getByRole('combobox', { name: 'Client' }).textContent ?? '';

  it('a client picked while the lookup is in flight stays picked', async () => {
    const g = gate();
    serve({ listGate: g.promise });
    scan.current = { date: '2026-08-01', dueDate: null, customerName: 'Acme' };
    render(<NewPage />);
    scanNow();
    await pickOption('Client', 'Beta');
    g.release();
    await waitFor(() => expect(clientListCalls()).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(clientBox()).toContain('Beta');
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '50' } });
    await clickWhenEnabled(/^create invoice$/i);
    await waitFor(() => expect(calls('POST')).toBe(1));
    expect(sentBody('POST')).toMatchObject({ clientId: 'c-2' });
  });

  it('a lookup that lands after Save & New does not refill the cleared form', async () => {
    const g = gate();
    serve({ listGate: g.promise });
    scan.current = { date: '2026-08-01', dueDate: null, customerName: 'Acme' };
    render(<NewPage />);
    await pickOption('Client', 'Beta');
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '50' } });
    scanNow(); // the lookup starts after the last pick, so only the reset can invalidate it
    await clickWhenEnabled(/save & new/i);
    await waitFor(() => expect(calls('POST')).toBe(1));
    await waitFor(() => expect(clientBox()).toContain('Select client'));
    g.release();
    await waitFor(() => expect(clientListCalls()).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(clientBox()).toContain('Select client');
  });

  it('a newer scan wins over an older lookup', async () => {
    const g = gate();
    serve({ listGate: g.promise });
    scan.current = { date: '2026-08-01', dueDate: null, customerName: 'Acme' };
    render(<NewPage />);
    scanNow();
    scan.current = { date: '2026-08-02', dueDate: null, customerName: null };
    scanNow();
    g.release();
    await waitFor(() => expect(clientListCalls()).toBe(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(clientBox()).toContain('Select client');
  });
});

describe('the Due field says why when its own text is refused, even while due-before-invoice holds', () => {
  it('shows the refusal reason, not the due-before-invoice message', async () => {
    serve();
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    expect(screen.getByText('The due date is before the invoice date')).toBeTruthy();
    typeDate(field('Due date'), '15 Aug 2026'); // refused: before the 15 Sep invoice date
    await waitFor(() => expect(screen.queryByText('The due date is before the invoice date')).toBeNull());
    expect(screen.getAllByText(/on or after 15 Sep 2026/).length).toBeGreaterThan(0);
    expect(field('Due date').getAttribute('aria-invalid')).toBe('true');
  });
});
