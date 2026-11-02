/**
 * Master plan wave 3, PR D: a line's discount is the customer's until the user sets it: it follows the customer, priced or
 * not, and never lands on what the user typed. Due date: invoiceDefaults.test.tsx.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import {
  ACME, contactCalls, discounts, fillLine, hintFromCustomer, invoiceDate, pickClient, sentBody, serve, submitAndWait,
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

  it('a line typed while the customer is being read still takes the discount: 10%, R1000, 1035.00', async () => {
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
    fillLine(0, '1000');
    await act(async () => { slow.release!(); });
    await waitFor(() => expect(discounts()).toEqual(['10']));
    expect(screen.getByText('Invoice Summary').closest('.rounded-2xl')!.textContent).toMatch(/Total\s*R?\s*1[ ,\u00a0]?035\.00/);
  });

  it('a discount typed while the customer is being read stays the user\'s', async () => {
    const slow: { release?: () => void } = {};
    serve();
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=c-acme')) await new Promise<void>((r) => { slow.release = r; });
      return inner(url, init);
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: /disc/i }));
    await pickClient('c-acme');
    await waitFor(() => expect(slow.release).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Discount %'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    await act(async () => { slow.release!(); });
    await waitFor(() => expect(discounts()).toEqual(['7', '10']));
  });

  it('a line typed with no customer, then a 10% customer: left at no discount (owner decision, pr-notes)', async () => {
    serve();
    await open();
    await pickClient('c-bare');
    await waitFor(() => expect(contactCalls().length).toBe(1));
    await waitFor(() => expect((screen.getByRole('button', { name: /^create invoice$/i }) as HTMLButtonElement).disabled).toBe(false));
    fillLine(0, '1000');
    await pickClient('c-acme');
    await screen.findByText('Customer terms: 30 days');
    expect(screen.queryByLabelText('Discount %')).toBeNull();
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
