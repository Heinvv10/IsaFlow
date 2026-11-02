/**
 * PR S final-final review:
 * - "Leave without them" holds only for the change it was about: the next edit, or another invoice opened in place,
 *   is kept again as the page goes (edit: PUT; new: device draft).
 * - /new → /new after "Leave without them" starts a blank form.
 * - Another invoice opened in place on the edit page closes the first one's email form.
 * - A refused approval on /new whose move to the edit page fails says which invoice was created.
 * - A save that never answers stops being waited for after the wait.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { AuthContext } from '@/contexts/AuthContext';
import { CompanyContext } from '@/contexts/CompanyContext';
import { invoiceSavesSettled, trackInvoiceSave } from '@/lib/pendingInvoiceSaves';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, description, DRAFT, ok, pick, puts, refused, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ router: null as null | Record<string, unknown> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => h.router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import NewPage from '../../../pages/accounting/customer-invoices/new';

const KEY = 'isaflow:invoice-draft:co-1:u-1';
useApiJsonOverMock();
let confirm: ReturnType<typeof vi.fn>;
const original = window.confirm;
beforeEach(() => {
  vi.useFakeTimers();
  const events = routerEvents();
  // A navigation the guard lets through does not finish here: the page stays, as when a later step refuses it.
  const navigate = vi.fn(async () => { events.emit('routeChangeStart', '/elsewhere'); return true; });
  h.router = { query: { invoiceId: 'inv-1' }, pathname: '/x', asPath: '/x', isReady: true, events, push: navigate, replace: navigate, beforePopState: () => undefined };
  confirm = vi.fn(() => true);
  window.confirm = confirm as unknown as typeof window.confirm;
  localStorage.clear(); sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); window.confirm = original; vi.mocked(apiFetch).mockReset(); localStorage.clear(); sessionStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const router = () => h.router as { push: (u: string) => Promise<boolean>; events: ReturnType<typeof routerEvents> };
const leave = () => act(async () => { await router().push('/elsewhere'); });
const owned = (page: React.ReactNode) => (
  <AuthContext.Provider value={{ user: { id: 'u-1' } } as never}>
    <CompanyContext.Provider value={{ activeCompany: { id: 'co-1' } } as never}>{page}</CompanyContext.Provider>
  </AuthContext.Provider>
);

describe('"Leave without them" holds for that change only', () => {
  it('edit: the next edit is sent again as the page goes', async () => {
    serveInvoice();
    render(<EditPage />);
    await settle();
    type(description(), 'Thrown away');
    await leave();
    type(description(), 'Typed after staying');
    cleanup();
    await settle();
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!).items[0]!.description).toBe('Typed after staying');
  });

  it('edit: another invoice opened in place is sent again as the page goes', async () => {
    serveInvoice((u) => (u.includes('id=inv-2') ? ok({ ...DRAFT, id: 'inv-2' }) : undefined));
    const { rerender } = render(<EditPage />);
    await settle();
    type(description(), 'Thrown away');
    await leave();
    h.router = { ...h.router, query: { invoiceId: 'inv-2' } };
    rerender(<EditPage />);
    await settle();
    type(description(), 'B typed');
    cleanup();
    await settle();
    expect(puts().map((c) => bodyOf(c).id)).toEqual(['inv-2']);
  });

  it('new: the next edit is kept again as the page goes', async () => {
    serveInvoice();
    render(owned(<NewPage />));
    await advance(0);
    type(description(), 'Thrown away');
    await leave();
    type(description(), 'Typed after staying');
    cleanup();
    expect(JSON.parse(localStorage.getItem(KEY)!).data.lines[0]).toMatchObject({ description: 'Typed after staying' });
  });

  it('new → new after "Leave without them": a blank form', async () => {
    serveInvoice();
    render(owned(<NewPage />));
    await advance(0);
    type(description(), 'Thrown away');
    await leave();
    act(() => { router().events.emit('routeChangeComplete', '/accounting/customer-invoices/new'); });
    await settle();
    expect(description().value).toBe('');
  });
});

describe('edit: another invoice opened in place', () => {
  it('closes the first one\'s email form', async () => {
    serveInvoice((u) => (u.includes('id=inv-2') ? ok({ ...DRAFT, id: 'inv-2' }) : undefined));
    const { rerender } = render(<EditPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Email Invoice' })).toBeTruthy();
    h.router = { ...h.router, query: { invoiceId: 'inv-2' } };
    rerender(<EditPage />);
    await settle();
    expect(screen.queryByRole('heading', { name: 'Email Invoice' })).toBeNull();
  });
});

describe('/new: a refused approval whose move to the edit page fails', () => {
  it('says which invoice was created', async () => {
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST' ? refused(409, 'Gate says no', { reason: 'APPROVAL_REQUIRED' }) : undefined));
    (h.router as { push: unknown }).push = vi.fn(async () => false);
    render(owned(<NewPage />));
    await advance(0);
    await pick('Client', /Client/);
    type(description(), 'Work');
    type(screen.getAllByLabelText(/^Unit price/)[0]!, '100');
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/Invoice INV-AUTO was created as a draft/);
  });
});

describe('pending saves', () => {
  it('a save that never answers is not waited for again after the wait', async () => {
    trackInvoiceSave('inv-z', new Promise<void>(() => undefined));
    let first = false;
    void invoiceSavesSettled('inv-z').then(() => { first = true; });
    await advance(5_000);
    expect(first).toBe(true);
    let second = false;
    void invoiceSavesSettled('inv-z').then(() => { second = true; });
    await advance(0);
    expect(second).toBe(true);
  });
});
