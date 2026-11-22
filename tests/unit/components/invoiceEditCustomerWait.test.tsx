/**
 * Review of the line-level invoice form, finding 2 (and test gap 9b): on the edit page a line with no VAT type of its
 * own (one added on the page, or a legacy line off a no-VAT header) follows the customer's default VAT type, and a
 * customer picked on the page moves the due date by its terms. Autosave did not wait for the customer's lookup, so it
 * sent such lines typed by no customer at all (standard where the customer is exempt). Now:
 * - autosave holds while a customer picked on the page, or one a line follows, is being read; Save Changes waits too;
 * - a draft whose lines follow the stored customer is not taken as "what the server holds" until that customer is
 *   read, so the answer arriving is not an edit: opening the page sends nothing.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { pickOption } from '../helpers/kitPick';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

const TYPED = { id: 'inv-1', invoice_number: 'INV-1', status: 'draft', client_id: 'c-1', invoice_date: '2026-09-15', due_date: '2026-10-15',
  tax_rate: 15, total_amount: 115, notes: '', currency_code: 'ZAR', exchange_rate: 1,
  items: [{ description: 'Typed', quantity: 1, unit_price: 100, amount: 100, vat_type: 'standard', tax_amount: 15, tax_rate: 15 }] };
// A legacy draft off a no-VAT header: its line follows the customer (zero-rated, exempt for an exempt customer).
const LEGACY_NO_VAT = { ...TYPED, tax_rate: 0, total_amount: 100, items: [{ description: 'Legacy', quantity: 1, unit_price: 100, amount: 100 }] };

function gate() { let release!: () => void; const promise = new Promise<void>((r) => { release = r; }); return { promise, release }; }
/** Customer lookups wait on `held[id]` (if given) and answer that customer's default VAT type. */
function serve(invoice: object, held: Record<string, Promise<void>> = {}, vat: Record<string, string> = { 'c-1': 'exempt', 'c-2': 'exempt' }) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    const id = /customers\?id=([^&]+)/.exec(u)?.[1];
    if (id) { await held[id]; return ok({ id, payment_terms: 30, payment_terms_type: 'days', default_vat_type: vat[id] ?? null }); }
    if (u.includes('/customers')) return ok([{ id: 'c-1', name: 'Acme' }, { id: 'c-2', name: 'Beta' }]);
    if (u.includes('customer-invoices-detail') && init?.method === 'PUT') return ok({ updated: true });
    if (u.includes('customer-invoices-detail')) return ok(invoice);
    return ok([]);
  });
}
const puts = () => vi.mocked(apiFetch).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
const putBody = (i: number) => JSON.parse(String((puts()[i]![1] as RequestInit).body)) as { clientId: string; items: { description: string; vatType?: string }[] };
const pastDebounce = () => act(async () => { await new Promise((r) => setTimeout(r, 1_800)); });
const saveChanges = () => screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;
const lookups = (id: string) => vi.mocked(apiFetch).mock.calls.filter((c) => String(c[0]) === `/api/accounting/customers?id=${id}`).length;

describe('the edit page waits for the customer a line follows', () => {
  it('another customer picked, a new line added: autosave sends nothing until Beta is read, then its exempt type', async () => {
    const beta = gate();
    serve(TYPED, { 'c-2': beta.promise });
    render(<EditPage />);
    await screen.findByDisplayValue('Typed');
    await waitFor(() => expect(lookups('c-1')).toBe(1));
    await pickOption('Client', 'Beta');
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    fireEvent.change(screen.getAllByPlaceholderText('Item description')[1]!, { target: { value: 'Added' } });
    fireEvent.change(screen.getAllByLabelText(/^Unit price/)[1]!, { target: { value: '50' } });
    await pastDebounce();
    expect(puts()).toHaveLength(0); // never the line typed by no customer (standard)
    expect(saveChanges().disabled).toBe(true);
    expect(screen.queryByText("Loading the customer's VAT defaults…")).toBeNull(); // the form stays editable: no hint
    await act(async () => { beta.release(); await beta.promise; });
    await pastDebounce();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody(0).clientId).toBe('c-2');
    expect(putBody(0).items.map((i) => [i.description, i.vatType])).toEqual([['Typed', 'standard'], ['Added', 'exempt']]);
  }, 15_000);

  it('a legacy no-VAT draft of an exempt customer: opening it sends nothing, before or after the customer is read', async () => {
    const stored = gate();
    serve(LEGACY_NO_VAT, { 'c-1': stored.promise });
    render(<EditPage />);
    await screen.findByDisplayValue('Legacy');
    await waitFor(() => expect(lookups('c-1')).toBe(1));
    expect(saveChanges().disabled).toBe(true); // its line's type is the customer's: Save waits for it
    await pastDebounce();
    await act(async () => { stored.release(); await stored.promise; });
    await waitFor(() => expect(saveChanges().disabled).toBe(false));
    await pastDebounce();
    expect(puts()).toHaveLength(0); // the answer is not an edit
    fireEvent.change(screen.getByDisplayValue('Legacy'), { target: { value: 'Legacy edited' } });
    await pastDebounce();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody(0).items[0]).toMatchObject({ description: 'Legacy edited', vatType: 'exempt' });
  }, 15_000);

  it('while that customer is read the form takes no edit (it would be lost unsaved); an edit after the answer autosaves', async () => {
    const stored = gate();
    serve(LEGACY_NO_VAT, { 'c-1': stored.promise });
    render(<EditPage />);
    const field = await screen.findByDisplayValue('Legacy') as HTMLInputElement;
    const form = () => field.closest('fieldset')!;
    await waitFor(() => expect(lookups('c-1')).toBe(1));
    // The server's baseline is the first body: an edit typed now would be in it, and never autosaved.
    expect(form().disabled).toBe(true);
    const hint = () => screen.queryByText("Loading the customer's VAT defaults…");
    expect(hint()?.closest('[role="status"]')).toBeTruthy(); // said why, not a greyed form with no reason
    await act(async () => { stored.release(); await stored.promise; });
    await waitFor(() => expect(form().disabled).toBe(false));
    expect(hint()).toBeNull();
    await pastDebounce();
    expect(puts()).toHaveLength(0);
    fireEvent.change(field, { target: { value: 'After the answer' } });
    await pastDebounce();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody(0).items[0]).toMatchObject({ description: 'After the answer', vatType: 'exempt' });
  }, 15_000);
});
