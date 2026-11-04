/**
 * PR S round-2 review H1: a customer picked again (after Save & New, after clearing it, or after another customer) is
 * pending until ITS new answer. `useCustomerLookup` remembered the customer the last answer was for; picking that one
 * again found it "answered" while its lookup was out and its defaults were null, so Save, Save & New and Approve stayed
 * enabled and posted with no due date, no discount and the default VAT mode.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { clickWhenEnabled, pickOption } from '../helpers/kitPick';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import { useCustomerLookup } from '@/components/accounting/customer-invoices/useCustomerLookup';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

/** A customer lookup's script: wait for `gate`, then answer, or fail (500). */
type Step = Promise<void> | { gate?: Promise<void>; fail?: true };
const DISCOUNT: Record<string, number> = { A: 5, B: 7, C: 9 }; // each customer's defaults tell it apart

/** Each customer lookup (`?id=`) takes the next step queued for that customer, if any; the rest answer at once. */
function serve(held: Record<string, Step[]> = {}) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('customer-invoices-create') && init?.method === 'POST') return ok({ id: 'n1' });
    if (u.includes('customer-invoices-detail') && !init?.method) return ok(STORED);
    const id = /\/api\/accounting\/customers\?id=([^&]+)/.exec(u)?.[1];
    if (id) {
      const step = held[id]?.shift();
      const { gate: wait, fail } = step instanceof Promise ? { gate: step, fail: undefined } : (step ?? {});
      await wait;
      if (fail) return new Response('{}', { status: 500 });
      return ok({ id, payment_terms: 30, payment_terms_type: 'days', default_discount: DISCOUNT[id] ?? 0, default_vat_type: null });
    }
    if (u.includes('/customers')) return ok([{ id: 'c-1', name: 'Acme' }, { id: 'c-2', name: 'Beta' }]);
    return ok([]);
  });
}
const posts = () => vi.mocked(apiFetch).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST').length;
const lookups = (id: string) => vi.mocked(apiFetch).mock.calls.filter((c) => String(c[0]) === `/api/accounting/customers?id=${id}`).length;
const saveAndNew = () => screen.getByRole('button', { name: /save & new/i }) as HTMLButtonElement;
const clientBox = () => screen.getByRole('combobox', { name: 'Client' }).textContent ?? '';
const STORED = { id: 'inv-1', invoice_number: 'INV-1', status: 'draft', client_id: 'c-1', invoice_date: '2026-09-15', due_date: '2026-10-15',
  billing_period_start: '2026-09-01', billing_period_end: '2026-09-30', tax_rate: 15, notes: '', currency_code: 'ZAR', exchange_rate: 1,
  items: [{ description: 'L', quantity: 1, unit_price: 10, amount: 10 }] };
const lookupHook = (id: string) => renderHook(({ id: c }) => useCustomerLookup(c, 'failed'), { initialProps: { id } });

describe('a customer picked again waits for its own answer', () => {
  it('Save & New for Acme, then Acme again: Save & New waits for Acme\'s new lookup and posts nothing meanwhile', async () => {
    const again = gate();
    serve({ 'c-1': [Promise.resolve(), again.promise] });
    render(<NewPage />);
    await pickOption('Client', 'Acme');
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Work' } });
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '50' } });
    await clickWhenEnabled(/save & new/i);
    await waitFor(() => expect(posts()).toBe(1));
    await waitFor(() => expect(clientBox()).toContain('Select client'));

    await pickOption('Client', 'Acme');
    await waitFor(() => expect(lookups('c-1')).toBe(2));
    expect(saveAndNew().disabled).toBe(true);
    fireEvent.click(saveAndNew());
    expect(posts()).toBe(1);
    again.release();
    await waitFor(() => expect(saveAndNew().disabled).toBe(false));
  });

  it('A, cleared, then A again: pending until the second answer', async () => {
    const again = gate();
    serve({ A: [Promise.resolve(), again.promise] });
    const { result, rerender } = renderHook(({ id }) => useCustomerLookup(id, 'failed'), { initialProps: { id: 'A' } });
    await waitFor(() => expect(result.current.pending).toBe(false));
    rerender({ id: '' });
    expect(result.current.pending).toBe(false);
    rerender({ id: 'A' });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(lookups('A')).toBe(2));
    expect(result.current.pending).toBe(true);
    await act(async () => { again.release(); await again.promise; });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it('B, C, then B again before C answers: pending until B\'s new answer', async () => {
    const c = gate();
    const bAgain = gate();
    serve({ B: [Promise.resolve(), bAgain.promise], C: [c.promise] });
    const { result, rerender } = renderHook(({ id }) => useCustomerLookup(id, 'failed'), { initialProps: { id: 'B' } });
    await waitFor(() => expect(result.current.pending).toBe(false));
    rerender({ id: 'C' });
    expect(result.current.pending).toBe(true);
    rerender({ id: 'B' });
    expect(result.current.pending).toBe(true);
    await act(async () => { c.release(); await c.promise; }); // C's late answer counts for nothing
    expect(result.current.pending).toBe(true);
    expect(result.current.defaults).toBeNull(); // never C's (discount 9)
    await act(async () => { bAgain.release(); await bAgain.promise; });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.defaults?.discount).toBe(7);
  });

  it('A answered, then B picked: A\'s defaults are gone while B\'s are asked', async () => {
    const b = gate();
    serve({ B: [b.promise] });
    const { result, rerender } = lookupHook('A');
    await waitFor(() => expect(result.current.defaults?.discount).toBe(5));
    rerender({ id: 'B' });
    expect(result.current.defaults).toBeNull();
    expect(result.current.pending).toBe(true);
    await act(async () => { b.release(); await b.promise; });
    await waitFor(() => expect(result.current.defaults?.discount).toBe(7));
  });

  it('A, cleared, A again whose lookup fails: pending, then not, with the error said', async () => {
    const again = gate();
    serve({ A: [Promise.resolve(), { gate: again.promise, fail: true }] });
    const { result, rerender } = lookupHook('A');
    await waitFor(() => expect(result.current.pending).toBe(false));
    rerender({ id: '' });
    rerender({ id: 'A' });
    expect(result.current.pending).toBe(true);
    await act(async () => { again.release(); await again.promise; });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.error).toBe('failed');
  });

  it('forget() while the customer stays picked asks again: pending until that answer, never stuck', async () => {
    const again = gate();
    serve({ A: [Promise.resolve(), again.promise] });
    const { result } = lookupHook('A');
    await waitFor(() => expect(result.current.pending).toBe(false));
    act(() => { result.current.forget(); });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(lookups('A')).toBe(2));
    await act(async () => { again.release(); await again.promise; });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});

describe('the edit page waits only for a customer changed on the page', () => {
  const saveChanges = () => screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;

  it('the stored customer\'s lookup held: Save Changes is enabled; another customer picked: disabled until its answer', async () => {
    const stored = gate();
    const beta = gate();
    serve({ 'c-1': [stored.promise], 'c-2': [beta.promise] });
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    await waitFor(() => expect(lookups('c-1')).toBe(1));
    expect(saveChanges().disabled).toBe(false);
    await pickOption('Client', 'Beta');
    await waitFor(() => expect(lookups('c-2')).toBe(1));
    expect(saveChanges().disabled).toBe(true);
    await act(async () => { beta.release(); await beta.promise; });
    await waitFor(() => expect(saveChanges().disabled).toBe(false));
    await act(async () => { stored.release(); await stored.promise; });
    expect(saveChanges().disabled).toBe(false); // the stored customer's late answer does not disable Save
  });
});
