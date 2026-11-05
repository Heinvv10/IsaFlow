/**
 * PR S final review, the new page:
 * - after another tab's clear, a create resets that state: no leave question, and the page is inert once created, so
 *   Cancel on any leave question cannot lead to a second invoice;
 * - after "Leave without them?" is confirmed, nothing is written as the page goes;
 * - a change autosave is holding (the VAT rate being typed) is still kept on the device as the page goes;
 * - /new opened again while the approval is out: its answer is ignored, no email form over the new form;
 * - Create waits for a scan's lookup, says so, gives up after 15 s, and not for a lookup the user overrode;
 * - leaving a form typed back to blank does not ask.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { AuthContext } from '@/contexts/AuthContext';
import { CompanyContext } from '@/contexts/CompanyContext';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, calls, description, ok, pick, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ router: null as null | Record<string, unknown>, scanCustomer: null as string | null }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => h.router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <button type="button" onClick={() => onExtracted({ date: null, dueDate: null, vatRate: null, customerName: h.scanCustomer, confidence: 0.9, lineItems: [] })}>scan stub</button>
  ),
}));

import NewPage from '../../../pages/accounting/customer-invoices/new';

const KEY = 'isaflow:invoice-draft:co-1:u-1';
useApiJsonOverMock();
let confirm: ReturnType<typeof vi.fn>;
const original = window.confirm;
beforeEach(() => {
  vi.useFakeTimers();
  const events = routerEvents();
  const navigate = vi.fn(async () => { events.emit('routeChangeStart', '/elsewhere'); return true; });
  h.router = { query: {}, pathname: '/x', asPath: '/x', isReady: true, events, push: navigate, replace: navigate, beforePopState: () => undefined };
  h.scanCustomer = null;
  confirm = vi.fn(() => false);
  window.confirm = confirm as unknown as typeof window.confirm;
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); window.confirm = original; vi.mocked(apiFetch).mockReset(); localStorage.clear(); });

const settle = async () => { for (let i = 0; i < 6; i++) await advance(0); };
const button = (name: RegExp) => screen.getByRole('button', { name });
const events = () => h.router!.events as ReturnType<typeof routerEvents>;
const price = () => screen.getAllByLabelText(/^Unit price/)[0] as HTMLInputElement;
async function open() {
  render(
    <AuthContext.Provider value={{ user: { id: 'u-1' } } as never}>
      <CompanyContext.Provider value={{ activeCompany: { id: 'co-1' } } as never}><NewPage /></CompanyContext.Provider>
    </AuthContext.Provider>,
  );
  await advance(0);
}
async function fill() { await pick('Client', /Client/); type(description(), 'Work'); type(price(), '100'); }
const unloadAsks = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };

describe('after another tab\'s clear', () => {
  it('a create asks nothing on the way out, and Cancel on a leave question cannot make a second invoice', async () => {
    serveInvoice();
    await open();
    localStorage.setItem('isaflow:invoice-drafts-generation', String(Number(localStorage.getItem('isaflow:invoice-drafts-generation') ?? '0') + 1));
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'isaflow:invoice-drafts-generation' })); });
    await fill();
    await advance(1_000);
    fireEvent.click(button(/^create invoice$/i));
    await settle();
    expect(confirm).not.toHaveBeenCalled();
    expect(button(/^create invoice$/i)).toBeDisabled();
    fireEvent.click(button(/^create invoice$/i));
    await settle();
    expect(calls('customer-invoices-create')).toHaveLength(1);
  });

  it('a create stays inert even when a leave question is answered Cancel', async () => {
    serveInvoice();
    await open();
    await fill();
    confirm.mockReturnValue(false);
    (h.router as { push: unknown }).push = vi.fn(async () => { events().emit('routeChangeStart', '/x'); return true; });
    fireEvent.click(button(/^create invoice$/i));
    await settle();
    expect(button(/^create invoice$/i)).toBeDisabled();
    expect(calls('customer-invoices-create')).toHaveLength(1);
  });
});

describe('leaving', () => {
  it('after "Leave without them?" is confirmed, nothing is written as the page goes', async () => {
    serveInvoice();
    await open();
    type(description(), 'Thrown away');
    confirm.mockReturnValue(true);
    await act(async () => { await (h.router as { push: (u: string) => Promise<boolean> }).push('/elsewhere'); });
    expect(confirm).toHaveBeenCalledTimes(1);
    cleanup();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('a change autosave is holding (the VAT rate being typed) is kept on the device as the page goes', async () => {
    serveInvoice();
    await open();
    type(description(), 'Kept while typing the rate');
    fireEvent.focus(screen.getByLabelText('VAT rate %'));
    type(screen.getByLabelText('VAT rate %'), '1');
    await advance(2_000);
    expect(localStorage.getItem(KEY)).toBeNull(); // held while the rate is typed
    cleanup();
    expect(JSON.parse(localStorage.getItem(KEY)!).data.lines[0]).toMatchObject({ description: 'Kept while typing the rate' });
  });

  it('a form typed back to blank does not ask', async () => {
    serveInvoice();
    await open();
    type(description(), 'x');
    await advance(1_000);
    type(description(), '');
    expect(unloadAsks()).toBe(false);
  });
});

describe('/new opened again while the approval is out', () => {
  it('ignores the old approval\'s answer: no email form over the new form', async () => {
    let approve: (r: Response) => void = () => undefined;
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST' ? new Promise<Response>((r) => { approve = r; }) : undefined));
    await open();
    await fill();
    fireEvent.click(button(/approve & email/i));
    await settle();
    events().emit('routeChangeComplete', '/accounting/customer-invoices/new');
    await settle();
    approve(ok({ id: 'inv-1', status: 'approved' }));
    await settle();
    expect(screen.queryByRole('heading', { name: 'Email Invoice' })).toBeNull();
    expect(description()).not.toBeDisabled();
    expect(description().value).toBe('');
  });
});

describe('a scan\'s customer lookup', () => {
  const hang = () => serveInvoice((u) => (u.endsWith('/api/accounting/customers') ? new Promise<Response>(() => undefined) : undefined));
  it('holds Create with a reason on screen, and lets go after 15 s', async () => {
    hang();
    h.scanCustomer = 'Client';
    await open();
    await fill();
    fireEvent.click(screen.getByText('scan stub'));
    await settle();
    expect(button(/^create invoice$/i)).toBeDisabled();
    expect(screen.getByText(/Finding the scanned customer/)).toBeTruthy();
    await advance(15_000);
    await settle();
    expect(button(/^create invoice$/i)).not.toBeDisabled();
  });

  it('does not hold Create once the user picked a customer themselves', async () => {
    hang();
    h.scanCustomer = 'Client';
    await open();
    type(description(), 'Work');
    type(price(), '100');
    fireEvent.click(screen.getByText('scan stub'));
    await settle();
    expect(button(/^create invoice$/i)).toBeDisabled();
    await pick('Client', /Client/);
    await settle();
    expect(button(/^create invoice$/i)).not.toBeDisabled();
  });
});
