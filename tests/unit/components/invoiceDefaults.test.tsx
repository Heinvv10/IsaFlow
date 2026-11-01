/**
 * Master plan wave 3, PR D: the new-invoice page takes its due date and line discount from the customer, and never over
 * what the user typed. "+30" counts from the invoice date, not from today. VAT mode: invoiceTaxModePages.test.tsx.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import {
  ACME, contactCalls, discounts, due, fillLine, hintFromCustomer, invoiceDate, pickClient, sentBody, serve, submitAndWait,
} from '../helpers/invoiceDefaultsHarness';

const push = vi.hoisted(() => vi.fn());
const scan = vi.hoisted(() => ({ current: { dueDate: null as string | null, vatRate: null as number | null, lineItems: [] as unknown[] } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <button onClick={() => onExtracted({ date: null, customerName: null, confidence: 0.9, ...scan.current })}>scan stub</button>
  ),
}));

import NewPage from '../../../pages/accounting/customer-invoices/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); scan.current = { dueDate: null, vatRate: null, lineItems: [] }; });

const open = async () => { render(<NewPage />); await screen.findByRole('combobox', { name: 'Client' }); typeDate(invoiceDate(), '1 Oct 2026'); };
const submit = () => submitAndWait(push);

describe('due date from the customer', () => {
  it('terms of 30 days set Due, with a hint', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
    expect(screen.getByText('Customer terms: 30 days')).toBeTruthy();
  });

  it('follows the invoice date until the user edits it', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
    typeDate(invoiceDate(), '10 Oct 2026');
    await waitFor(() => expect(due().value).toBe('09 Nov 2026'));
  });

  it('a typed Due is not overwritten, by the invoice date or by another customer', async () => {
    serve();
    await open();
    typeDate(due(), '20 Oct 2026');
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10'])); // the customer's answer has landed
    expect(due().value).toBe('20 Oct 2026');
    typeDate(invoiceDate(), '2 Oct 2026');
    expect(due().value).toBe('20 Oct 2026');
    expect(screen.queryByText(/customer terms/i)).toBeNull();
  });

  it('a Due the user cleared stays clear', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
    typeDate(due(), '');
    typeDate(invoiceDate(), '2 Oct 2026');
    expect(due().value).toBe('');
  });

  it('a Due that came from a scan is not overwritten', async () => {
    serve();
    await open();
    scan.current = { ...scan.current, dueDate: '2026-12-25' };
    fireEvent.click(screen.getByText('scan stub'));
    await waitFor(() => expect(due().value).toBe('25 Dec 2026'));
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10'])); // the customer's answer has landed
    expect(due().value).toBe('25 Dec 2026');
  });

  it('a Due the field refused counts as touched', async () => {
    serve();
    await open();
    typeDate(due(), 'not a date');
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10'])); // the customer's answer has landed
    expect(due().value).toBe('not a date');
    expect(screen.queryByText(/customer terms/i)).toBeNull();
  });

  it('typing in Due counts as touched before it is committed: the default does not land under the cursor', async () => {
    const slow: { release?: () => void } = {};
    serve();
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=c-acme')) await new Promise<void>((r) => { slow.release = r; });
      return inner(url, init);
    });
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(slow.release).toBeTruthy());
    fireEvent.input(due(), { target: { value: '20 O' } });
    await act(async () => { slow.release!(); });
    await waitFor(() => expect(discounts()).toEqual(['10']));
    expect(due().value).toBe('20 O');
  });

  it('Save waits for the customer: nothing is sent before the defaults land', async () => {
    const slow: { release?: () => void } = {};
    serve();
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=c-acme')) await new Promise<void>((r) => { slow.release = r; });
      return inner(url, init);
    });
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(slow.release).toBeTruthy());
    const create = screen.getByRole('button', { name: /^create invoice$/i }) as HTMLButtonElement;
    const saveAndNew = screen.getByRole('button', { name: /save & new/i }) as HTMLButtonElement;
    expect([create.disabled, saveAndNew.disabled]).toEqual([true, true]);
    await act(async () => { slow.release!(); });
    await waitFor(() => expect(create.disabled).toBe(false));
    expect(saveAndNew.disabled).toBe(false);
  });

  it('Save opens again when the customer cannot be read', async () => {
    serve();
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=')) throw new TypeError('Failed to fetch');
      return inner(url, init);
    });
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join('|')).toMatch(/customer's terms/i));
    expect((screen.getByRole('button', { name: /^create invoice$/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('moving to a customer with no terms takes the default back out', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
    await pickClient('c-bare');
    await waitFor(() => expect(due().value).toBe(''));
    expect(hintFromCustomer()).toEqual([]);
  });

  it('an answer for the customer before the last one is dropped', async () => {
    const slow: { release?: () => void } = {};
    serve();
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=c-acme')) await new Promise<void>((r) => { slow.release = r; });
      return inner(url, init);
    });
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(slow.release).toBeTruthy());
    await pickClient('c-bare');
    await waitFor(() => expect(contactCalls().length).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /^create invoice$/i }).hasAttribute('disabled')).toBe(false));
    await act(async () => { slow.release!(); await new Promise((r) => { setTimeout(r); }); }); // a macrotask: every microtask of the late answer has run
    expect(due().value).toBe('');
  });

  it('when the customer cannot be read the page says so and the form still works', async () => {
    serve();
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=')) throw new TypeError('Failed to fetch');
      return inner(url, init);
    });
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join('|')).toMatch(/customer's terms/i));
    expect(due().value).toBe('');
  });
});

describe('"+30" in Due date', () => {
  it('counts from the invoice date, not from today', async () => {
    serve();
    await open();
    typeDate(due(), '+30');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
  });
});

describe('line discount from the customer', () => {
  it('lands on untouched lines only, and the column opens to show it', async () => {
    serve();
    await open();
    fillLine(0, '50');
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['', '10']));
    expect(screen.getByText(/10% discount from customer/i)).toBeTruthy();
    fillLine(1, '100');
    await submit();
    expect(sentBody('POST').items.map((i) => i.discount)).toEqual([0, 10]);
  });

  it('a line added after the customer starts on the discount', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    expect(discounts()).toEqual(['10', '10']);
  });

  it('a discount the user typed on an empty line is kept when the customer changes', async () => {
    serve({ 'c-acme': ACME, 'c-other': { ...ACME, default_discount: '5.00' } });
    await open();
    await pickClient('c-acme');
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    await waitFor(() => expect(discounts()).toEqual(['10', '10']));
    fireEvent.change(screen.getAllByLabelText('Discount %')[0]!, { target: { value: '7' } });
    await pickClient('c-other');
    await waitFor(() => expect(discounts()).toEqual(['7', '5'])); // the second line shows the answer has landed
  });

  it('a priced line gives the default back: 10% customer, R1000, a no-discount customer: 1150.00', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    fillLine(0, '1000');
    await pickClient('c-bare');
    await waitFor(() => expect(screen.queryByLabelText('Discount %')).toBeNull());
    expect(screen.getByText('Invoice Summary').closest('.rounded-2xl')!.textContent).toMatch(/Total\s*R?\s*1[ ,\u00a0]?150\.00/);
    await submit();
    expect(sentBody('POST').items[0]!.discount).toBe(0);
  });

  it('a priced line moves to the next customer\'s default', async () => {
    serve({ 'c-acme': ACME, 'c-other': { ...ACME, default_discount: '5.00' } });
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    fillLine(0, '1000');
    await pickClient('c-other');
    await waitFor(() => expect(discounts()).toEqual(['5']));
  });

  it('the same figure typed over the default is the user\'s: it stays, and the customer no longer claims it', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    fireEvent.change(screen.getByLabelText('Discount %'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('Discount %'), { target: { value: '10' } });
    expect(screen.queryByText(/10% discount from customer/i)).toBeNull();
    await pickClient('c-bare');
    await waitFor(() => expect(contactCalls().length).toBe(2));
    await waitFor(() => expect(hintFromCustomer()).toEqual([]));
    expect(discounts()).toEqual(['10']);
  });

  it('where a discount came from is the form\'s own business: it does not reach the API', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    fillLine(0, '100');
    await submit();
    expect(Object.keys(sentBody('POST').items[0]!)).not.toContain('discountFromDefault');
  });

  it('clearing a discount to retype it keeps the field', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    fireEvent.change(screen.getByLabelText('Discount %'), { target: { value: '' } });
    expect(discounts()).toEqual(['']);
  });

  it('moving to a customer with no discount takes the default back off an untouched line', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    await pickClient('c-bare');
    await waitFor(() => expect(screen.queryByLabelText('Discount %')).toBeNull());
  });

  it('a default that is out of range is held to what the server accepts', async () => {
    serve({ 'c-big': { ...ACME, default_discount: '120.00' } });
    await open();
    await pickClient('c-big');
    await waitFor(() => expect(discounts()).toEqual(['100']));
  });
});
