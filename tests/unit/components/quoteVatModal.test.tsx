/**
 * Audit 11 Nov 2026 item 5: the New Quote modal sent `taxRate: 15` on every line and previewed subtotal x 0.15,
 * whatever the company or the user chose. Real page; only the network is scripted.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    if (init?.method === 'POST') return json({ success: true, data: {} });
    if (String(url).startsWith('/api/accounting/customers')) return json({ success: true, data: [{ id: 'c1', name: 'Acme' }] });
    return json({ success: true, data: { quotes: [], total: 0 } });
  });
});
afterEach(() => { cleanup(); });

const sentLines = async () => {
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  return (JSON.parse(String(call[1]?.body)) as { lines: Array<{ unitPrice: number; taxRate: number }> }).lines;
};

function renderPage(vatPeriod?: string) {
  const page = <QuotesPage />;
  return render(vatPeriod === undefined ? page : (
    <CompanyContext.Provider value={{ activeCompany: { id: 'co-1', vatPeriod }, loading: false } as never}>{page}</CompanyContext.Provider>
  ));
}

/** Opens the modal and types one line: "Widget", 1 at `price`. */
async function openAndFill(price: string) {
  fireEvent.click((await screen.findAllByRole('button', { name: /New Quote/i }))[0]!);
  const select = screen.getAllByRole('combobox').find((s) => s.querySelector('option[value=""]')?.textContent?.includes('Select a customer'))!;
  await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: 'c1' } });
  fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Widget' } });
  const priceInput = screen.getAllByRole('spinbutton').find((i) => (i as HTMLInputElement).step === '0.01')!;
  fireEvent.change(priceInput, { target: { value: price } });
}
const create = () => fireEvent.click(screen.getAllByRole('button', { name: /Create Quote/i }).at(-1)!);

it('default: a registered company quotes at 15% and shows the VAT', async () => {
  renderPage('bi-monthly');
  await openAndFill('100');
  expect(screen.getByText(/VAT 15%/)).toBeTruthy();
  create();
  expect(await sentLines()).toEqual([expect.objectContaining({ unitPrice: 100, taxRate: 15 })]);
});

it('a company that is not VAT registered sends rate 0 and shows no VAT row', async () => {
  renderPage('none');
  await openAndFill('100');
  expect(screen.queryByText(/VAT 15%/)).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Amounts are' })).toBeNull();
  expect(screen.getByText(/not VAT registered/)).toBeTruthy();
  create();
  expect(await sentLines()).toEqual([expect.objectContaining({ unitPrice: 100, taxRate: 0 })]);
});

it('a registered company choosing No VAT sends 0', async () => {
  renderPage('bi-monthly');
  await openAndFill('100');
  await pickOption('Amounts are', /No VAT/);
  expect(screen.queryByText(/VAT 15%/)).toBeNull();
  create();
  expect(await sentLines()).toEqual([expect.objectContaining({ unitPrice: 100, taxRate: 0 })]);
});

it('Including VAT sends the ex-VAT price', async () => {
  renderPage();
  await openAndFill('100');
  await pickOption('Amounts are', /Including VAT/); // the shown R100 ex becomes R115 incl
  fireEvent.change(screen.getAllByRole('spinbutton').find((i) => (i as HTMLInputElement).step === '0.01')!, { target: { value: '230' } });
  create();
  expect(await sentLines()).toEqual([expect.objectContaining({ unitPrice: 200, taxRate: 15 })]);
});
