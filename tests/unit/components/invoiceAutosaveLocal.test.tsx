/**
 * Master plan wave 3, PR S (decision 1): a new invoice is kept in this browser until it is created, never on the server
 * (create is wallet-metered and burns an invoice number). 800 ms after the last edit the form, lines and VAT mode go to
 * `isaflow:invoice-draft:<companyId>:<userId>`; a storage that throws never breaks the form; the next visit offers to
 * restore it; a successful create clears it. Nothing is written without a company and a user to key it by.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { AuthContext } from '@/contexts/AuthContext';
import { CompanyContext } from '@/contexts/CompanyContext';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, calls, description, pick, puts, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ push: vi.fn(), events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: h.push, replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));

import NewPage from '../../../pages/accounting/customer-invoices/new';

const KEY = 'isaflow:invoice-draft:co-1:u-1';
useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); localStorage.clear(); serveInvoice(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); h.push.mockReset(); vi.mocked(apiFetch).mockReset(); localStorage.clear(); });

async function open(owned = true) {
  const page = <NewPage />;
  render(owned ? (
    <AuthContext.Provider value={{ user: { id: 'u-1' } } as never}>
      <CompanyContext.Provider value={{ activeCompany: { id: 'co-1' } } as never}>{page}</CompanyContext.Provider>
    </AuthContext.Provider>
  ) : page);
  await advance(0);
}
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as null | { savedAt: number; data: { form: Record<string, unknown>; lines: { description: string; unitPrice: number }[]; taxMode: string } };
const price = () => screen.getAllByLabelText(/^Unit price/)[0] as HTMLInputElement;

describe('new invoice: the draft on this device', () => {
  it('writes form, lines and VAT mode 800 ms after the last edit, and says so', async () => {
    await open();
    type(description(), 'Kept');
    await advance(700);
    expect(stored()).toBeNull();
    await advance(100);
    const draft = stored()!;
    expect(draft.data.lines[0]).toMatchObject({ description: 'Kept' });
    expect(draft.data.taxMode).toBe('exclusive');
    expect(Object.keys(draft.data).sort()).toEqual(['form', 'lines', 'taxMode']);
    expect(Object.keys(draft.data.form)).not.toContain('token');
    expect(screen.getByText(/^Saved on this device · just now$/)).toBeTruthy();
    expect(puts()).toHaveLength(0);
    expect(calls('customer-invoices-create')).toHaveLength(0);
  });

  it('a storage that throws leaves the form working, says it could not keep the draft, and the next edit tries again', async () => {
    await open();
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    type(description(), 'Over quota');
    await advance(800);
    expect(description().value).toBe('Over quota');
    expect(screen.getByText(/could not keep this draft on this device/i)).toBeTruthy();
    setItem.mockRestore();
    type(description(), 'Room again');
    await advance(800);
    expect(stored()!.data.lines[0]).toMatchObject({ description: 'Room again' });
  });

  it('offers the kept draft on the next visit; Restore puts it back, mode and gross prices together, and the customer does not overwrite it', async () => {
    await open();
    await pick('Amounts are', /Including VAT/);
    type(description(), 'Restored work');
    type(price(), '230');
    await advance(800);
    cleanup();
    await open();
    expect(description().value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await advance(0);
    expect(description().value).toBe('Restored work');
    expect(price().value).toBe('230');
    expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Including VAT/);
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
  });

  it('does not overwrite a kept draft before the user answers the offer; Discard removes it', async () => {
    localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now(), data: { form: { clientId: '', invoiceDate: '2026-09-01', dueDate: '', billingPeriodStart: '', billingPeriodEnd: '', taxRate: 15, notes: 'old', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' }, lines: [{ key: '1', description: 'Old', quantity: 1, unitPrice: 5, discount: 0, glAccountId: '', projectId: '', cc2Id: '', buId: '' }], taxMode: 'exclusive' } }));
    await open();
    type(description(), 'New typing');
    await advance(2_000);
    expect(stored()!.data.lines[0]).toMatchObject({ description: 'Old' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await advance(0);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('a successful create clears the draft', async () => {
    await open();
    await pick('Client', /Client/);
    type(description(), 'Billed');
    type(price(), '100');
    await advance(800);
    expect(stored()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^create invoice$/i }));
    await advance(0);
    await advance(0);
    expect(h.push).toHaveBeenCalledWith('/accounting/customer-invoices/inv-1');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('writes nothing without a company and a user to key it by', async () => {
    await open(false);
    type(description(), 'Ownerless');
    await advance(2_000);
    expect(localStorage.length).toBe(0);
  });
});
