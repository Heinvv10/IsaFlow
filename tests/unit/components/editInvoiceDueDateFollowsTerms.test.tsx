/**
 * Payment-terms programme, Part A on the edit page: a draft whose due date came from terms shows the recalculated date
 * when the user moves the invoice date or the customer and has not touched the due date, so what is saved is what is
 * shown (the server re-dates the same way: shared/draftDueDate.ts). A hand-set date, or one the user touched, stays.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, DRAFT, ok, pick, puts, routerEvents, serveInvoice } from '../helpers/invoiceAutosaveHarness';
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
/** The stored draft (invoice 15 Sep, due 15 Oct, customer c-1), its due date from `source`; customers 30 and 60 days. */
function serve(source: string | undefined) {
  serveInvoice((u) => {
    const id = /customers\?id=([^&]+)/.exec(u)?.[1];
    if (id) return ok({ id, name: id, ...TERMS[id] });
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
