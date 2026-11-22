/**
 * Master plan wave 3, PR D, and the line-level VAT form: the "Amounts are" choice on the new and edit pages reaches the
 * request body (as `amountsAre` with the prices as typed), each line carries its own VAT type (a customer's default
 * types a line the user has not typed, never one they have), the totals break the VAT down per type, and the edit page
 * keeps a stored invoice as it is until the user changes it. Pricing itself: invoiceTaxMode.test.ts, invoiceFormVat.test.ts.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import {
  contactCalls, descriptionField, discounts, due, fillLine, hintFromCustomer, invoiceDate, pickClient, pickMode, pickVatType, sentBody, serve, submitAndWait,
  totalRowText, totalsText, vatTypesShown,
} from '../helpers/invoiceDefaultsHarness';

const push = vi.hoisted(() => vi.fn());
const scan = vi.hoisted(() => ({ current: { dueDate: null as string | null, vatRate: null as number | null, lineItems: [] as unknown[] } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <button onClick={() => onExtracted({ date: null, customerName: null, confidence: 0.9, ...scan.current })}>scan stub</button>
  ),
}));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); scan.current = { dueDate: null, vatRate: null, lineItems: [] }; });

const open = async () => { render(<NewPage />); await screen.findByRole('combobox', { name: 'Client' }); typeDate(invoiceDate(), '1 Oct 2026'); };
const submit = () => submitAndWait(push);
const discountsOnScreen = () => screen.queryAllByLabelText('Discount %');

describe('VAT type per line, and "Amounts are"', () => {
  it('a zero-rated customer types each line zero-rated, with a hint, and posts vatType per line and no rate', async () => {
    serve();
    await open();
    expect(vatTypesShown()).toEqual(['Standard (15%)']);
    await pickClient('c-zero');
    await waitFor(() => expect(vatTypesShown()).toEqual(['Zero-rated (0%)']));
    expect(screen.getByText('VAT type from customer: zero-rated')).toBeTruthy();
    expect(screen.queryByLabelText('VAT rate %')).toBeNull(); // no form-wide rate any more
    fillLine();
    await submit();
    const body = sentBody('POST');
    expect(body.taxRate).toBeUndefined();
    expect(body.items.map((i) => [i.unitPrice, i.vatType])).toEqual([[115, 'zero_rated']]);
  });

  it('a line\'s VAT type the user chose is not overwritten by the customer, and the form says they disagree', async () => {
    serve();
    await open();
    await pickVatType(0, /Standard/);
    await pickClient('c-zero');
    await screen.findByText('This customer is zero-rated, but a line is standard-rated.'); // the customer's answer has landed, and says so
    expect(vatTypesShown()).toEqual(['Standard (15%)']);
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    expect(vatTypesShown()).toEqual(['Standard (15%)', 'Zero-rated (0%)']); // a new line takes the customer's
  });

  it('"Amounts are" is the user\'s: a customer does not move it', async () => {
    serve();
    await open();
    await pickMode(/Including VAT/);
    await pickClient('c-zero');
    await waitFor(() => expect(vatTypesShown()).toEqual(['Zero-rated (0%)']));
    expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Including VAT/);
  });

  it('a registered company is offered Excluding / Including only: VAT-free lines are typed per line', async () => {
    serve();
    await open();
    fireEvent.click(screen.getByRole('combobox', { name: 'Amounts are' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Excluding VAT', 'Including VAT']);
  });

  it('inclusive 115 posts unitPrice 115 with its mode and the line standard (the server backs the VAT out; it was sent as 100)', async () => {
    serve();
    await open();
    await pickClient('c-bare');
    await pickMode(/Including VAT/);
    fillLine();
    await submit();
    const body = sentBody('POST');
    expect(body.items[0]!.unitPrice).toBe(115);
    expect(body.amountsAre).toBe('inclusive');
    expect(body.items[0]!.vatType).toBe('standard');
    expect(body.taxRate).toBeUndefined();
  });

  it('an inclusive total is exactly the typed one now: 3 x R10 incl. totals R30.00 and no "these prices come to" note', async () => {
    serve();
    await open();
    await pickMode(/Including VAT/);
    fillLine(0, '10', '3');
    await waitFor(() => expect(totalRowText()).toMatch(/30\.00/));
    expect(screen.queryByText(/these prices come to/i)).toBeNull();
  });

  it('no message when the two agree', async () => {
    serve();
    await open();
    await pickMode(/Including VAT/);
    fillLine(0, '115');
    expect(totalRowText()).toMatch(/115\.00/);
    expect(screen.queryByText(/these prices come to/i)).toBeNull();
  });

  it('mixed types show the VAT per type under the lines, each on its own net', async () => {
    serve();
    await open();
    fillLine(0, '100');
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    fireEvent.change(descriptionField(1), { target: { value: 'Rent' } });
    fireEvent.change(screen.getAllByLabelText(/^Unit price/)[1]!, { target: { value: '50' } });
    await pickVatType(1, /Exempt/);
    const t = totalsText();
    expect(t).toMatch(/SubtotalR\s?150\.00/);
    expect(t).toMatch(/VAT Standard \(15%\) on R\s?100\.00R\s?15\.00/);
    expect(t).toMatch(/VAT Exempt on R\s?50\.00R\s?0\.00/);
    expect(totalRowText()).toMatch(/165\.00/);
  });

  it('a scan carrying a rate is exclusive, as its prices are, and types its lines by it', async () => {
    serve();
    await open();
    await pickClient('c-bare');
    await pickMode(/Including VAT/);
    scan.current = { ...scan.current, vatRate: 15, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 200 }] };
    fireEvent.click(screen.getByText('scan stub'));
    await waitFor(() => expect((descriptionField() as HTMLInputElement).value).toBe('Scanned'));
    expect(vatTypesShown()).toEqual(['Standard (15%)']);
    await submit();
    expect(sentBody('POST').items.map((i) => [i.unitPrice, i.vatType])).toEqual([[200, 'standard']]);
  });

  it('a scanned rate that is neither the standard rate nor 0 leaves the line asking for a type, and Create holds', async () => {
    serve();
    await open();
    await pickClient('c-bare');
    scan.current = { ...scan.current, vatRate: 14, lineItems: [{ description: 'Old', quantity: 1, unitPrice: 200 }] };
    fireEvent.click(screen.getByText('scan stub'));
    await waitFor(() => expect(vatTypesShown()).toEqual(['Choose…']));
    const create = screen.getByRole('button', { name: /^create invoice$/i }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    expect(await screen.findByText('Choose a VAT type for "Old"')).toBeTruthy();
    await pickVatType(0, /Zero-rated/);
    await submit();
    expect(sentBody('POST').items.map((i) => i.vatType)).toEqual(['zero_rated']);
  });

  it('Save & New starts clean: what the user chose on the last invoice does not stop the next one defaulting', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await pickMode(/Including VAT/);
    typeDate(due(), '20 Oct 2026');
    fillLine();
    fireEvent.click(screen.getByRole('button', { name: /save & new/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Excluding VAT/));
    expect(hintFromCustomer()).toEqual([]);
    typeDate(invoiceDate(), '1 Oct 2026');
    await pickClient('c-zero');
    await waitFor(() => expect(vatTypesShown()).toEqual(['Zero-rated (0%)']));
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
    await waitFor(() => expect(discounts()).toEqual(['10']));
    expect(vatTypesShown()).toEqual(['Standard (15%)']);
  });
});

describe('edit page', () => {
  const load = async () => { render(<EditPage />); await screen.findByDisplayValue('L'); };

  it('loads stored ex-VAT prices in exclusive mode, and saves them unconverted', async () => {
    serve();
    await load();
    expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Excluding VAT/);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = sentBody('PUT');
    expect(body.items[0]!.unitPrice).toBe(115);
    // Per-line VAT: the line goes with its type (the form's 15% is the standard rate), the header with no rate.
    expect(body.items[0]!.vatType).toBe('standard');
    expect(body.amountsAre).toBe('exclusive');
    expect(body.taxRate).toBeUndefined();
  });

  it('reads the loaded customer only to warn: a stored invoice is not refilled', async () => {
    serve();
    await load();
    await waitFor(() => expect(contactCalls().length).toBe(1));
    expect(due().value).toBe('15 Oct 2026');
    expect(hintFromCustomer()).toEqual([]);
    expect(discountsOnScreen()).toEqual([]);
  });

  it('a line re-typed Zero-rated saves zero_rated (no rate sent), at the stored price', async () => {
    serve();
    await load();
    expect(vatTypesShown()).toEqual(['Standard (15%)']);
    await pickVatType(0, /Zero-rated/);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = sentBody('PUT');
    expect(body.taxRate).toBeUndefined();
    expect(body.items[0]!.vatType).toBe('zero_rated');
    expect(body.items[0]!.unitPrice).toBe(115);
  });

  it('heads the page with PageHeader, not the always-dark banner', async () => {
    serve();
    const { container } = render(<EditPage />);
    await screen.findByDisplayValue('L');
    expect(screen.getByRole('heading', { level: 1, name: 'INV-1' })).toBeTruthy();
    expect(container.querySelector('.bg-gradient-to-br')).toBeNull();
    expect(screen.getByText('Edit draft')).toBeTruthy();
  });
});
