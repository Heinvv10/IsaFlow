/**
 * PR S round six:
 * - The edit page never re-saves without being asked. A draft whose stored total is not what its lines price to now
 *   (a quote converted at 0%, a WIP draft rounded per line) shows both figures, and Approve & email refuses with
 *   "Save to reprice at …, or approve … from the invoice page": no PUT, no approval.
 * - A STALE_VIEW reload starts autosave afresh: nothing is saved without input.
 * - The invoice page acts on the invoice it shows: an action's late answer for A does not bring A back over B, and
 *   Email Invoice then goes for B, to B's customer. It shows the currency (and rate) it will approve in.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, calls, DRAFT, ok, puts, refused, routerEvents, serveInvoice, type, description } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ query: { invoiceId: 'inv-1' } as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import ViewPage from '../../../pages/accounting/customer-invoices/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); h.query = { invoiceId: 'inv-1' }; sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); sessionStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const approves = () => calls('customer-invoices-detail', 'POST');
const alertText = () => screen.queryAllByRole('alert').map((a) => a.textContent).join(' | ');
const VIEW = (id: string, extra: object = {}) => ({
  id, invoice_number: `INV-${id}`, client_name: `Client ${id}`, client_email: `${id}@client.example`, project_name: '', status: 'draft',
  invoice_date: '2026-09-01', due_date: '2026-10-01', subtotal: 100, tax_rate: 0, tax_amount: 0, total_amount: 100, amount_paid: 0, notes: '',
  gl_journal_entry_id: null, currency_code: 'ZAR', exchange_rate: 1, items: [{ id: `l-${id}`, description: `Line of ${id}`, quantity: 1, unit_price: 100, amount: 100, tax_rate: 0 }],
  approval: { state: 'not_required', enforced: false, requiredRole: null, ruleName: null, requestId: null }, ...extra,
});

describe.each([
  ['a quote converted at 0% (stored R1 000; the header rate prices it to R1 150)', { ...DRAFT, tax_rate: 15, total_amount: 1000, items: [{ description: 'Quoted work', quantity: 1, unit_price: 1000, amount: 1000, tax_rate: 0 }] }, /Save to reprice at R\s?1\s?150\.00, or approve R\s?1\s?000\.00 from the invoice page/],
  ['a WIP draft rounded per line (stored R115.00; the lines price to R114.99)', { ...DRAFT, tax_rate: 15, total_amount: 115, items: [{ description: 'Time 1', quantity: 3, unit_price: 33.33, amount: 99.99, time_entry_id: 'te-1' }] }, /Save to reprice at R\s?114\.99, or approve R\s?115\.00 from the invoice page/],
])('edit page: %s', (_name, invoice, refusal) => {
  it('shows both figures; Approve & email refuses and nothing is saved or approved', async () => {
    serveInvoice(undefined, invoice);
    render(<EditPage />);
    await settle();
    expect(screen.getByText(/Stored total/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    await advance(5_000);
    expect(puts()).toHaveLength(0);
    expect(approves()).toHaveLength(0);
    expect(alertText()).toMatch(refusal);
  });
});

describe('edit page: a STALE_VIEW reload', () => {
  it('starts autosave afresh: the invoice as now stored is not saved back without input', async () => {
    let gets = 0;
    serveInvoice((u, init) => {
      if (u.includes('customer-invoices-detail') && init?.method === 'POST') return refused(409, 'Changed elsewhere', { reason: 'STALE_VIEW' });
      if (u.includes('customer-invoices-detail?id=') && ++gets > 1) return ok({ ...DRAFT, items: [{ description: 'Changed in another tab', quantity: 1, unit_price: 100, amount: 100 }] });
      return undefined;
    });
    render(<EditPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(description().value).toBe('Changed in another tab');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
  });
});

describe('invoice page: the invoice it shows', () => {
  it('Approve on A, Next to B before it answers: B stays, and Email Invoice goes for B to B\'s customer', async () => {
    let answerA: (r: Response) => void = () => undefined;
    serveInvoice((u, init) => {
      if (u.includes('customer-invoices-detail') && init?.method === 'POST') return new Promise<Response>((r) => { answerA = r; });
      if (u.includes('customer-invoices-detail?id=inv-1')) return ok(VIEW('inv-1'));
      if (u.includes('customer-invoices-detail?id=inv-2')) return ok(VIEW('inv-2'));
      if (u.includes('invoice-email')) return ok({ sent: true });
      if (u.includes('adjacent')) return ok({ prevId: null, nextId: null });
      return undefined;
    });
    const { rerender } = render(<ViewPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await settle();
    h.query = { invoiceId: 'inv-2' };
    rerender(<ViewPage />);
    await settle();
    answerA(ok({ id: 'inv-1', status: 'approved' }));
    await settle();
    expect(screen.getByText('Line of inv-2')).toBeTruthy();
    expect(screen.queryByText('Line of inv-1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Email Invoice' }));
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Email Invoice' });
    expect((within(dialog).getByLabelText('Recipient Email') as HTMLInputElement).value).toBe('inv-2@client.example');
    fireEvent.click(within(dialog).getByRole('button', { name: /send email/i }));
    await settle();
    expect(bodyOf(calls('invoice-email')[0]!)).toEqual({ invoiceId: 'inv-2', recipientEmail: 'inv-2@client.example' });
  });

  it('shows the currency, and the rate when not ZAR, it will approve in', async () => {
    serveInvoice((u) => (u.includes('customer-invoices-detail?id=') ? ok(VIEW('inv-1', { currency_code: 'USD', exchange_rate: '18.500000' })) : u.includes('adjacent') ? ok({ prevId: null, nextId: null }) : undefined));
    render(<ViewPage />);
    await settle();
    expect(screen.getByText(/Currency: USD at 18\.5/)).toBeTruthy();
  });
});

describe('the new page and a STALE_VIEW', () => {
  it('is not carried to the edit page as a sticky gate refusal', async () => {
    const NewPage = (await import('../../../pages/accounting/customer-invoices/new')).default;
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST' ? refused(409, 'Changed elsewhere', { reason: 'STALE_VIEW' }) : undefined));
    h.query = {};
    render(<NewPage />);
    await advance(0);
    const { pick } = await import('../helpers/invoiceAutosaveHarness');
    await pick('Client', /Client/);
    type(description(), 'Work');
    type(screen.getAllByLabelText(/^Unit price/)[0]!, '100');
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(JSON.parse(sessionStorage.getItem('isaflow:invoice-approve-refused:inv-1')!)).toEqual({ message: 'Changed elsewhere', status: null });
  });
});
