/**
 * Master plan wave 3, PR D review, F1: "Amounts are" is a way of reading the prices, not a repricing. Changing it shows
 * the same invoice, so 1000 + 500 at 15% (total 1725) still saves as 1000 + 500 from any mode, on the new and edit pages.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import {
  fillLine, invoiceDate, INV, pickClient, pickMode, price, prices, sentBody, serve, submitAndWait, TWO_LINES,
} from '../helpers/invoiceDefaultsHarness';

const push = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); });

const summaryOf = () => within(screen.getByText('Invoice Summary').closest('.rounded-2xl') as HTMLElement);
const expectTotal = (amount: RegExp) => expect(summaryOf().getByText('Total').parentElement!.textContent).toMatch(amount);
const save = async () => {
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
  await waitFor(() => expect(push).toHaveBeenCalled());
};
const sentPrices = (method: string) => sentBody(method).items.map((i) => i.unitPrice);

describe('edit page: 1000 + 500 at 15%', () => {
  const load = async (invoice: object = TWO_LINES) => { serve(undefined, invoice); render(<EditPage />); await screen.findByDisplayValue('One'); };

  it('shows the same invoice including VAT: 1150 + 575, total 1725, no difference to report', async () => {
    await load();
    await pickMode(/Including VAT/);
    expect(prices()).toEqual(['1150', '575']);
    expectTotal(/1[ , ]?725\.00/);
    expect(screen.queryByText(/you typed/i)).toBeNull();
  });

  it('saved while inclusive, the stored prices and rate are unchanged', async () => {
    await load();
    await pickMode(/Including VAT/);
    await save();
    expect(sentPrices('PUT')).toEqual([1000, 500]);
    expect(sentBody('PUT').taxRate).toBe(15);
  });

  it('switched to inclusive and back, the prices are the stored ones and save unchanged', async () => {
    await load();
    await pickMode(/Including VAT/);
    await pickMode(/Excluding VAT/);
    expect(prices()).toEqual(['1000', '500']);
    expectTotal(/1[ , ]?725\.00/);
    await save();
    expect(sentPrices('PUT')).toEqual([1000, 500]);
  });

  it('out of inclusive to No VAT is the stored price at rate 0, as from exclusive', async () => {
    await load();
    await pickMode(/Including VAT/);
    await pickMode(/No VAT/);
    expect(prices()).toEqual(['1000', '500']);
    await save();
    expect(sentPrices('PUT')).toEqual([1000, 500]);
    expect(sentBody('PUT').taxRate).toBe(0);
  });

  it('a discounted line keeps its discount and its price through inclusive', async () => {
    await load({ ...INV, items: [{ description: 'One', quantity: 2, unit_price: 1000, amount: 1800 }] });
    await pickMode(/Including VAT/);
    expect(prices()).toEqual(['1150']);
    await save();
    expect(sentBody('PUT').items[0]).toMatchObject({ unitPrice: 1000, discount: 10 });
  });

  it('a price retyped while inclusive is taken as gross', async () => {
    await load();
    await pickMode(/Including VAT/);
    fireEvent.change(price(0), { target: { value: '2300' } });
    await save();
    expect(sentPrices('PUT')).toEqual([2000, 500]);
  });

  it('a rate changed while inclusive holds the gross and moves the VAT inside it', async () => {
    await load();
    await pickMode(/Including VAT/);
    fireEvent.change(screen.getByLabelText('VAT rate %'), { target: { value: '0' } });
    await save();
    expect(sentPrices('PUT')).toEqual([1150, 575]);
  });
});

describe('new page', () => {
  const open = async () => { serve(); render(<NewPage />); await screen.findByRole('combobox', { name: 'Client' }); typeDate(invoiceDate(), '1 Oct 2026'); await pickClient('c-bare'); };

  it('typed exclusive, then switched to inclusive, keeps what was typed and saves it', async () => {
    await open();
    fillLine(0, '1000');
    await pickMode(/Including VAT/);
    expect(prices()).toEqual(['1150']);
    await submitAndWait(push);
    expect(sentPrices('POST')).toEqual([1000]);
  });

  it('typed inclusive, then switched to exclusive, shows the ex-VAT price and saves it', async () => {
    await open();
    await pickMode(/Including VAT/);
    fillLine(0, '1150');
    await pickMode(/Excluding VAT/);
    expect(prices()).toEqual(['1000']);
    await submitAndWait(push);
    expect(sentPrices('POST')).toEqual([1000]);
  });
});
