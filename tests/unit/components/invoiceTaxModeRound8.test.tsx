/**
 * #1701 round 8, the gate's examples on the invoice pages:
 * (2) a mixed draft (R100 standard + R100 exempt, R215) switched to Including VAT converts each line at its OWN rate:
 *     115 + 100, still R215 (the header rate repriced the exempt line to 115 and autosave stored R230).
 * (3) a switch that would change a line's total (1,000 x R0.03 excl. is R34.50; R0.0345 rounds to R0.03 = R30.00) is
 *     refused: the prices and the mode stay, and the page says why.
 * (4) a company not registered for VAT is offered No VAT only, so nothing converts its prices (R100 went to R115 and
 *     was saved as net).
 * (5) an inclusive draft stored at 0% reloads at 0%: a line added to it is not standard-rated.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fillLine, INV, pickMode, price, prices, sentBody, serve } from '../helpers/invoiceDefaultsHarness';
import { typeDate } from '../helpers/dateFields';
import { openCombobox, pickOption } from '../helpers/kitPick';

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

const totalText = () => within(screen.getByText('Invoice Summary').closest('.rounded-2xl') as HTMLElement).getByText('Total').parentElement!.textContent;
const modeShown = () => (screen.getByRole('combobox', { name: 'Amounts are' }) as HTMLElement).textContent;
const save = async () => {
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
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
    expect(await screen.findByText(/Switching to Including VAT would change "Tiny" from R34\.50 to R30\.00/)).toBeTruthy();
    expect(prices()).toEqual(['0.03']);
    expect(modeShown()).toMatch(/Excluding VAT/);
    expect(totalText()).toMatch(/34\.50/);
  });
  it('new page: the same line typed is refused the same way', async () => {
    serve();
    render(<NewPage />);
    fillLine(0, '0.03', '1000');
    await pickMode(/Including VAT/);
    expect(await screen.findByText(/would change "Work" from R34\.50 to R30\.00/)).toBeTruthy();
    expect(prices()).toEqual(['0.03']);
  });
});

describe('(4) a company not registered for VAT is offered No VAT only', () => {
  const options = async () => { openCombobox('Amounts are'); return (await screen.findAllByRole('option')).map((o) => o.textContent); };
  it('new page: only No VAT; R100 stays R100', async () => {
    reg.isRegistered = false;
    serve();
    render(<NewPage />);
    fillLine(0, '100');
    expect(await options()).toEqual(['No VAT']);
    expect(prices()).toEqual(['100']);
    expect(totalText()).toMatch(/100\.00/);
  });
  it('edit page: only No VAT, and the shown mode is No VAT', async () => {
    reg.isRegistered = false;
    serve(undefined, { ...INV, tax_rate: 0, items: [{ description: 'L', quantity: 1, unit_price: 100, amount: 100 }] });
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    expect(modeShown()).toMatch(/No VAT/);
    expect(await options()).toEqual(['No VAT']);
  });
});

describe('(5) an inclusive draft stored at 0% keeps its zero rate', () => {
  it('a line added for R115 carries no VAT and goes zero-rated', async () => {
    serve(undefined, { ...INV, tax_rate: 0, amounts_are: 'inclusive', total_amount: 100,
      items: [{ description: 'Zero', quantity: 1, unit_price: 100, amount: 100, tax_rate: 0, vat_type: 'zero_rated', tax_amount: 0 }] });
    render(<EditPage />);
    await screen.findByDisplayValue('Zero');
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    fireEvent.change(screen.getAllByPlaceholderText('Item description')[1]!, { target: { value: 'New' } });
    fireEvent.change(price(1), { target: { value: '115' } });
    expect(totalText()).toMatch(/215\.00/);
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
    expect(alert.textContent).toMatch(/^Switching to Including VAT would change "Tiny" from R34\.50 to R30\.00/);
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
    await pickMode(/No VAT/);
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
  it('a change of the form rate clears it', async () => {
    await refusedOnEdit();
    fireEvent.change(screen.getByLabelText('VAT rate %'), { target: { value: '0' } });
    await gone();
  });
  it('a change of the invoice date clears it', async () => {
    await refusedOnEdit();
    typeDate(screen.getByLabelText(/^Invoice date/), '16 Sep 2026');
    await gone();
  });
  it('new page: a customer\'s defaults landing (a zero-rated one moves the mode to No VAT) clear it', async () => {
    serve();
    render(<NewPage />);
    fillLine(0, '0.03', '1000');
    await pickMode(/Including VAT/);
    await screen.findByText(/Switching to Including VAT would change "Work"/);
    await pickOption('Client', 'c-zero');
    await gone();
    await waitFor(() => expect(modeShown()).toMatch(/No VAT/));
  });
});
