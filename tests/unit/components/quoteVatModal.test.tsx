/**
 * The New Quote modal and per-line VAT (migration 1024): each line has a VAT type (Standard / Zero-rated / Exempt, the
 * invoice form's picker), the customer's default types a line with none of its own, the totals under the lines carry
 * one VAT row per type, priced per line as the server stores it, and the body sends each line's vatType with the price
 * as entered and amountsAre, never a legacy taxRate. A company not registered for VAT gets no VAT column, no "Amounts
 * are" and untyped lines. A quote date is required (M1), and a picked type survives a customer change (M2). Real page;
 * only the network is scripted.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { pickOption } from '../helpers/kitPick';
import { apiFetch } from '@/lib/apiFetch';
import { CompanyContext } from '@/contexts/CompanyContext';
import QuotesPage from '@/../pages/accounting/customer-quotes/index';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const CUSTOMERS = [{ id: 'c1', name: 'Acme', default_vat_type: null }, { id: 'c2', name: 'Exempt Trust', default_vat_type: 'exempt' }];
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    if (init?.method === 'POST') return json({ success: true, data: {} });
    if (String(url).startsWith('/api/accounting/customers')) return json({ success: true, data: CUSTOMERS });
    return json({ success: true, data: { quotes: [], total: 0 } });
  });
});
afterEach(() => { cleanup(); });

type Sent = { amountsAre: string; lines: Array<Record<string, unknown>> };
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
const sent = async (): Promise<Sent> => {
  await waitFor(() => expect(posts().length).toBe(1));
  return JSON.parse(String(posts()[0]![1]?.body)) as Sent;
};

function renderPage(vatPeriod?: string) {
  const page = <QuotesPage />;
  return render(vatPeriod === undefined ? page : (
    <CompanyContext.Provider value={{ activeCompany: { id: 'co-1', vatPeriod }, loading: false } as never}>{page}</CompanyContext.Provider>
  ));
}

/** Opens the modal, picks `customer` and types line 1: "Widget", 1 at `price`. */
async function openAndFill(price: string, customer = 'c1') {
  fireEvent.click((await screen.findAllByRole('button', { name: /New Quote/i }))[0]!);
  const select = screen.getAllByRole('combobox').find((s) => s.querySelector('option[value=""]')?.textContent?.includes('Select a customer'))!;
  await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: customer } });
  fireEvent.change(screen.getAllByPlaceholderText('Item description')[0]!, { target: { value: 'Widget' } });
  fireEvent.change(screen.getByLabelText('Unit price, line 1'), { target: { value: price } });
}
const createButton = () => screen.getAllByRole('button', { name: /Create Quote/i }).at(-1)! as HTMLButtonElement;
const create = () => fireEvent.click(createButton());
const dialog = () => screen.getByRole('dialog');
/** The totals block's figure on the row whose label starts with `label` (Subtotal, VAT Standard (15%), Total...). */
const figure = (label: string) => {
  const rows = Array.from(within(dialog()).getByRole('region', { name: 'Invoice totals' }).querySelectorAll('div'));
  const hit = rows.find((r) => r.children.length === 2 && (r.children[0]!.textContent ?? '').startsWith(label));
  return hit?.children[1]!.textContent ?? `no row "${label}"`;
};
const addLine = (description: string, price: string, n: number) => {
  fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
  fireEvent.change(screen.getAllByPlaceholderText('Item description')[n - 1]!, { target: { value: description } });
  fireEvent.change(screen.getByLabelText(`Unit price, line ${n}`), { target: { value: price } });
};
const pickType = async (n: number, name: RegExp) => {
  fireEvent.click(screen.getByRole('combobox', { name: `VAT type, line ${n}` }));
  fireEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name }));
};

it('a registered company: line 1 is Standard, VAT (15%) under the lines, and it sends vatType with the price, no taxRate', async () => {
  renderPage('bi-monthly');
  await openAndFill('100');
  expect(within(dialog()).getByText('VAT (15%)')).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Currency' })).toBeNull(); // a quote has no currency of its own
  expect(within(dialog()).getAllByText(/115\.00/).length).toBeGreaterThan(0);
  create();
  const body = await sent();
  expect(body.amountsAre).toBe('exclusive');
  expect(body.lines).toEqual([expect.objectContaining({ description: 'Widget', unitPrice: 100, vatType: 'standard' })]);
  expect('taxRate' in body.lines[0]!).toBe(false);
});

it('a line typed Exempt beside a standard one: one VAT row per type, the exempt line adds no VAT, each line sends its type', async () => {
  renderPage('bi-monthly');
  await openAndFill('100');
  addLine('Rent', '50', 2);
  await pickType(2, /^Exempt/);
  expect(figure('Subtotal')).toMatch(/150\.00/);
  expect(figure('VAT Standard (15%)')).toMatch(/15\.00/);
  expect(figure('VAT Exempt')).toMatch(/0\.00/);
  expect(figure('Total')).toMatch(/165\.00/);
  create();
  expect((await sent()).lines.map((l) => [l.description, l.vatType])).toEqual([['Widget', 'standard'], ['Rent', 'exempt']]);
});

it('an exempt customer\'s lines start Exempt (the server\'s default chain)', async () => {
  renderPage('bi-monthly');
  await openAndFill('100', 'c2');
  create();
  expect((await sent()).lines[0]!.vatType).toBe('exempt');
});

it('Including VAT sends the price as entered with amountsAre inclusive; the total is the gross typed', async () => {
  renderPage('bi-monthly');
  await openAndFill('100');
  await pickOption('Amounts are', /Including VAT/);
  // The switch converts the typed price: R100 ex VAT becomes R115 incl, and the line's total stays R100 net.
  expect((screen.getByLabelText('Unit price, line 1') as HTMLInputElement).value).toMatch(/^115(\.00)?$/);
  expect(screen.getByRole('columnheader', { name: /Unit Price \(incl\. VAT\)/ })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Unit price, line 1'), { target: { value: '230' } });
  expect([figure('Subtotal'), figure('VAT (15%)'), figure('Total')].map((t) => t.replace(/[^\d.]/g, ''))).toEqual(['200.00', '30.00', '230.00']);
  create();
  const body = await sent();
  expect([body.amountsAre, body.lines[0]!.unitPrice, body.lines[0]!.vatType]).toEqual(['inclusive', 230, 'standard']);
});

it('a company not registered for VAT: no VAT column or "Amounts are", untyped lines, exclusive', async () => {
  renderPage('none');
  await openAndFill('100');
  expect(screen.queryByRole('combobox', { name: /^VAT type/ })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Amounts are' })).toBeNull();
  expect(within(dialog()).getByText(/not registered for VAT/)).toBeTruthy();
  create();
  const body = await sent();
  expect(body.amountsAre).toBe('exclusive');
  expect('vatType' in body.lines[0]!).toBe(false);
  expect(body.lines[0]!.taxRate).toBe(0);
});

it('holds, as the invoice form does: standard VAT that rounds to nothing is said and nothing is sent', async () => {
  renderPage('bi-monthly');
  await openAndFill('0.03');
  create();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toMatch(/rounds to nothing/);
  expect(posts()).toHaveLength(0);
});

it('M1: clearing the quote date holds Create (the server would price on today, the modal on no date): nothing is sent', async () => {
  renderPage('bi-monthly');
  await openAndFill('100');
  const date = screen.getByRole('textbox', { name: /Quote Date/ });
  fireEvent.change(date, { target: { value: '' } });
  fireEvent.blur(date);
  expect(await within(dialog()).findByText('Enter a date.')).toBeTruthy(); // the field is required
  await waitFor(() => expect(createButton().disabled).toBe(true));
  create();
  expect(posts()).toHaveLength(0);
});

it('M2: a type picked on a line stays when the customer changes; a line with none follows the new customer', async () => {
  renderPage('bi-monthly');
  await openAndFill('100');
  addLine('Rent', '50', 2);
  await pickType(1, /^Zero-rated/);
  expect(screen.getByRole('combobox', { name: 'VAT type, line 2' }).textContent).toMatch(/^Standard/);
  const customer = screen.getAllByRole('combobox').find((c) => c.querySelector('option[value="c2"]'))!;
  fireEvent.change(customer, { target: { value: 'c2' } });
  expect(screen.getByRole('combobox', { name: 'VAT type, line 1' }).textContent).toMatch(/^Zero-rated/);
  expect(screen.getByRole('combobox', { name: 'VAT type, line 2' }).textContent).toMatch(/^Exempt/);
  create();
  expect((await sent()).lines.map((l) => [l.description, l.vatType])).toEqual([['Widget', 'zero_rated'], ['Rent', 'exempt']]);
});

it('L3: the price headers follow the effective mode: inclusive picked, then the company reads as not registered, says no "(incl. VAT)"', async () => {
  const { rerender } = renderPage('bi-monthly');
  await openAndFill('100');
  await pickOption('Amounts are', /Including VAT/);
  expect(screen.getByRole('columnheader', { name: /Unit Price \(incl\. VAT\)/ })).toBeTruthy();
  rerender(<CompanyContext.Provider value={{ activeCompany: { id: 'co-1', vatPeriod: 'none' }, loading: false } as never}><QuotesPage /></CompanyContext.Provider>);
  await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Amounts are' })).toBeNull());
  expect(screen.queryByText(/\(incl\. VAT\)|\(excl\. VAT\)/)).toBeNull();
});

it('L1: a price typed with no description anywhere: Create stays enabled and says why, nothing is sent', async () => {
  renderPage('bi-monthly');
  await openAndFill('100');
  fireEvent.change(screen.getAllByPlaceholderText('Item description')[0]!, { target: { value: '' } });
  expect(createButton().disabled).toBe(false);
  create();
  expect((await screen.findByRole('alert')).textContent).toBe('Line 1 needs a description');
  expect(posts()).toHaveLength(0);
});

it('L-B: a problem shown after Create clears as soon as the line is fixed (and a new one shows live)', async () => {
  renderPage('bi-monthly');
  await openAndFill('100');
  const description = screen.getAllByPlaceholderText('Item description')[0]!;
  fireEvent.change(description, { target: { value: '' } });
  create();
  expect((await screen.findByRole('alert')).textContent).toBe('Line 1 needs a description');
  fireEvent.change(description, { target: { value: 'Widget' } });
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.change(screen.getByLabelText('Unit price, line 1'), { target: { value: '0.03' } });
  expect(screen.getByRole('alert').textContent).toMatch(/rounds to nothing/);
  expect(posts()).toHaveLength(0);
});
