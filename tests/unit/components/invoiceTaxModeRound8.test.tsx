/**
 * #1701 round 8, the gate's examples on the invoice pages:
 * (2) a mixed draft (R100 standard + R100 exempt, R215) switched to Including VAT converts each line at its OWN rate:
 *     115 + 100, still R215 (the header rate repriced the exempt line to 115 and autosave stored R230).
 * (3) a switch that would change a line's total (1,000 x R0.03 excl. is R34.50; R0.0345 rounds to R0.03 = R30.00) is
 *     refused: the prices and the mode stay, and the page says why.
 * (4) a company not registered for VAT is offered no choice (No VAT, no VAT column), so nothing converts its prices
 *     (R100 went to R115 and was saved as net).
 * (5) an inclusive draft stored at 0% reloads with its own line types; a line added to it shows the type it takes (the
 *     customer's default chain) and the user's pick is what saves.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fillLine, INV, pickMode, pickVatType, price, prices, sentBody, serve, totalRowText, vatTypesShown } from '../helpers/invoiceDefaultsHarness';
import { typeDate } from '../helpers/dateFields';
import { clickWhenEnabled, pickOption } from '../helpers/kitPick';

const push = vi.hoisted(() => vi.fn());
const reg = vi.hoisted(() => ({ isRegistered: true }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/hooks/useVatRegistration', async (orig) => ({
  ...(await orig<typeof import('@/hooks/useVatRegistration')>()),
  useVatRegistrationOrDefault: () => ({ isRegistered: reg.isRegistered, known: true }),
}));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); reg.isRegistered = true; });

const totalText = totalRowText;
const modeShown = () => (screen.getByRole('combobox', { name: 'Amounts are' }) as HTMLElement).textContent;
const save = async () => {
  await clickWhenEnabled(/save changes/i); // a line that follows the customer: Save waits for its answer
  await waitFor(() => expect(push).toHaveBeenCalled());
};
const MIXED = { ...INV, items: [
  { description: 'Std', quantity: 1, unit_price: 100, amount: 100, tax_rate: 15, vat_type: 'standard', tax_amount: 15 },
  { description: 'Ex', quantity: 1, unit_price: 100, amount: 100, tax_rate: 0, vat_type: 'exempt', tax_amount: 0 },
], total_amount: 215 };

describe('(2) a mixed draft switched to Including VAT converts each line at its own rate', () => {
  it('R100 standard + R100 exempt: 115 + 100, still R215, and saves those prices with each line\'s type', async () => {
    serve(undefined, MIXED);
    render(<EditPage />);
    await screen.findByDisplayValue('Ex');
    await pickMode(/Including VAT/);
    expect(prices()).toEqual(['115', '100']);
    expect(totalText()).toMatch(/215\.00/);
    await save();
    const put = sentBody('PUT');
    expect(put.items.map((i) => [i.unitPrice, i.vatType])).toEqual([[115, 'standard'], [100, 'exempt']]);
    expect(put.amountsAre).toBe('inclusive');
  });
});

describe('(3) a switch that would change a line\'s total is refused', () => {
  it('edit page: 1,000 x R0.03 (R34.50) to Including VAT stays exclusive at R0.03 and says why', async () => {
    serve(undefined, { ...INV, items: [{ description: 'Tiny', quantity: 1000, unit_price: 0.03, amount: 30, tax_rate: 15, vat_type: 'standard', tax_amount: 4.5 }], total_amount: 34.5 });
    render(<EditPage />);
    await screen.findByDisplayValue('Tiny');
    await pickMode(/Including VAT/);
    expect(await screen.findByText(/Switching to Including VAT would change "Tiny" from R\s?34\.50 to R\s?30\.00/)).toBeTruthy();
    expect(prices()).toEqual(['0.03']);
    expect(modeShown()).toMatch(/Excluding VAT/);
    expect(totalText()).toMatch(/34\.50/);
  });
  it('new page: the same line typed is refused the same way', async () => {
    serve();
    render(<NewPage />);
    fillLine(0, '0.03', '1000');
    await pickMode(/Including VAT/);
    expect(await screen.findByText(/would change "Work" from R\s?34\.50 to R\s?30\.00/)).toBeTruthy();
    expect(prices()).toEqual(['0.03']);
  });
});

describe('(4) a company not registered for VAT: No VAT, no choice', () => {
  const noChoice = () => {
    expect(screen.queryByRole('combobox', { name: 'Amounts are' })).toBeNull();
    expect(vatTypesShown()).toEqual([]); // no VAT column
    expect(screen.getByText('No VAT: this company is not registered for VAT.')).toBeTruthy();
  };
  it('new page: no "Amounts are", no VAT column; R100 stays R100 and Create sends no VAT', async () => {
    reg.isRegistered = false;
    serve();
    render(<NewPage />);
    fillLine(0, '100');
    noChoice();
    expect(prices()).toEqual(['100']);
    expect(totalText()).toMatch(/100\.00/);
    expect(screen.getByRole('region', { name: 'Invoice totals' }).textContent).not.toMatch(/VAT/);
    await pickOption('Client', 'c-acme');
    const create = screen.getByRole('button', { name: /^create invoice$/i }) as HTMLButtonElement;
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = sentBody('POST');
    expect([body.taxRate, body.amountsAre, body.items.map((i) => i.vatType)]).toEqual([0, 'exclusive', [undefined]]);
  });
  it('edit page: no choice either, and Save sends the header 0 with untyped lines', async () => {
    reg.isRegistered = false;
    serve(undefined, { ...INV, tax_rate: 0, items: [{ description: 'L', quantity: 1, unit_price: 100, amount: 100 }] });
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    noChoice();
    await save();
    const put = sentBody('PUT');
    expect([put.taxRate, put.items.map((i) => i.vatType)]).toEqual([0, [undefined]]);
  });
});

describe('(5) an inclusive draft stored at 0% keeps its own line types', () => {
  it('a line added for R115 shows the type it takes (standard, the customer\'s); picked zero-rated it carries no VAT', async () => {
    serve(undefined, { ...INV, tax_rate: 0, amounts_are: 'inclusive', total_amount: 100,
      items: [{ description: 'Zero', quantity: 1, unit_price: 100, amount: 100, tax_rate: 0, vat_type: 'zero_rated', tax_amount: 0 }] });
    render(<EditPage />);
    await screen.findByDisplayValue('Zero');
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    fireEvent.change(screen.getAllByPlaceholderText('Item description')[1]!, { target: { value: 'New' } });
    fireEvent.change(price(1), { target: { value: '115' } });
    expect(vatTypesShown()).toEqual(['Zero-rated (0%)', 'Standard (15%)']);
    expect(totalText()).toMatch(/215\.00/); // inclusive: the R115 is its gross either way
    expect(screen.getByRole('region', { name: 'Invoice totals' }).textContent).toMatch(/VAT Standard \(15%\) on R\s?100\.00R\s?15\.00/);
    await pickVatType(1, /Zero-rated/);
    expect(totalText()).toMatch(/215\.00/);
    expect(screen.getByRole('region', { name: 'Invoice totals' }).textContent).toMatch(/VAT \(zero-rated\)R\s?0\.00/);
    await save();
    expect(sentBody('PUT').items.map((i) => [i.unitPrice, i.vatType])).toEqual([[100, 'zero_rated'], [115, 'zero_rated']]);
  });
});

describe('(round 9) the refusal is said by the selector, and clears', () => {
  const describedBy = () => screen.getByRole('combobox', { name: 'Amounts are' }).getAttribute('aria-describedby') ?? '';
  it('edit page: role=alert next to "Amounts are", described by it, scrolled into view; a line edit clears it', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    serve(undefined, { ...INV, items: [{ description: 'Tiny', quantity: 1000, unit_price: 0.03, amount: 30, tax_rate: 15, vat_type: 'standard', tax_amount: 4.5 }], total_amount: 34.5 });
    render(<EditPage />);
    await screen.findByDisplayValue('Tiny');
    await pickMode(/Including VAT/);
    await screen.findByText(/Switching to Including VAT would change "Tiny"/);
    const alert = screen.getAllByRole('alert').find((a) => /Switching to Including VAT/.test(a.textContent ?? ''))!;
    expect(alert.textContent).toMatch(/^Switching to Including VAT would change "Tiny" from R\s?34\.50 to R\s?30\.00/);
    expect(describedBy().split(' ')).toContain(alert.id);
    expect(scrolled).toHaveBeenCalled();
    fireEvent.change(price(0), { target: { value: '0.04' } });
    await waitFor(() => expect(screen.queryByText(/Switching to Including VAT would change/)).toBeNull());
  });
  it('new page: a later switch that goes through clears it', async () => {
    serve();
    render(<NewPage />);
    fillLine(0, '0.03', '1000');
    await pickMode(/Including VAT/);
    await screen.findByText(/Switching to Including VAT would change "Work"/);
    fireEvent.change(screen.getAllByLabelText('Quantity')[0]!, { target: { value: '1' } });
    await waitFor(() => expect(screen.queryByText(/Switching to Including VAT would change/)).toBeNull());
    await pickMode(/Including VAT/);
    expect(prices()).toEqual(['0.03']);
    await pickMode(/Excluding VAT/);
    expect(screen.queryByText(/would change/)).toBeNull();
  });
});

describe('(round 10) the held refusal is dropped for good when anything it was decided on changes', () => {
  const refusedOnEdit = async () => {
    serve(undefined, { ...INV, items: [{ description: 'Tiny', quantity: 1000, unit_price: 0.03, amount: 30, tax_rate: 15, vat_type: 'standard', tax_amount: 4.5 }], total_amount: 34.5 });
    render(<EditPage />);
    await screen.findByDisplayValue('Tiny');
    await pickMode(/Including VAT/);
    await screen.findByText(/Switching to Including VAT would change "Tiny"/);
  };
  const gone = () => waitFor(() => expect(screen.queryByText(/Switching to Including VAT would change/)).toBeNull());
  it('an edit back to the old figures does not bring it back', async () => {
    await refusedOnEdit();
    fireEvent.change(price(0), { target: { value: '0.04' } });
    await gone();
    fireEvent.change(price(0), { target: { value: '0.03' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Switching to Including VAT would change/)).toBeNull();
  });
  it('a change of a line\'s VAT type clears it', async () => {
    await refusedOnEdit();
    await pickVatType(0, /Exempt/);
    await gone();
  });
  it('a change of the invoice date clears it', async () => {
    await refusedOnEdit();
    typeDate(screen.getByLabelText(/^Invoice date/), '16 Sep 2026');
    await gone();
  });
  it('new page: a customer\'s defaults landing (a zero-rated one re-types the lines) clear it', async () => {
    serve();
    render(<NewPage />);
    fillLine(0, '0.03', '1000');
    await pickMode(/Including VAT/);
    await screen.findByText(/Switching to Including VAT would change "Work"/);
    await pickOption('Client', 'c-zero');
    await gone();
    await waitFor(() => expect(vatTypesShown()).toEqual(['Zero-rated (0%)']));
    expect(modeShown()).toMatch(/Excluding VAT/);
  });
});

describe('(round 11) a LEGACY mixed-rate draft on the edit page', () => {
  it('R100 at 15% + R100 at 0% loads at R215 and an unchanged save keeps it (it repriced to R230)', async () => {
    serve(undefined, { ...INV, total_amount: 215, items: [
      { description: 'Std', quantity: 1, unit_price: 100, amount: 100, tax_rate: 15 },
      { description: 'Zero', quantity: 1, unit_price: 100, amount: 100, tax_rate: 0 },
    ] });
    render(<EditPage />);
    await screen.findByDisplayValue('Zero');
    expect(totalText()).toMatch(/215\.00/);
    expect(screen.queryByText(/these lines price to/)).toBeNull();
    await save();
    expect(sentBody('PUT').items.map((i) => [i.unitPrice, i.vatType])).toEqual([[100, 'standard'], [100, 'zero_rated']]);
  });
});

describe('(follow-up, gate nit) a legacy line at a rate that is neither 0 nor the standard rate (14% under a 15% header)', () => {
  it('loads untyped and prices at the form rate, so the stale-priced hold shows both figures and autosave holds it (no silent reprice)', async () => {
    serve(undefined, { ...INV, tax_rate: 15, total_amount: 114, items: [{ description: 'Old', quantity: 1, unit_price: 100, amount: 100, tax_rate: 14 }] });
    render(<EditPage />);
    await screen.findByDisplayValue('Old');
    expect(await screen.findByText(/Stored total R\s?114\.00; these lines price to R\s?115\.00/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Notes or payment instructions/), { target: { value: 'edited' } });
    await new Promise((r) => setTimeout(r, 1600));
    expect(vi.mocked(apiFetch).mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PUT')).toBe(false);
  });
});
