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

import { pricesToNothing } from '@/components/accounting/customer-invoices/taxMode';

const push = vi.hoisted(() => vi.fn());
const scan = vi.hoisted(() => ({ current: { vatRate: null as number | null, lineItems: [] as unknown[] } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <button onClick={() => onExtracted({ date: null, dueDate: null, customerName: null, confidence: 0.9, ...scan.current })}>scan stub</button>
  ),
}));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); scan.current = { vatRate: null, lineItems: [] }; });

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
    expect(screen.queryByText(/these prices come to/i)).toBeNull();
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

  it('a rate below 0 converts nothing: the prices stay as they are', async () => {
    await load();
    fireEvent.change(screen.getByLabelText('VAT rate %'), { target: { value: '-5' } });
    await pickMode(/Including VAT/);
    expect(prices()).toEqual(['1000', '500']);
  });

  it('the rate field says what it accepts', async () => {
    await load();
    expect(screen.getByLabelText('VAT rate %').getAttribute('min')).toBe('0');
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

  it('a gross price under a cent cannot be typed: the field refuses the third decimal (the save-path guard is tested on stored data below)', async () => {
    await open();
    await pickMode(/Including VAT/);
    fillLine(0, '115');
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    fillLine(1, '0.004');
    expect(price(1).value).toBe('');
    expect(price(1).getAttribute('aria-invalid')).toBe('true');
  });

  describe('a scan over inclusive', () => {
    const scanNow = async (current: typeof scan.current) => {
      await open();
      await pickMode(/Including VAT/);
      fillLine(0, '115');
      scan.current = current;
      fireEvent.click(screen.getByText('scan stub'));
    };
    const modeShown = () => screen.getByRole('combobox', { name: 'Amounts are' }).textContent;

    it('a rate and no lines: the typed gross stays gross, at the scanned rate', async () => {
      await scanNow({ vatRate: 14, lineItems: [] });
      await screen.findByText(/Auto-filled/);
      expect(modeShown()).toMatch(/Including VAT/);
      expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('14');
      expect(prices()).toEqual(['115']);
      await submitAndWait(push);
      expect(sentPrices('POST')).toEqual([100.88]);
      expect(sentBody('POST').taxRate).toBe(14);
    });

    it('lines and no rate: back to exclusive, and the scanned prices are stored as read', async () => {
      await scanNow({ vatRate: null, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 200 }] });
      await waitFor(() => expect(prices()).toEqual(['200']));
      expect(modeShown()).toMatch(/Excluding VAT/);
      await submitAndWait(push);
      expect(sentPrices('POST')).toEqual([200]);
    });

    it('lines and a rate: back to exclusive at the scanned rate', async () => {
      await scanNow({ vatRate: 14, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 200 }] });
      await waitFor(() => expect(prices()).toEqual(['200']));
      expect(modeShown()).toMatch(/Excluding VAT/);
      await submitAndWait(push);
      expect(sentPrices('POST')).toEqual([200]);
    });

    it('nothing on the scan to change: inclusive stays', async () => {
      await scanNow({ vatRate: null, lineItems: [] });
      await screen.findByText(/Auto-filled/);
      expect(modeShown()).toMatch(/Including VAT/);
      expect(prices()).toEqual(['115']);
    });
  });
});

describe('edit page: a stored invoice at rate 0', () => {
  const ZERO_RATED = { ...TWO_LINES, tax_rate: '0.00' };
  const load = async () => { serve(undefined, ZERO_RATED); render(<EditPage />); await screen.findByDisplayValue('One'); };

  it('loads as No VAT, with the summary and the save unchanged', async () => {
    await load();
    expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/No VAT/);
    expect(summaryOf().getByText('VAT (0%)').parentElement!.textContent).toMatch(/0\.00/);
    expectTotal(/1[ ,\u00a0]?500\.00/);
    await save();
    expect(sentBody('PUT').taxRate).toBe(0);
    expect(sentPrices('PUT')).toEqual([1000, 500]);
  });

  it('leaving No VAT seeds the standard rate, as the new page does, and the prices stay', async () => {
    await load();
    await pickMode(/Excluding VAT/);
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('15');
    expect(prices()).toEqual(['1000', '500']);
    await save();
    expect(sentBody('PUT').taxRate).toBe(15);
    expect(sentPrices('PUT')).toEqual([1000, 500]);
  });

  it('a non-zero rate still loads as Excluding VAT, at its own rate', async () => {
    serve(undefined, { ...TWO_LINES, tax_rate: '14.00' });
    render(<EditPage />);
    await screen.findByDisplayValue('One');
    expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Excluding VAT/);
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('14');
  });
});

// A sub-cent price cannot be typed any more (2 decimals), but a stored one can still be loaded, so the save-path guard stays.
const SUBCENT = { ...TWO_LINES, items: [{ description: 'One', quantity: 1, unit_price: 1000, amount: 1000 }, { description: 'Two', quantity: 1, unit_price: 0.004, amount: 0 }] };

describe('a price under a cent, in any mode', () => {
  it('cannot be typed: the field refuses the third decimal', async () => {
    serve(undefined, TWO_LINES);
    render(<EditPage />);
    await screen.findByDisplayValue('One');
    fireEvent.change(price(1), { target: { value: '0.004' } });
    expect(price(1).value).toBe('500');
    expect(price(1).getAttribute('aria-invalid')).toBe('true');
  });

  it('exclusive, stored: refused, not sent to be stored as nothing', async () => {
    serve(undefined, SUBCENT);
    render(<EditPage />);
    await screen.findByDisplayValue('One');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await screen.findByText('"Two" comes to under a cent - enter a higher price');
    expect(vi.mocked(apiFetch).mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });
});

describe('a gross price too small to survive taking the VAT out', () => {
  // With 2-decimal prices a typed gross of 0.01 or more always survives (0.01 / 2 = 0.005 rounds up), so only a sub-cent
  // gross comes to nothing, and the field refuses that. The rule itself stays pinned here.
  it('edit page, including VAT: a sub-cent gross cannot be typed', async () => {
    serve(undefined, TWO_LINES);
    render(<EditPage />);
    await screen.findByDisplayValue('One');
    await pickMode(/Including VAT/);
    const before = price(1).value;
    fireEvent.change(price(1), { target: { value: '0.004' } });
    expect(price(1).value).toBe(before);
    expect(price(1).getAttribute('aria-invalid')).toBe('true');
  });

  it('pricesToNothing: a gross of 0.004 at 15% is nothing, 0.01 is not', () => {
    expect(pricesToNothing('inclusive', 0.004, 15)).toBe(true);
    expect(pricesToNothing('inclusive', 0.01, 15)).toBe(false);
    expect(pricesToNothing('exclusive', 0.004, 15)).toBe(true);
  });
});
