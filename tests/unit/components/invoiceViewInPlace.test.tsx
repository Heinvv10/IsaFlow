/**
 * PR S round seven, the invoice page opened on another invoice in place (Back / Forward, Next):
 * - the email form, its address and result, the cancel and revoke questions, the portal link and the busy flags of A
 *   do not survive onto B: an Email then goes for B to B's customer;
 * - A's portal-link and pay-now answers landing after the move do nothing on B;
 * - A's refused action answering after the move shows nothing on B; A's approved action starts no reload of A;
 * - amounts show in the invoice's own currency.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, calls, ok, refused, routerEvents, serveInvoice } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({
  query: { invoiceId: 'inv-1' } as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents>,
  checkout: null as null | ((url: string) => void),
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));
vi.mock('@/modules/accounting/utils/payNowCheckout', () => ({ startPayNowCheckout: () => new Promise<string>((r) => { h.checkout = r; }) }));

import ViewPage from '../../../pages/accounting/customer-invoices/[invoiceId]';

useApiJsonOverMock();
const open = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); h.events = routerEvents(); h.query = { invoiceId: 'inv-1' }; h.checkout = null;
  vi.stubGlobal('open', open); open.mockReset();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.mocked(apiFetch).mockReset(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const VIEW = (id: string, extra: object = {}) => ({
  id, invoice_number: `INV-${id}`, client_name: `Client ${id}`, client_email: `${id}@client.example`, project_name: '', status: 'approved',
  invoice_date: '2026-09-01', due_date: '2026-10-01', subtotal: 100, tax_rate: 0, tax_amount: 0, total_amount: 100, amount_paid: 0, notes: '',
  gl_journal_entry_id: null, currency_code: 'ZAR', exchange_rate: 1, items: [{ id: `l-${id}`, description: `Line of ${id}`, quantity: 1, unit_price: 100, amount: 100, tax_rate: 0 }],
  approval: null, ...extra,
});
function serveAB(handler: (u: string, init?: RequestInit) => Promise<Response> | Response | undefined = () => undefined, extraA: object = {}) {
  serveInvoice((u, init) => handler(u, init)
    ?? (u.includes('customer-invoices-detail?id=inv-1') ? ok(VIEW('inv-1', extraA))
      : u.includes('customer-invoices-detail?id=inv-2') ? ok(VIEW('inv-2'))
        : u.includes('adjacent') ? ok({ prevId: null, nextId: null }) : u.includes('invoice-email') ? ok({ sent: true }) : undefined));
}
async function moveToB(rerender: (ui: React.ReactElement) => void) {
  h.query = { invoiceId: 'inv-2' };
  rerender(<ViewPage />);
  await settle();
  expect(screen.getByText('Line of inv-2')).toBeTruthy();
}

describe('A\'s page state does not survive onto B', () => {
  it('an email form open on A is gone on B; Email then goes for B, to B\'s customer', async () => {
    serveAB();
    const { rerender } = render(<ViewPage />);
    await settle();
    fireEvent.click(button('Email Invoice'));
    expect((screen.getByLabelText('Recipient Email') as HTMLInputElement).value).toBe('inv-1@client.example');
    await moveToB(rerender);
    expect(screen.queryByRole('dialog', { name: 'Email Invoice' })).toBeNull();
    fireEvent.click(button('Email Invoice'));
    const dialog = screen.getByRole('dialog', { name: 'Email Invoice' });
    expect((within(dialog).getByLabelText('Recipient Email') as HTMLInputElement).value).toBe('inv-2@client.example');
    fireEvent.click(within(dialog).getByRole('button', { name: /send email/i }));
    await settle();
    expect(bodyOf(calls('invoice-email')[0]!)).toEqual({ invoiceId: 'inv-2', recipientEmail: 'inv-2@client.example' });
  });

  it('a cancel question open on A is gone on B', async () => {
    serveAB();
    const { rerender } = render(<ViewPage />);
    await settle();
    fireEvent.click(button('More invoice actions'));
    await settle();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel Invoice' }));
    expect(screen.getByText('Cancel Invoice?')).toBeTruthy();
    await moveToB(rerender);
    expect(screen.queryByText('Cancel Invoice?')).toBeNull();
  });

  it('A\'s portal link answering after the move is not shown on B', async () => {
    let portal: (r: Response) => void = () => undefined;
    serveAB((u) => (u.includes('/api/portal/invoice/generate') ? new Promise<Response>((r) => { portal = r; }) : undefined));
    const { rerender } = render(<ViewPage />);
    await settle();
    fireEvent.click(button('Copy Portal Link'));
    await settle();
    await moveToB(rerender);
    portal(ok({ portalUrl: 'https://portal.example/a-token' }));
    await settle();
    expect(screen.queryByText('Portal link:')).toBeNull();
    expect(screen.queryByDisplayValue('https://portal.example/a-token')).toBeNull();
  });

  it('a portal link made on A is not shown under B', async () => {
    serveAB((u) => (u.includes('/api/portal/invoice/generate') ? ok({ portalUrl: 'https://portal.example/a-token' }) : undefined));
    const { rerender } = render(<ViewPage />);
    await settle();
    fireEvent.click(button('Copy Portal Link'));
    await settle();
    expect(screen.getByDisplayValue('https://portal.example/a-token')).toBeTruthy();
    await moveToB(rerender);
    expect(screen.queryByText('Portal link:')).toBeNull();
  });

  it('A\'s pay-now checkout answering after the move opens nothing from B', async () => {
    serveAB();
    const { rerender } = render(<ViewPage />);
    await settle();
    fireEvent.click(button('Pay Now'));
    await settle();
    await moveToB(rerender);
    h.checkout!('https://checkout.example/a');
    await settle();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('A\'s action answering after the move', () => {
  it('a refusal for A is not shown on B', async () => {
    let answer: (r: Response) => void = () => undefined;
    serveAB((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST' ? new Promise<Response>((r) => { answer = r; }) : undefined));
    const { rerender } = render(<ViewPage />);
    await settle();
    fireEvent.click(button('Mark Sent'));
    await settle();
    await moveToB(rerender);
    answer(refused(400, 'A could not be sent'));
    await settle();
    expect(screen.queryByText('A could not be sent')).toBeNull();
  });

  it('an action that succeeded for A starts no reload of A', async () => {
    let answer: (r: Response) => void = () => undefined;
    serveAB((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST' ? new Promise<Response>((r) => { answer = r; }) : undefined));
    const { rerender } = render(<ViewPage />);
    await settle();
    fireEvent.click(button('Mark Sent'));
    await settle();
    await moveToB(rerender);
    const loadsOfA = () => calls('customer-invoices-detail?id=inv-1', 'GET').length;
    const before = loadsOfA();
    answer(ok({ id: 'inv-1', status: 'sent' }));
    await settle();
    expect(loadsOfA()).toBe(before);
  });
});

describe('amounts in the invoice\'s own currency', () => {
  it('a USD invoice shows $ amounts, never R', async () => {
    serveAB(undefined, { currency_code: 'USD', exchange_rate: 18.5 });
    render(<ViewPage />);
    await settle();
    const totalRow = screen.getAllByText('Total')[0]!.parentElement!;
    expect(totalRow.textContent).toMatch(/\$\s?100\.00/);
    expect(document.body.textContent).not.toMatch(/R\s?100\.00/);
  });
});

// M14: this suite does not provide the auth context or the comments route; the panel has its own tests (commentsPanel, commentsMounts).
vi.mock('@/components/accounting/comments/CommentsPanel', () => ({ CommentsPanel: () => null }));
