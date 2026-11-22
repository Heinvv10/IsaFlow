/**
 * Master plan wave 3, PR D review, F1: "Amounts are" is a way of reading the prices, not a repricing. Changing it shows
 * the same invoice, so 1000 + 500 at 15% (total 1725) is the same invoice from any mode, on the new and edit pages.
 * Since the per-line VAT writer PR the price goes AS SHOWN with its mode (`amountsAre`), and the server backs an
 * inclusive line's VAT out (1150 + 575 incl. stores net 1000 + 500, VAT 150 + 75, total 1725); both pages send a VAT
 * type per line (the line-level form: there is no form-wide rate) and each line converts at its own type's rate.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import {
  descriptionField, fillLine, invoiceDate, INV, pickClient, pickMode, pickVatType, price, prices, sentBody, serve, submitAndWait, totalRowText, totalsText,
  TWO_LINES, vatTypesShown,
} from '../helpers/invoiceDefaultsHarness';

import { pricesToNothing } from '@/components/accounting/customer-invoices/taxMode';

const push = vi.hoisted(() => vi.fn());
const scan = vi.hoisted(() => ({ current: { vatRate: null as number | null, lineItems: [] as unknown[] } }));
const vatRegistered = vi.hoisted(() => ({ current: true }));
vi.mock('@/hooks/useVatRegistration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useVatRegistration')>()),
  useVatRegistrationOrDefault: () => ({ isRegistered: vatRegistered.current, known: true }),
}));
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
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); scan.current = { vatRate: null, lineItems: [] }; vatRegistered.current = true; });

const expectTotal = (amount: RegExp) => expect(totalRowText()).toMatch(amount);
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

  it('saved while inclusive, the gross prices go as shown with the mode, each line standard', async () => {
    await load();
    await pickMode(/Including VAT/);
    await save();
    expect(sentPrices('PUT')).toEqual([1150, 575]);
    expect(sentBody('PUT').amountsAre).toBe('inclusive');
    expect(sentBody('PUT').items.map((i) => i.vatType)).toEqual(['standard', 'standard']);
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

  it('a line re-typed zero-rated while inclusive keeps its gross as its price, and its VAT goes', async () => {
    await load();
    await pickMode(/Including VAT/);
    await pickVatType(1, /Zero-rated/);
    expect(prices()).toEqual(['1150', '575']);
    expectTotal(/1[ ,\u00a0]?725\.00/);
    await save();
    expect(sentPrices('PUT')).toEqual([1150, 575]);
    expect(sentBody('PUT').items.map((i) => i.vatType)).toEqual(['standard', 'zero_rated']);
    expect(sentBody('PUT').amountsAre).toBe('inclusive');
  });

  it('a discounted line keeps its discount and its price through inclusive', async () => {
    await load({ ...INV, items: [{ description: 'One', quantity: 2, unit_price: 1000, amount: 1800 }] });
    await pickMode(/Including VAT/);
    expect(prices()).toEqual(['1150']);
    await save();
    expect(sentBody('PUT').items[0]).toMatchObject({ unitPrice: 1150, discount: 10 });
    expect(sentBody('PUT').amountsAre).toBe('inclusive');
  });

  it('VAT-free lines convert nothing: their prices stay as they are', async () => {
    await load();
    await pickVatType(0, /Exempt/);
    await pickVatType(1, /Zero-rated/);
    await pickMode(/Including VAT/);
    expect(prices()).toEqual(['1000', '500']);
  });

  it('there is no rate to type: each line\'s type names its rate on the invoice date', async () => {
    await load();
    expect(screen.queryByLabelText('VAT rate %')).toBeNull();
    expect(vatTypesShown()).toEqual(['Standard (15%)', 'Standard (15%)']);
  });

  it('a price retyped while inclusive is taken as gross', async () => {
    await load();
    await pickMode(/Including VAT/);
    fireEvent.change(price(0), { target: { value: '2300' } });
    await save();
    expect(sentPrices('PUT')).toEqual([2300, 575]);
    expect(sentBody('PUT').amountsAre).toBe('inclusive');
  });

  it('a type changed while inclusive holds the gross and moves the VAT inside it', async () => {
    await load();
    await pickMode(/Including VAT/);
    await pickVatType(0, /Exempt/);
    expectTotal(/1[ ,\u00a0]?725\.00/); // 1150 exempt + 575 incl.
    expect(totalsText()).toMatch(/VAT Standard \(15%\) on R\s?500\.00R\s?75\.00/);
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
    expect(sentPrices('POST')).toEqual([1150]);
    expect(sentBody('POST').amountsAre).toBe('inclusive');
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

    const createRefused = async (line: string) => {
      fireEvent.click(screen.getByRole('button', { name: /^create invoice$/i }));
      await screen.findAllByText(`Choose a VAT type for "${line}"`);
      expect(vi.mocked(apiFetch).mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(false);
    };

    it('a rate and no lines: the typed gross stays gross, its line typed by the scanned rate; a rate that gives no VAT type holds Create', async () => {
      await scanNow({ vatRate: 14, lineItems: [] });
      await screen.findByText(/Auto-filled/);
      expect(modeShown()).toMatch(/Including VAT/);
      expect(vatTypesShown()).toEqual(['Choose…']);
      expect(prices()).toEqual(['115']);
      // 14% is not the standard rate on 1 Oct 2026: the server would refuse it, so the page does not send it (#1701).
      await createRefused('Work');
    });

    it('a rate of 0 and no lines: the typed line goes zero-rated', async () => {
      await scanNow({ vatRate: 0, lineItems: [] });
      await screen.findByText(/Auto-filled/);
      expect(vatTypesShown()).toEqual(['Zero-rated (0%)']);
    });

    it('lines and no rate: back to exclusive, and the scanned prices are stored as read', async () => {
      await scanNow({ vatRate: null, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 200 }] });
      await waitFor(() => expect(prices()).toEqual(['200']));
      expect(modeShown()).toMatch(/Excluding VAT/);
      await submitAndWait(push);
      expect(sentPrices('POST')).toEqual([200]);
    });

    it('lines and a rate: back to exclusive at the scanned rate (14: Create holds)', async () => {
      await scanNow({ vatRate: 14, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 200 }] });
      await waitFor(() => expect(prices()).toEqual(['200']));
      expect(modeShown()).toMatch(/Excluding VAT/);
      expect(vatTypesShown()).toEqual(['Choose…']);
      await createRefused('Scanned');
    });

    it('lines and the standard rate: back to exclusive, the scanned prices and rate sent as read', async () => {
      await scanNow({ vatRate: 15, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 200 }] });
      await waitFor(() => expect(prices()).toEqual(['200']));
      expect(modeShown()).toMatch(/Excluding VAT/);
      await submitAndWait(push);
      expect(sentPrices('POST')).toEqual([200]);
      expect(sentBody('POST').taxRate).toBeUndefined();
      expect(sentBody('POST').items.map((i) => i.vatType)).toEqual(['standard']);
      expect(sentBody('POST').amountsAre).toBe('exclusive');
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

  it('loads Excluding VAT with each line zero-rated, the totals and the save unchanged', async () => {
    await load();
    expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Excluding VAT/);
    expect(vatTypesShown()).toEqual(['Zero-rated (0%)', 'Zero-rated (0%)']);
    expect(totalsText()).toMatch(/VAT \(zero-rated\)R\s?0\.00/);
    expectTotal(/1[ ,\u00a0]?500\.00/);
    await save();
    expect(sentBody('PUT').items.map((i) => i.vatType)).toEqual(['zero_rated', 'zero_rated']);
    expect(sentPrices('PUT')).toEqual([1000, 500]);
  });

  it('a line re-typed Standard charges VAT on it alone, and the prices stay', async () => {
    await load();
    await pickVatType(0, /Standard/);
    expect(prices()).toEqual(['1000', '500']);
    expectTotal(/1[ ,\u00a0]?650\.00/);
    await save();
    expect(sentBody('PUT').items.map((i) => i.vatType)).toEqual(['standard', 'zero_rated']);
    expect(sentPrices('PUT')).toEqual([1000, 500]);
  });

  it('a legacy 14% header (neither the standard rate nor 0) loads its lines asking for a type, and Save holds', async () => {
    serve(undefined, { ...TWO_LINES, tax_rate: '14.00' });
    render(<EditPage />);
    await screen.findByDisplayValue('One');
    expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Excluding VAT/);
    expect(vatTypesShown()).toEqual(['Choose…', 'Choose…']);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText('Choose a VAT type for "One"')).toBeTruthy();
    expect(vi.mocked(apiFetch).mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false);
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
  // With 2-decimal prices a typed typed price of 0.01 or more is a cent or more, so only a sub-cent
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

  it('pricesToNothing (the invoice sends a price as typed in every mode): 0.004 is nothing, 0.01 is not', () => {
    expect(pricesToNothing(0.004)).toBe(true);
    expect(pricesToNothing(0.01)).toBe(false);
    expect(pricesToNothing(0)).toBe(false);
  });
});

describe('#1701 review: a mode change never reprices', () => {
  const openNew = async () => { serve(); render(<NewPage />); await screen.findByRole('combobox', { name: 'Client' }); typeDate(invoiceDate(), '1 Oct 2026'); await pickClient('c-bare'); };
  const modeShown = () => screen.getByRole('combobox', { name: 'Amounts are' }).textContent;
  const MIXED = { ...INV, items: [
    { description: 'Fee', quantity: 1, unit_price: 100, amount: 100, tax_amount: 15, vat_type: 'standard' },
    { description: 'Rent', quantity: 1, unit_price: 100, amount: 100, tax_amount: 0, vat_type: 'exempt' },
  ] };

  it('edit page: a mixed draft goes inclusive line by line, R215 before and after, and saves the exempt line at R100', async () => {
    serve(undefined, MIXED); render(<EditPage />); await screen.findByDisplayValue('Fee');
    expectTotal(/215\.00/);
    await pickMode(/Including VAT/);
    expect(prices()).toEqual(['115', '100']);
    expectTotal(/215\.00/);
    await save();
    expect(sentPrices('PUT')).toEqual([115, 100]);
    expect(sentBody('PUT').items.map((i) => i.vatType)).toEqual(['standard', 'exempt']);
  });

  it('new page: 1 000 x R0.03 is refused going inclusive, saying why, and nothing changes', async () => {
    await openNew();
    fillLine(0, '0.03', '1000');
    await pickMode(/Including VAT/);
    await screen.findByText(/^Switching to Including VAT would change "Work" from R\s?34\.50 to R\s?30\.00/);
    expect(modeShown()).toMatch(/Excluding VAT/);
    expect(prices()).toEqual(['0.03']);
    expectTotal(/34\.50/);
  });

  it('edit page: the same refusal, so autosave has nothing repriced to send', async () => {
    serve(undefined, { ...INV, items: [{ description: 'Screws', quantity: 1000, unit_price: 0.03, amount: 30 }] });
    render(<EditPage />); await screen.findByDisplayValue('Screws');
    await pickMode(/Including VAT/);
    await screen.findByText(/^Switching to Including VAT would change "Screws" from R\s?34\.50 to R\s?30\.00/);
    expect(modeShown()).toMatch(/Excluding VAT/);
    expect(prices()).toEqual(['0.03']);
    expectTotal(/34\.50/);
  });

  it('new page, a company not registered for VAT: no choice, R100 is not grossed up, and R100 is sent', async () => {
    vatRegistered.current = false;
    await openNew();
    fillLine(0, '100');
    expect(screen.queryByRole('combobox', { name: 'Amounts are' })).toBeNull();
    expect(prices()).toEqual(['100']);
    await submitAndWait(push);
    expect(sentPrices('POST')).toEqual([100]);
  });

  it('edit page, a company not registered for VAT: no choice, the stored prices saved as they are', async () => {
    vatRegistered.current = false;
    serve(undefined, TWO_LINES); render(<EditPage />); await screen.findByDisplayValue('One');
    expect(screen.queryByRole('combobox', { name: 'Amounts are' })).toBeNull();
    expect(vatTypesShown()).toEqual([]);
    expect(prices()).toEqual(['1000', '500']);
    await save();
    expect(sentPrices('PUT')).toEqual([1000, 500]);
  });

  it('edit page: an inclusive draft at 0% keeps its exempt line; a new R115 line shows its type, and picked zero-rated carries no VAT', async () => {
    serve(undefined, { ...INV, tax_rate: '0.00', amounts_are: 'inclusive', items: [{ description: 'Rent', quantity: 1, unit_price: 200, amount: 200, tax_amount: 0, vat_type: 'exempt' }] });
    render(<EditPage />); await screen.findByDisplayValue('Rent');
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    fireEvent.change(descriptionField(1), { target: { value: 'New' } });
    fireEvent.change(price(1), { target: { value: '115' } });
    expect(vatTypesShown()).toEqual(['Exempt', 'Standard (15%)']);
    await pickVatType(1, /Zero-rated/);
    expectTotal(/315\.00/);
    expect(totalsText()).toMatch(/VAT Zero-rated \(0%\) on R\s?115\.00R\s?0\.00/);
    await save();
    expect(sentBody('PUT').items.map((i) => i.vatType)).toEqual(['exempt', 'zero_rated']);
    expect(sentPrices('PUT')).toEqual([200, 115]);
  });
});
