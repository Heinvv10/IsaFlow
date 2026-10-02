/**
 * D2 round 3 (a4): create forms (products, items, recurring invoice) and the quote / sales-order lists whose
 * create modals, row actions and conversions treated any HTTP response as success. A refused write must show
 * the server message, keep the form/modal, and never redirect or claim success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, PLAIN_BAD, empty500, envelope, ok } from '../helpers/d2R3a4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => route }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1' } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import ProductsNewPage from '../../../pages/accounting/products/new';
import ItemsNewPage from '../../../pages/accounting/items/new';
import RecurringInvoiceNewPage from '../../../pages/accounting/recurring-invoices/new';
import CustomerQuotesPage from '../../../pages/accounting/customer-quotes/index';
import CustomerSalesOrdersPage from '../../../pages/accounting/customer-sales-orders/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
const alertSpy = vi.fn();
beforeEach(() => {
  vi.mocked(apiFetch).mockReset(); route.push.mockReset(); alertSpy.mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true)); vi.stubGlobal('alert', alertSpy);
});
afterEach(() => { cleanup(); });
const noJsonLeak = () => expect(screen.queryByText(PLAIN_BAD)).toBeNull();
const submit = () => fireEvent.submit(document.querySelector('form')!);
const isWrite = (init?: RequestInit) => !!init?.method && init.method !== 'GET';
const submitButton = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;

describe.each([
  { label: 'products/new', Page: ProductsNewPage, plain: /Could not create the product - try again/ },
  { label: 'items/new', Page: ItemsNewPage, plain: /Could not create the item - try again/ },
])('$label', ({ Page, plain }) => {
  const script = (write: () => Response) => vi.mocked(apiFetch).mockImplementation(async (_u, init) =>
    isWrite(init) ? write() : ok([]));

  it('a refused create shows the server message, does not redirect, and clears saving', async () => {
    script(() => envelope());
    render(<Page />);
    submit();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
  });

  it('a create answered with an empty 500 shows a plain sentence and does not redirect', async () => {
    script(empty500);
    render(<Page />);
    submit();
    expect(await screen.findByText(plain)).toBeTruthy();
    noJsonLeak();
    expect(route.push).not.toHaveBeenCalled();
  });

  it('a successful create redirects to the list', async () => {
    script(() => ok({ id: 'x1' }));
    render(<Page />);
    submit();
    await waitFor(() => expect(route.push).toHaveBeenCalled());
    expect(screen.queryByText(/Could not create/)).toBeNull();
  });
});

describe('recurring invoice: new', () => {
  const script = (write: () => Response) => vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (isWrite(init)) return write();
    return String(url).includes('/customers') ? ok([{ id: 'c1', name: 'D2 Customer' }]) : ok([]);
  });
  const fill = async () => {
    await screen.findByText('D2 Customer');
    fireEvent.change(document.querySelector('select[name="clientId"]')!, { target: { value: 'c1' } });
    fireEvent.change(screen.getByPlaceholderText('Description *'), { target: { value: 'D2 line' } });
    const price = Array.from(document.querySelectorAll('input[type="number"]')).find((i) => (i as HTMLInputElement).value === '0')!;
    fireEvent.change(price, { target: { value: '100' } });
  };

  it('a refused create shows the server message, does not redirect, clears submitting', async () => {
    script(() => envelope());
    render(<RecurringInvoiceNewPage />);
    await fill();
    submit();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(route.push).not.toHaveBeenCalled();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
  });

  it('a create answered with an empty 500 shows a plain sentence', async () => {
    script(empty500);
    render(<RecurringInvoiceNewPage />);
    await fill();
    submit();
    expect(await screen.findByText(/Could not create the recurring invoice - try again/)).toBeTruthy();
    noJsonLeak();
    expect(route.push).not.toHaveBeenCalled();
  });

  it('a successful create redirects to the list', async () => {
    script(() => ok({ id: 'r1' }));
    render(<RecurringInvoiceNewPage />);
    await fill();
    submit();
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/recurring-invoices'));
  });
});

const QUOTE = { id: 'q1', quoteNumber: 'Q-D2-1', customerName: 'D2 Customer', quoteDate: '2026-01-01', expiryDate: null, status: 'draft', total: 115 };
const CUSTOMER = { id: 'c1', name: 'D2 Customer' };

describe('customer quotes', () => {
  const script = (status: string, write: (body: string) => Response) => vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (isWrite(init)) return write(String(init?.body));
    if (u.includes('/customers')) return ok([CUSTOMER]);
    return ok({ quotes: [{ ...QUOTE, status }], total: 1 });
  });

  it('a refused "Mark Sent" shows the server message', async () => {
    script('draft', () => envelope());
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByTitle('Mark Sent'));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });

  it('"Mark Sent" answered with an empty 500 shows a plain sentence', async () => {
    script('draft', empty500);
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByTitle('Mark Sent'));
    expect(await screen.findByText(/Could not update the quote - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a refused convert-to-invoice alerts the server message and re-enables the button', async () => {
    script('accepted', () => envelope());
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Invoice/ }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(MSG));
    expect(screen.queryByText(/converted\./)).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: /Invoice/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('convert-to-invoice answered with an empty 500 alerts a plain sentence', async () => {
    script('accepted', empty500);
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Invoice/ }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Could not convert the quote - try again'));
  });

  it('a network failure on convert-to-invoice is reported and does not leave the button stuck', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (isWrite(init)) throw new TypeError('network down');
      return String(url).includes('/customers') ? ok([CUSTOMER]) : ok({ quotes: [{ ...QUOTE, status: 'accepted' }], total: 1 });
    });
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Invoice/ }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Could not convert the quote - try again'));
    await waitFor(() => expect((screen.getByRole('button', { name: /Invoice/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a successful convert-to-invoice shows the success banner', async () => {
    script('accepted', () => ok({ invoiceId: 'inv-9' }));
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Invoice/ }));
    expect(await screen.findByText('Q-D2-1 converted.')).toBeTruthy();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('a refused convert-to-order alerts the server message and does not navigate', async () => {
    script('accepted', () => envelope());
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /To SO/ }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith(MSG));
    expect(route.push).not.toHaveBeenCalled();
  });

  it('a successful convert-to-order navigates to the new order', async () => {
    script('accepted', () => ok({ salesOrderId: 'so-1' }));
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /To SO/ }));
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/customer-sales-orders/so-1'));
  });

  const openModal = async () => {
    await screen.findByText('Q-D2-1');
    fireEvent.click(screen.getAllByRole('button', { name: /New Quote/ })[0]!);
    await screen.findByText('Fill in the quote details below');
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'D2 item' } });
  };

  it('create modal: a refused create shows the server message (not "Create failed (400)") and stays open', async () => {
    script('draft', () => envelope());
    render(<CustomerQuotesPage />);
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: /Create Quote/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('Fill in the quote details below')).toBeTruthy();
  });

  it('create modal: an empty 500 shows a plain sentence and stays open', async () => {
    script('draft', empty500);
    render(<CustomerQuotesPage />);
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: /Create Quote/ }));
    expect(await screen.findByText(/Could not create the quote - try again/)).toBeTruthy();
    expect(screen.queryByText(/Create failed/)).toBeNull();
    expect(screen.getByText('Fill in the quote details below')).toBeTruthy();
  });

  it('create modal: success closes the modal', async () => {
    script('draft', () => ok({ id: 'q2' }));
    render(<CustomerQuotesPage />);
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: /Create Quote/ }));
    await waitFor(() => expect(screen.queryByText('Fill in the quote details below')).toBeNull());
  });
});

const ORDER = { id: 'o1', orderNumber: 'SO-D2-1', customerName: 'D2 Customer', orderDate: '2026-01-01', deliveryDate: null, status: 'draft', totalAmount: 115 };

describe('customer sales orders', () => {
  const script = (write: () => Response, list: () => Response = () => ok({ orders: [ORDER], total: 1 })) => {
    let written = false;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (isWrite(init)) { written = true; return write(); }
      if (String(url).includes('/customers')) return ok([CUSTOMER]);
      return written ? list() : ok({ orders: [ORDER], total: 1 });
    });
  };

  it('a refused delete shows the server message and keeps the row', async () => {
    script(() => envelope());
    render(<CustomerSalesOrdersPage />);
    fireEvent.click(await screen.findByTitle('Delete'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('SO-D2-1')).toBeTruthy();
    await waitFor(() => expect((screen.getByTitle('Delete') as HTMLButtonElement).disabled).toBe(false));
  });

  it('a delete answered with an empty 500 shows a plain sentence', async () => {
    script(empty500);
    render(<CustomerSalesOrdersPage />);
    fireEvent.click(await screen.findByTitle('Delete'));
    expect(await screen.findByText(/Could not delete the sales order - try again/)).toBeTruthy();
    noJsonLeak();
  });

  it('a failing reload after a delete clears the stale rows', async () => {
    script(() => ok({}), empty500);
    render(<CustomerSalesOrdersPage />);
    fireEvent.click(await screen.findByTitle('Delete'));
    expect(await screen.findByText(/Could not load sales orders - try again/)).toBeTruthy();
    expect(screen.queryByText('SO-D2-1')).toBeNull();
  });

  const openModal = async () => {
    await screen.findByText('SO-D2-1');
    fireEvent.click(screen.getAllByRole('button', { name: /New Sales Order/ })[0]!);
    await screen.findByText('Fill in the order details below');
    await screen.findByRole('option', { name: 'D2 Customer' });
    fireEvent.change(screen.getAllByRole('combobox').find((s) => s.querySelector('option[value="c1"]'))!, { target: { value: 'c1' } });
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'D2 item' } });
  };

  it('create modal: a refused create shows the server message and stays open', async () => {
    script(() => envelope());
    render(<CustomerSalesOrdersPage />);
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: /Create Sales Order/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('Fill in the order details below')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: /Create Sales Order/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('create modal: an empty 500 shows a plain sentence and stays open', async () => {
    script(empty500);
    render(<CustomerSalesOrdersPage />);
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: /Create Sales Order/ }));
    expect(await screen.findByText(/Could not create the sales order - try again/)).toBeTruthy();
    expect(screen.getByText('Fill in the order details below')).toBeTruthy();
  });

  it('create modal: success closes the modal', async () => {
    script(() => ok({ id: 'o2' }));
    render(<CustomerSalesOrdersPage />);
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: /Create Sales Order/ }));
    await waitFor(() => expect(screen.queryByText('Fill in the order details below')).toBeNull());
  });
});
