/**
 * PR S round ten: an Approve & email answer that lands after another invoice opened in place is not shown on that
 * invoice's form, but it is not lost either: the app's toast (react-hot-toast, mounted once in _app) says what
 * happened to which invoice.
 * - a send: "Invoice INV-… : email sent", or "… email failed" with where to check;
 * - an approval: "Invoice INV-… approved", or the refusal's own sentence.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import toast, { Toaster } from 'react-hot-toast';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, DRAFT, ok, refused, routerEvents, serveInvoice } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ query: { invoiceId: 'inv-1' } as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); h.query = { invoiceId: 'inv-1' }; sessionStorage.clear(); });
afterEach(() => { toast.remove(); cleanup(); vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); sessionStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const B = { ...DRAFT, id: 'inv-2', invoice_number: 'INV-B' };
const App = () => <><EditPage /><Toaster /></>;

async function toB(rerender: (ui: React.ReactElement) => void) {
  h.query = { invoiceId: 'inv-2' };
  rerender(<App />);
  await settle();
}

describe('a send for A answering once B is open', () => {
  it.each([
    ['sent', () => ok({ sent: true }), 'Invoice INV-AUTO: email sent'],
    ['refused', () => refused(502, 'SMTP down'), 'Invoice INV-AUTO: email failed - check it on its page'],
    ['not sent', () => ok({ sent: false }), 'Invoice INV-AUTO: email failed - check it on its page'],
  ])('%s: a toast says so, naming A; B\'s form is untouched', async (_name, answer, notice) => {
    let sendA: (r: Response) => void = () => undefined;
    serveInvoice((u) => {
      if (u.includes('invoice-email')) return new Promise<Response>((r) => { sendA = r; });
      if (u.includes('customer-invoices-detail?id=inv-2')) return ok(B);
      return undefined;
    });
    const { rerender } = render(<App />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Email Invoice' })).getByRole('button', { name: /send email/i }));
    await settle();
    await toB(rerender);
    sendA(answer());
    await settle();
    expect(screen.getByText(notice)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Email Invoice' })).toBeNull();
  });
});

describe('an approval for A answering once B is open', () => {
  it.each([
    ['approved', () => ok({ id: 'inv-1', status: 'approved' }), 'Invoice INV-AUTO approved'],
    ['refused', () => refused(409, 'Approval required: a manager must approve this invoice', { reason: 'APPROVAL_REQUIRED' }), 'Invoice INV-AUTO: Approval required: a manager must approve this invoice'],
  ])('%s: a toast says so, naming A; B shows no error and no email form', async (_name, answer, notice) => {
    let approveA: (r: Response) => void = () => undefined;
    serveInvoice((u, init) => {
      if (u.includes('customer-invoices-detail') && init?.method === 'POST') return new Promise<Response>((r) => { approveA = r; });
      if (u.includes('customer-invoices-detail?id=inv-2')) return ok(B);
      return undefined;
    });
    const { rerender } = render(<App />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    await toB(rerender);
    approveA(answer());
    await settle();
    expect(screen.getByText(notice)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Email Invoice' })).toBeNull();
    expect(screen.queryAllByText(/Approval required: a manager/)).toHaveLength(notice.includes('Approval') ? 1 : 0); // the toast only, not B's error
  });

  it('an approval that lands while the email form is being read, after the move: a toast says it was approved', async () => {
    let readA: (r: Response) => void = () => undefined;
    let gets = 0;
    serveInvoice((u) => {
      if (u.includes('customer-invoices-detail?id=inv-1') && ++gets > 1) return new Promise<Response>((r) => { readA = r; });
      if (u.includes('customer-invoices-detail?id=inv-2')) return ok(B);
      return undefined;
    });
    const { rerender } = render(<App />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    await toB(rerender);
    readA(ok(DRAFT));
    await settle();
    expect(screen.getByText('Invoice INV-AUTO approved')).toBeTruthy();
  });
});
