/**
 * Master plan wave 3, PR D review, Q3-Q5: what the invoice form tells a screen reader, and a discount that cannot be
 * hidden while it is charged. A status region only announces a change if it was in the page before the change.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { InvoiceSummaryCard } from '@/components/accounting/customer-invoices/InvoiceSummaryCard';
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

describe('InvoiceSummaryCard', () => {
  const card = (typedTotal?: number) => (
    <InvoiceSummaryCard subtotal={26.1} tax={3.92} total={30.02} taxRate={15} currencyCode="ZAR" {...(typedTotal === undefined ? {} : { typedTotal })}><span /></InvoiceSummaryCard>
  );

  it('keeps its status region mounted while there is nothing to say, so the difference is announced when it comes', () => {
    const { rerender } = render(card(30.02));
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    rerender(card(30));
    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toMatch(/You typed R\s?30\.00 incl\. VAT/);
  });

  it('is mounted outside inclusive too', () => {
    render(card());
    expect(screen.getByRole('status').textContent).toBe('');
  });
});

describe('the VAT note', () => {
  it('is in the page before the customer answers, and describes the field once it says something', async () => {
    await open();
    const box = screen.getByRole('combobox', { name: 'Amounts are' });
    const region = screen.getAllByRole('status').find((s) => s.closest('.grid') !== null)!;
    expect(region.textContent).toBe('');
    expect(box.hasAttribute('aria-describedby')).toBe(false);
    await pickClient('c-zero');
    await waitFor(() => expect(region.textContent).toMatch(/From customer: zero-rated/));
    expect(box.getAttribute('aria-describedby')).toBe(region.id);
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
