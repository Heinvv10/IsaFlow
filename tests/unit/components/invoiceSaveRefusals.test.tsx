/**
 * PR S review (breaker): the stored invoice is never a different one from the screen.
 * - A line the body would drop (a negative "discount" price, a price with no description, no quantity) counts in the
 *   screen's total, so Save, Approve & email, Create and autosave all refuse it, saying why. The price field says min 0.
 * - Clearing notes clears them (an empty string, not "leave as is"); clearing a stored due date or period is refused
 *   here, since the server would keep it and the status would claim Saved for a body it ignored.
 * - While Approve & email runs the form is disabled and autosave holds; a change that still lands is reported.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, calls, description, DRAFT, ok, pick, puts, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ push: vi.fn(), query: {} as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: h.push, replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); });
afterEach(() => { cleanup(); vi.useRealTimers(); h.push.mockReset(); vi.mocked(apiFetch).mockReset(); });

const THOUSAND = { ...DRAFT, total_amount: 1150, items: [{ description: 'Build', quantity: 1, unit_price: 1000, amount: 1000 }] };
const price = (i = 0) => screen.getAllByLabelText(/^Unit price/)[i] as HTMLInputElement;
const click = async (name: RegExp) => { fireEvent.click(screen.getByRole('button', { name })); for (let i = 0; i < 6; i++) await advance(0); };
const statusText = () => screen.getAllByRole('status').map((e) => e.textContent).join(' | ');
const alertText = () => screen.getAllByRole('alert').map((e) => e.textContent).join(' | ');
const writes = () => [...puts(), ...calls('customer-invoices-create'), ...calls('customer-invoices-detail', 'POST')];
const NEGATIVE = /"Discount" has a negative price/;
const NO_DESCRIPTION = /A line of 500\.00 has no description/;

async function openEdit(invoice: object = THOUSAND) {
  serveInvoice(undefined, invoice);
  h.query = { invoiceId: 'inv-1' };
  render(<EditPage />);
  await advance(0);
  await advance(0);
}
async function addLine(desc: string, unitPrice: string) {
  fireEvent.click(screen.getByRole('button', { name: /add line/i }));
  const i = screen.getAllByPlaceholderText('Item description').length - 1;
  if (desc) type(description(i), desc);
  type(price(i), unitPrice);
}

describe.each([
  ['a "Discount" line at -R100', 'Discount', '-100', NEGATIVE],
  ['a R500 line with no description', '', '500', NO_DESCRIPTION],
])('edit page: %s', (_name, desc, unitPrice, reason) => {
  it('autosave holds it and says why; Save and Approve & email refuse it; nothing is written', async () => {
    await openEdit();
    await addLine(desc, unitPrice);
    await advance(5_000);
    expect(puts()).toHaveLength(0);
    expect(statusText()).toMatch(reason);
    await click(/save changes/i);
    await click(/approve & email/i);
    expect(writes()).toHaveLength(0);
    expect(alertText()).toMatch(reason);
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe.each([
  ['a "Discount" line at -R100', 'Discount', '-100', NEGATIVE],
  ['a R500 line with no description', '', '500', NO_DESCRIPTION],
])('new page: %s', (_name, desc, unitPrice, reason) => {
  it('Create and Approve & email refuse it, saying why', async () => {
    serveInvoice();
    h.query = {};
    render(<NewPage />);
    await advance(0);
    await pick('Client', /Client/);
    type(description(), 'Build');
    type(price(), '1000');
    await addLine(desc, unitPrice);
    await click(/^create invoice$/i);
    await click(/approve & email/i);
    expect(writes()).toHaveLength(0);
    expect(alertText()).toMatch(reason);
  });
});

describe('the price field', () => {
  it('says it takes nothing below 0', async () => {
    await openEdit();
    expect(price().getAttribute('min')).toBe('0');
  });
});

describe('notes, due date and period on the edit page', () => {
  it('clearing the notes sends an empty string, which clears them', async () => {
    await openEdit({ ...THOUSAND, notes: 'Pay by EFT' });
    type(screen.getByLabelText('Notes'), '');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!).notes).toBe('');
  });

  it('clearing a stored due date is refused, never saved as if it were', async () => {
    await openEdit();
    const due = screen.getByLabelText('Due date');
    fireEvent.change(due, { target: { value: '' } });
    fireEvent.blur(due);
    await advance(5_000);
    expect(puts()).toHaveLength(0);
    expect(statusText()).toMatch(/The due date cannot be cleared here/);
    await click(/save changes/i);
    expect(puts()).toHaveLength(0);
    expect(alertText()).toMatch(/The due date cannot be cleared here/);
  });
});

describe('while Approve & email runs', () => {
  it('the form is disabled, autosave holds, and a change that still lands is reported with the email form', async () => {
    let approve: (r: Response) => void = () => undefined;
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST'
      ? new Promise<Response>((r) => { approve = r; }) : undefined), THOUSAND);
    h.query = { invoiceId: 'inv-1' };
    render(<EditPage />);
    await advance(0);
    await advance(0);
    await click(/approve & email/i);
    expect(description()).toBeDisabled();
    expect(price()).toBeDisabled();
    type(description(), 'Typed while approving');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
    approve(ok({ id: 'inv-1', status: 'approved' }));
    for (let i = 0; i < 6; i++) await advance(0);
    expect(screen.getByRole('heading', { name: 'Email Invoice' })).toBeTruthy();
    expect(screen.getByText(/changed while it was being approved/)).toBeTruthy();
    await advance(5_000);
    expect(puts()).toHaveLength(0);
  });

  it('on the new page the form is disabled while the invoice is created', async () => {
    let create: (r: Response) => void = () => undefined;
    serveInvoice((u) => (u.includes('customer-invoices-create') ? new Promise<Response>((r) => { create = r; }) : undefined));
    h.query = {};
    render(<NewPage />);
    await advance(0);
    await pick('Client', /Client/);
    type(description(), 'Build');
    type(price(), '1000');
    await click(/^create invoice$/i);
    expect(description()).toBeDisabled();
    create(ok({ id: 'inv-1' }));
    for (let i = 0; i < 6; i++) await advance(0);
  });
});
