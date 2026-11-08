/**
 * Payment-terms programme, Part A on the edit page: a draft whose due date came from terms shows the recalculated date
 * when the user moves the invoice date or the customer and has not touched the due date, so what is saved is what is
 * shown (the server re-dates the same way: shared/draftDueDate.ts). A hand-set date, or one the user touched, stays.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, DRAFT, ok, pick, puts, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';
import { shownDate, typeDate } from '../helpers/dateFields';

const h = vi.hoisted(() => ({ push: vi.fn(), query: { invoiceId: 'inv-1' } as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: h.push, replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); h.query = { invoiceId: 'inv-1' }; });
afterEach(() => { cleanup(); vi.useRealTimers(); h.push.mockReset(); vi.mocked(apiFetch).mockReset(); });

const settle = async () => { for (let i = 0; i < 6; i++) await advance(0); };
const TERMS: Record<string, { payment_terms: number; payment_terms_type: string }> = {
  'c-1': { payment_terms: 30, payment_terms_type: 'invoice_days' }, 'c-2': { payment_terms: 60, payment_terms_type: 'invoice_days' },
};
/**
 * The stored draft (invoice 15 Sep, due 15 Oct, customer c-1), its due date from `source`; customers 30 and 60 days.
 * `customerOf` overrides what a customer lookup answers (a held lookup, a failed one, a customer with no terms).
 */
function serve(source: string | undefined, customerOf?: (id: string) => Response | Promise<Response> | undefined) {
  serveInvoice((u) => {
    const id = /customers\?id=([^&]+)/.exec(u)?.[1];
    if (id) return customerOf?.(id) ?? ok({ id, name: id, ...TERMS[id] });
    if (u.endsWith('/customers') || u.includes('customers?')) return ok([{ id: 'c-1', name: 'Alpha' }, { id: 'c-2', name: 'Beta' }]);
    return undefined;
  }, { ...DRAFT, ...(source ? { due_date_source: source } : {}) });
}
const due = () => (screen.getByLabelText('Due date') as HTMLInputElement).value;
const invoiceDate = () => screen.getByLabelText(/^Invoice date/);

describe('the edit page shows the recalculated due date', () => {
  it('terms-sourced: a new invoice date moves the due date, and the autosave sends what is shown', async () => {
    serve('terms');
    render(<EditPage />);
    await settle();
    expect(due()).toBe(shownDate('2026-10-15'));
    typeDate(invoiceDate(), '01 Oct 2026');
    await settle();
    expect(due()).toBe(shownDate('2026-10-31'));
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!)).toMatchObject({ invoiceDate: '2026-10-01', dueDate: '2026-10-31' });
  });

  it('terms-sourced: moving the invoice date back shows the stored due date again', async () => {
    serve('terms');
    render(<EditPage />);
    await settle();
    typeDate(invoiceDate(), '01 Oct 2026');
    await settle();
    typeDate(invoiceDate(), '15 Sep 2026');
    await settle();
    expect(due()).toBe(shownDate('2026-10-15'));
  });

  it('terms-sourced: a new customer is dated by the NEW customer\'s terms', async () => {
    serve('terms');
    render(<EditPage />);
    await settle();
    await pick('Client', /Beta/);
    await settle();
    expect(due()).toBe(shownDate('2026-11-14')); // 15 Sep + 60 days
  });

  it.each(['manual', 'document', 'legacy', undefined])('a %s due date stays where it was', async (source) => {
    serve(source);
    render(<EditPage />);
    await settle();
    typeDate(invoiceDate(), '01 Oct 2026');
    await settle();
    expect(due()).toBe(shownDate('2026-10-15'));
  });

  it('a due date the user touched is theirs: a later change of invoice date leaves it', async () => {
    serve('terms');
    render(<EditPage />);
    await settle();
    typeDate(screen.getByLabelText('Due date'), '20 Dec 2026');
    await settle();
    typeDate(invoiceDate(), '01 Oct 2026');
    await settle();
    expect(due()).toBe(shownDate('2026-12-20'));
    fireEvent.blur(invoiceDate());
  });
});

const HINT = 'Recalculated from the customer\u2019s payment terms';
const notes = () => screen.getByPlaceholderText(/Notes or payment instructions/);

describe('what the page sends (an out-of-date page must not undo a re-dated date)', () => {
  // The stored date can move while the page is open (Re-apply, another tab). A save that sends the date the page loaded
  // would put it back, as a hand-set one. So the page names the due date only when it has something to say about it.
  it.each(['terms', 'manual'])('a %s draft: a note edited, the due date untouched: no dueDate in the PUT', async (source) => {
    serve(source);
    render(<EditPage />);
    await settle();
    type(notes(), 'a note');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!).notes).toBe('a note');
    expect('dueDate' in bodyOf(puts()[0]!)).toBe(false);
  });

  it('a due date the user typed is sent', async () => {
    serve('terms');
    render(<EditPage />);
    await settle();
    typeDate(screen.getByLabelText('Due date'), '20 Dec 2026');
    await advance(1_500);
    expect(bodyOf(puts()[0]!).dueDate).toBe('2026-12-20');
  });

  it('a manual draft whose invoice date moved sends the invoice date and no dueDate', async () => {
    serve('manual');
    render(<EditPage />);
    await settle();
    typeDate(invoiceDate(), '01 Oct 2026');
    await advance(1_500);
    expect(bodyOf(puts()[0]!).invoiceDate).toBe('2026-10-01');
    expect('dueDate' in bodyOf(puts()[0]!)).toBe(false);
  });

  it('a terms draft whose invoice date moved but whose customer terms are not read yet sends no dueDate (the server re-dates)', async () => {
    serve('terms', (id) => (id === 'c-1' ? new Promise<Response>(() => undefined) : undefined)); // the stored customer's lookup never answers
    render(<EditPage />);
    await settle();
    typeDate(invoiceDate(), '01 Oct 2026');
    await advance(1_500);
    expect(due()).toBe(shownDate('2026-10-15'));
    expect('dueDate' in bodyOf(puts()[0]!)).toBe(false);
  });
});

describe('the recalculated date needs the customer\'s terms', () => {
  it('a lookup that failed (customer unknown): the due date is left as it was', async () => {
    serve('terms', (id) => (id === 'c-1' ? new Response('{}', { status: 500 }) : undefined));
    render(<EditPage />);
    await settle();
    typeDate(invoiceDate(), '01 Oct 2026');
    await settle();
    expect(due()).toBe(shownDate('2026-10-15'));
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('another customer picked: its terms are not known yet, so the old customer\'s are not applied', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    serve('terms', (id) => (id === 'c-2' ? held.then(() => ok({ id, name: id, ...TERMS['c-2'] })) : undefined));
    render(<EditPage />);
    await settle();
    await pick('Client', /Beta/);
    await settle();
    expect(due()).toBe(shownDate('2026-10-15')); // not Alpha's 30 days, not yet Beta's 60
    release();
    await settle();
    expect(due()).toBe(shownDate('2026-11-14'));
  });

  it('a customer with no terms is dated by the company default (30 days from invoice when none is set)', async () => {
    serve('terms', (id) => ok({ id, name: id }));
    render(<EditPage />);
    await settle();
    typeDate(invoiceDate(), '01 Oct 2026');
    await settle();
    expect(due()).toBe(shownDate('2026-10-31'));
  });

  it('a customer with no terms, in a company whose default is 60 days from invoice', async () => {
    serve('terms', (id) => ok({ id, name: id, company_default_payment_terms: 60, company_default_payment_terms_type: 'invoice_days' }));
    render(<EditPage />);
    await settle();
    typeDate(invoiceDate(), '01 Oct 2026');
    await settle();
    expect(due()).toBe(shownDate('2026-11-30'));
  });

  it('the hint says where the date came from while it is recalculated, and goes once the user touches it or moves back', async () => {
    serve('terms');
    render(<EditPage />);
    await settle();
    expect(screen.queryByText(HINT)).toBeNull();
    typeDate(invoiceDate(), '01 Oct 2026');
    await settle();
    expect(screen.getByText(HINT)).toBeTruthy();
    typeDate(invoiceDate(), '15 Sep 2026');
    await settle();
    expect(screen.queryByText(HINT)).toBeNull();
    typeDate(invoiceDate(), '01 Oct 2026');
    await settle();
    typeDate(screen.getByLabelText('Due date'), '20 Dec 2026');
    await settle();
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
