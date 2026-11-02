/**
 * The quote and sales-order forms drop blank lines before they send. A refusal that says "Line 3" must still mean the
 * third row on the screen, so each sent line carries the number it had in the full list (lineNo).
 * Real pages; only the network is scripted.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { apiFetch } from '@/lib/apiFetch';
import QuotesPage from '@/../pages/accounting/customer-quotes/index';
import SalesOrdersPage from '@/../pages/accounting/customer-sales-orders/index';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'POST') return json({ success: true, data: {} });
    if (path.startsWith('/api/accounting/customers')) return json({ success: true, data: [{ id: 'c1', name: 'Acme' }] });
    return json({ success: true, data: { quotes: [], orders: [], total: 0 } });
  });
});
afterEach(() => { cleanup(); });

const posted = () => {
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST');
  return JSON.parse(String(call?.[1]?.body)) as Record<string, Array<Record<string, unknown>>>;
};

/** Four rows on screen: blank, "Bravo", blank, "Delta". */
async function openAndFill(newLabel: RegExp, customerSelector: () => HTMLElement) {
  fireEvent.click((await screen.findAllByRole('button', { name: newLabel }))[0]!);
  const select = customerSelector();
  await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: 'c1' } });
  const add = screen.getByRole('button', { name: /Add line/i });
  fireEvent.click(add); fireEvent.click(add); fireEvent.click(add);
  const desc = () => screen.getAllByPlaceholderText('Item description');
  expect(desc()).toHaveLength(4);
  fireEvent.change(desc()[1]!, { target: { value: 'Bravo' } });
  fireEvent.change(desc()[3]!, { target: { value: 'Delta' } });
}

it('quote: lines sent are numbered by their place on the form, not among the survivors', async () => {
  render(<QuotesPage />);
  await openAndFill(/New Quote/i, () => screen.getAllByRole('combobox').find((s) => s.querySelector('option[value=""]')?.textContent?.includes('Select a customer'))!);
  fireEvent.click(screen.getAllByRole('button', { name: /Create Quote/i }).at(-1)!); // the modal's, last in the DOM
  await waitFor(() => expect(posted().lines).toBeDefined());
  expect(posted().lines.map((l) => [l.description, l.lineNo])).toEqual([['Bravo', 2], ['Delta', 4]]);
});

it('sales order: lines sent are numbered by their place on the form, not among the survivors', async () => {
  render(<SalesOrdersPage />);
  await openAndFill(/New Sales Order/i, () => screen.getAllByRole('combobox')[0]!);
  fireEvent.click(screen.getAllByRole('button', { name: /^Create/i }).at(-1)!); // the modal's, last in the DOM
  await waitFor(() => expect(posted().items).toBeDefined());
  expect(posted().items.map((l) => [l.description, l.lineNo])).toEqual([['Bravo', 2], ['Delta', 4]]);
});
