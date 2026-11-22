/**
 * Master plan wave 3, PR D review, Q3-Q5: what the invoice form tells a screen reader, and a discount that cannot be
 * hidden while it is charged. A status region only announces a change if it was in the page before the change.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { InvoiceTotals } from '@/components/accounting/customer-invoices/InvoiceTotals';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import { discounts, fillLine, invoiceDate, pickClient, pickMode, price, serve } from '../helpers/invoiceDefaultsHarness';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));

import NewPage from '../../../pages/accounting/customer-invoices/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

const open = async () => { serve(); render(<NewPage />); await screen.findByRole('combobox', { name: 'Client' }); typeDate(invoiceDate(), '1 Oct 2026'); };

describe('InvoiceTotals', () => {
  const card = (typedTotal?: number) => (
    <InvoiceTotals subtotal={26.1} tax={3.92} total={30.02} currencyCode="ZAR" date="2026-10-01" byType={[{ type: 'standard', net: 26.1, vat: 3.92 }]} {...(typedTotal === undefined ? {} : { typedTotal })} />
  );

  it('keeps its status region mounted while there is nothing to say, so the difference is announced when it comes', () => {
    const { rerender } = render(card(30.02));
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    rerender(card(30));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toMatch(/^These prices come to R\s?30\.00 incl\. VAT; the invoice total is R\s?30\.02\.$/);
  });

  it('is mounted outside inclusive too', () => {
    render(card());
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('the totals rows', () => {
  const card = () => <InvoiceTotals subtotal={26.1} tax={3.92} total={30.02} currencyCode="ZAR" date="2026-10-01" byType={[{ type: 'standard', net: 26.1, vat: 3.92 }]} />;
  it('one type: "VAT (15%)"; one VAT-free type names it; mixed types a row each, on its own net', () => {
    const { rerender } = render(card());
    expect(screen.getByRole('region', { name: 'Invoice totals' }).textContent).toMatch(/VAT \(15%\)R\s?3\.92/);
    rerender(<InvoiceTotals subtotal={100} tax={0} total={100} currencyCode="ZAR" date="2026-10-01" byType={[{ type: 'exempt', net: 100, vat: 0 }]} />);
    expect(screen.getByRole('region', { name: 'Invoice totals' }).textContent).toMatch(/VAT \(exempt\)R\s?0\.00/);
    rerender(<InvoiceTotals subtotal={300} tax={15} total={315} currencyCode="ZAR" date="2026-10-01"
      byType={[{ type: 'standard', net: 100, vat: 15 }, { type: 'zero_rated', net: 200, vat: 0 }]} />);
    const t = screen.getByRole('region', { name: 'Invoice totals' }).textContent;
    expect(t).toMatch(/VAT Standard \(15%\) on R\s?100\.00R\s?15\.00/);
    expect(t).toMatch(/VAT Zero-rated \(0%\) on R\s?200\.00R\s?0\.00/);
  });
  it('a line with no VAT type yet says so, never "zero-rated" and never a VAT figure', () => {
    const { rerender } = render(<InvoiceTotals subtotal={50} tax={0} total={50} currencyCode="ZAR" date="2026-10-01" byType={[{ type: null, net: 50, vat: 0 }]} />);
    const text = () => screen.getByRole('region', { name: 'Invoice totals' }).textContent ?? '';
    expect(text()).toMatch(/VAT type needed—/);
    expect(text()).not.toMatch(/zero-rated/i);
    rerender(<InvoiceTotals subtotal={150} tax={15} total={165} currencyCode="ZAR" date="2026-10-01"
      byType={[{ type: 'standard', net: 100, vat: 15 }, { type: null, net: 50, vat: 0 }]} />);
    expect(text()).toMatch(/VAT Standard \(15%\) on R\s?100\.00R\s?15\.00/);
    expect(text()).toMatch(/VAT type needed on R\s?50\.00—/);
    expect(text()).not.toMatch(/zero-rated/i);
  });
  it('a company not registered for VAT: no VAT row at all', () => {
    render(<InvoiceTotals subtotal={100} tax={0} total={100} currencyCode="ZAR" date="2026-10-01" byType={[]} />);
    expect(screen.getByRole('region', { name: 'Invoice totals' }).textContent).not.toMatch(/VAT/);
  });
});

describe('the VAT note', () => {
  it('is in the page before the customer answers, and says where the lines\' type came from once it does', async () => {
    await open();
    const before = screen.getAllByRole('status');
    expect(screen.queryByText(/VAT type from customer/)).toBeNull();
    await pickClient('c-zero');
    const note = await screen.findByText('VAT type from customer: zero-rated');
    const region = note.closest('[role="status"]')!;
    expect(before).toContain(region); // the same region, mounted before it had anything to say
  });
});

describe('Unit price in inclusive mode', () => {
  it('says so in its accessible name, and goes back', async () => {
    await open();
    expect(price().getAttribute('aria-label')).toBe('Unit price');
    await pickMode(/Including VAT/);
    expect(price().getAttribute('aria-label')).toBe('Unit price incl. VAT');
    await pickMode(/Excluding VAT/);
    expect(price().getAttribute('aria-label')).toBe('Unit price');
  });
});

describe('the discount column', () => {
  const toggle = () => screen.getByRole('button', { name: /disc/i }) as HTMLButtonElement;

  it('cannot be hidden while a line carries a discount', async () => {
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    expect(toggle().disabled).toBe(true);
    fireEvent.click(toggle());
    expect(discounts()).toEqual(['10']);
  });

  it('can be hidden again once no line does', async () => {
    await open();
    fireEvent.click(toggle());
    fillLine();
    fireEvent.change(screen.getByLabelText('Discount %'), { target: { value: '5' } });
    expect(toggle().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Discount %'), { target: { value: '' } });
    expect(toggle().disabled).toBe(false);
    fireEvent.click(toggle());
    expect(screen.queryByLabelText('Discount %')).toBeNull();
  });

  it('opens for a discount that lands while it was hidden by hand', async () => {
    await open();
    fireEvent.click(toggle()); // open
    fireEvent.click(toggle()); // hidden by hand
    expect(screen.queryByLabelText('Discount %')).toBeNull();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
  });
});
