/**
 * Master plan wave 3, PR S: the edit page autosaves a draft with the Save button's own body, 1.5 s after the last edit,
 * and only when that body differs from what the server last took. An edit PUT stamps the editor as an approval author
 * (R-035 PR4), so loading the page, or typing a value back to what it was, must send nothing. One PUT at a time; a reply
 * for an older body never marks a newer one saved; a 400 stops autosave until the next edit; create is never called.
 * A VAT rate edit under way saves nothing: in inclusive mode each keystroke reprices the net (PR D's warning).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import {
  advance, bodyOf, calls, description, ok, pick, puts, refused, routerEvents, serveInvoice, type,
} from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ push: vi.fn(), events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: h.push, replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({
  InvoicePdfPreview: ({ version }: { version: number }) => <p data-testid="preview">{`preview v${version}`}</p>,
}));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); });
afterEach(() => { cleanup(); vi.useRealTimers(); h.push.mockReset(); vi.mocked(apiFetch).mockReset(); });

async function open() {
  render(<EditPage />);
  await advance(0);
  await advance(0);
  expect(description().value).toBe('Consulting');
}
const status = () => screen.queryByText(/^Saved|^Saving|^Unsaved changes/)?.textContent ?? null;
const rate = () => screen.getByLabelText('VAT rate %');
const price = () => screen.getAllByLabelText(/^Unit price/)[0] as HTMLInputElement;

describe('edit page autosave', () => {
  it('loading the page sends no PUT, however long it sits', async () => {
    serveInvoice();
    await open();
    await advance(10_000);
    expect(puts()).toHaveLength(0);
    expect(status()).toBeNull();
  });

  it('typing a value back to what it was sends no PUT', async () => {
    serveInvoice();
    await open();
    type(description(), 'Consulting!');
    await advance(500);
    type(description(), 'Consulting');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
  });

  it('five quick edits send one PUT, the Save button\'s body with the last value, and say Saved', async () => {
    serveInvoice();
    await open();
    for (const v of ['C1', 'C12', 'C123', 'C1234', 'C12345']) { type(description(), v); await advance(300); }
    expect(puts()).toHaveLength(0);
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    const body = bodyOf(puts()[0]!);
    expect(body).toMatchObject({ id: 'inv-1', clientId: 'c-1', invoiceDate: '2026-09-15', taxRate: 15 });
    expect('dueDate' in body).toBe(false); // an untouched due date is the page's old copy: left out, the server keeps its own
    expect(body.items).toEqual([expect.objectContaining({ description: 'C12345', quantity: 1, unitPrice: 100, taxRate: 15, discount: 0 })]);
    expect(status()).toMatch(/^Saved/);
    expect(screen.getByTestId('preview').textContent).toBe('preview v1');
    await advance(10_000);
    expect(puts()).toHaveLength(1);
  });

  it('choosing Including VAT alone sends nothing: the shown gross converts back to the stored price', async () => {
    serveInvoice();
    await open();
    await pick('Amounts are', /Including VAT/);
    expect(price().value).toBe('115');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
  });

  it('a VAT rate edit under way saves nothing; leaving the field saves the finished rate once, gross held', async () => {
    serveInvoice();
    await open();
    await pick('Amounts are', /Including VAT/);
    fireEvent.focus(rate());
    type(rate(), '1');
    await advance(5_000);
    type(rate(), '');
    await advance(5_000);
    type(rate(), '14');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
    fireEvent.blur(rate());
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    const body = bodyOf(puts()[0]!);
    expect(body.taxRate).toBe(14);
    expect(body.items[0]!.unitPrice).toBe(100.88); // R115 incl at 14%
  });

  it('one PUT at a time; a reply for an older body never marks the newer one saved, and the newest goes next', async () => {
    const replies: ((r: Response) => void)[] = [];
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'PUT'
      ? new Promise<Response>((r) => { replies.push(r); }) : undefined));
    await open();
    type(description(), 'First');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    type(description(), 'Second');
    await advance(1_500);
    type(description(), 'Third');
    await advance(1_500);
    expect(puts()).toHaveLength(1); // still waiting on the first
    replies[0]!(ok({ updated: true }));
    await advance(0);
    expect(puts()).toHaveLength(2);
    expect(bodyOf(puts()[1]!).items[0]!.description).toBe('Third');
    expect(status()).toBe('Saving…'); // First's reply did not call Third saved
    replies[1]!(ok({ updated: true }));
    await advance(0);
    expect(status()).toMatch(/^Saved/);
    await advance(5_000);
    expect(puts()).toHaveLength(2);
  });

  it('a 400 stops autosave and shows the server\'s message; the next edit re-arms it', async () => {
    serveInvoice((u, init) => (init?.method === 'PUT' && puts().length === 1 ? refused(400, 'Revenue account is not active') : undefined));
    await open();
    type(description(), 'Refused');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
    expect(screen.getByText('Revenue account is not active')).toBeTruthy();
    await advance(10_000);
    expect(puts()).toHaveLength(1);
    type(description(), 'Refused again');
    await advance(1_500);
    expect(puts()).toHaveLength(2);
    expect(screen.queryByText('Revenue account is not active')).toBeNull();
  });

  it('never calls create', async () => {
    serveInvoice();
    await open();
    type(description(), 'Edited');
    await advance(1_500);
    type(price(), '250');
    await advance(1_500);
    expect(puts()).toHaveLength(2);
    expect(calls('customer-invoices-create')).toHaveLength(0);
  });

  it('a half-typed line or a refused date holds the save back', async () => {
    serveInvoice();
    await open();
    type(screen.getAllByLabelText('Quantity')[0]!, '');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
    expect(screen.getByText('Not saved: "Consulting" needs a quantity above 0')).toBeTruthy();
    type(screen.getAllByLabelText('Quantity')[0]!, '2');
    await advance(1_500);
    expect(puts()).toHaveLength(1);
  });
});

describe('the unsaved-change guard', () => {
  it('asks before leaving while a change is unsaved, and cancels the route change when refused', async () => {
    serveInvoice();
    const confirm = vi.fn(() => false);
    const original = window.confirm;
    window.confirm = confirm; // happy-dom has none
    await open();
    h.events!.emit('routeChangeStart', '/elsewhere'); // nothing unsaved: no question
    expect(confirm).not.toHaveBeenCalled();
    type(description(), 'Unsaved');
    expect(() => h.events!.emit('routeChangeStart', '/elsewhere')).toThrow(/unsaved/i);
    expect(confirm).toHaveBeenCalledTimes(1);
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await advance(1_500);
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(() => h.events!.emit('routeChangeStart', '/elsewhere')).not.toThrow();
    window.confirm = original;
  });
});
