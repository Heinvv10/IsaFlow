/**
 * The New Quote modal and per-line VAT (migration 1024): each line has a VAT type (Standard / Zero-rated / Exempt, the
 * invoice form's picker), the customer's default types a line with none of its own, the totals under the lines carry
 * one VAT row per type, priced per line as the server stores it, and the body sends each line's vatType with the price
 * as entered and amountsAre, never a legacy taxRate. A company not registered for VAT gets no VAT column, no "Amounts
 * are" and untyped lines. Real page; only the network is scripted.
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
const create = () => fireEvent.click(screen.getAllByRole('button', { name: /Create Quote/i }).at(-1)!);
const dialog = () => screen.getByRole('dialog');

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

it('a line typed Exempt beside a standard one: one VAT row per type, and each line sends its own type', async () => {
  renderPage('bi-monthly');
  await openAndFill('100');
  fireEvent.click(screen.getByRole('button', { name: /Add line/i }));
  fireEvent.change(screen.getAllByPlaceholderText('Item description')[1]!, { target: { value: 'Rent' } });
  fireEvent.change(screen.getByLabelText('Unit price, line 2'), { target: { value: '50' } });
  const pickers = screen.getAllByRole('combobox', { name: 'VAT type' });
  fireEvent.click(pickers[1]!);
  fireEvent.click(await screen.findByRole('option', { name: 'Exempt' }));
  expect(within(dialog()).getByText(/VAT Standard \(15%\)/)).toBeTruthy();
  expect(within(dialog()).getByText(/VAT Exempt/)).toBeTruthy();
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
  await pickOption('Amounts are', /Including VAT/); // the shown R100 ex becomes R115 incl
  fireEvent.change(screen.getByLabelText('Unit price, line 1'), { target: { value: '230' } });
  expect(within(dialog()).getAllByText(/230\.00/).length).toBeGreaterThan(0);
  create();
  const body = await sent();
  expect([body.amountsAre, body.lines[0]!.unitPrice, body.lines[0]!.vatType]).toEqual(['inclusive', 230, 'standard']);
});

it('a company not registered for VAT: no VAT column or "Amounts are", untyped lines, exclusive', async () => {
  renderPage('none');
  await openAndFill('100');
  expect(screen.queryByRole('combobox', { name: 'VAT type' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Amounts are' })).toBeNull();
  expect(within(dialog()).getByText(/not registered for VAT/)).toBeTruthy();
  create();
  const body = await sent();
  expect(body.amountsAre).toBe('exclusive');
  expect('vatType' in body.lines[0]!).toBe(false);
});

it('holds, as the invoice form does: standard VAT that rounds to nothing is said and nothing is sent', async () => {
  renderPage('bi-monthly');
  await openAndFill('0.03');
  create();
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toMatch(/rounds to nothing/);
  expect(posts()).toHaveLength(0);
});
