/**
 * Master plan wave 3, PR D: the "Amounts are" choice on the new and edit pages reaches the request body as a rate and
 * ex-VAT prices, a customer's VAT type pre-selects it unless the user chose, and the edit page keeps a stored invoice
 * as it is until the user changes it. Pricing itself: invoiceTaxMode.test.ts.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import { openCombobox } from '../helpers/kitPick';
import {
  contactCalls, descriptionField, discounts, due, fillLine, hintFromCustomer, invoiceDate, pickClient, pickMode, prices, sentBody, serve, submitAndWait,
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
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); scan.current = { dueDate: null, vatRate: null, lineItems: [] }; });

const open = async () => { render(<NewPage />); await screen.findByRole('combobox', { name: 'Client' }); typeDate(invoiceDate(), '1 Oct 2026'); };
const submit = () => submitAndWait(push);

describe('VAT mode', () => {
  it('a zero-rated customer pre-selects No VAT, with a hint, and posts taxRate 0', async () => {
    serve();
    await open();
    await pickClient('c-zero');
    await waitFor(() => expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).disabled).toBe(true));
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('0');
    expect(screen.getByText(/from customer: zero-rated/i)).toBeTruthy();
    fillLine();
    await submit();
    const body = sentBody('POST');
    expect(body.taxRate).toBe(0);
    expect(body.items[0]!.unitPrice).toBe(115);
  });

  it('a VAT mode the user chose is not overwritten by the customer', async () => {
    serve();
    await open();
    await pickMode(/Including VAT/);
    await pickClient('c-zero');
    await screen.findByText(/zero-rated, but this invoice charges VAT at 15%/); // the customer's answer has landed, and says so
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Including VAT/);
    expect(screen.queryByText(/from customer: zero-rated/i)).toBeNull();
  });

  it('a mode picked in the instant the customer lands stands: the default\'s late effect does not undo it', async () => {
    const slow: { release?: () => void } = {};
    serve();
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=')) await new Promise<void>((r) => { slow.release = r; });
      return inner(url, init);
    });
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(slow.release).toBeTruthy());
    openCombobox('Amounts are');
    const inclusive = await screen.findByRole('option', { name: /Including VAT/ });
    fillLine(0, '1000');
    // Commit of the answer, then the click, then the passive effects of that commit: the order a browser can give.
    const landed = new Promise<void>((resolve) => {
      new MutationObserver((_, watcher) => { watcher.disconnect(); inclusive.click(); resolve(); })
        .observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    slow.release!();
    await landed;
    await new Promise((r) => { setTimeout(r, 20); });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Including VAT/));
    expect(prices()).toEqual(['1150']);
  });

  it('a rate the user typed is not overwritten by the customer', async () => {
    serve();
    await open();
    fireEvent.change(screen.getByLabelText('VAT rate %'), { target: { value: '14' } });
    await pickClient('c-zero');
    await screen.findByText(/zero-rated, but this invoice charges VAT at 14%/);
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('14');
  });

  it('leaving No VAT brings the rate back', async () => {
    serve();
    await open();
    await pickMode(/No VAT/);
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('0');
    await pickMode(/Excluding VAT/);
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('15');
  });

  it('inclusive 115 posts unitPrice 100', async () => {
    serve();
    await open();
    await pickClient('c-bare');
    await pickMode(/Including VAT/);
    fillLine();
    await submit();
    const body = sentBody('POST');
    expect(body.items[0]!.unitPrice).toBe(100);
    expect(body.taxRate).toBe(15);
  });

  it('the summary says when the stored total differs from the typed one', async () => {
    serve();
    await open();
    await pickMode(/Including VAT/);
    fillLine(0, '10', '3');
    const note = await screen.findByText(/you typed/i);
    expect(note.textContent?.replace(/\s/g, ' ')).toMatch(/You typed R ?30\.00 incl\. VAT; the invoice total is R ?30\.02/);
  });

  it('no message when the two agree', async () => {
    serve();
    await open();
    await pickMode(/Including VAT/);
    fillLine(0, '115');
    expect(within(screen.getByText('Invoice Summary').closest('.rounded-2xl') as HTMLElement).getByText(/115\.00/)).toBeTruthy();
    expect(screen.queryByText(/you typed/i)).toBeNull();
  });

  it('a scan carrying a rate is exclusive, as its prices are', async () => {
    serve();
    await open();
    await pickClient('c-bare');
    await pickMode(/Including VAT/);
    scan.current = { ...scan.current, vatRate: 15, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 200 }] };
    fireEvent.click(screen.getByText('scan stub'));
    await waitFor(() => expect((descriptionField() as HTMLInputElement).value).toBe('Scanned'));
    await submit();
    expect(sentBody('POST').items[0]!.unitPrice).toBe(200);
  });

  it('Save & New starts clean: what the user chose on the last invoice does not stop the next one defaulting', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await pickMode(/Including VAT/);
    typeDate(due(), '20 Oct 2026');
    fillLine();
    fireEvent.click(screen.getByRole('button', { name: /save & new/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Excluding VAT/));
    expect(hintFromCustomer()).toEqual([]);
    typeDate(invoiceDate(), '1 Oct 2026');
    await pickClient('c-zero');
    await waitFor(() => expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).disabled).toBe(true));
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
    await waitFor(() => expect(discounts()).toEqual(['10']));
  });
});

describe('edit page', () => {
  const load = async () => { render(<EditPage />); await screen.findByDisplayValue('L'); };

  it('loads stored ex-VAT prices in exclusive mode, and saves them unconverted', async () => {
    serve();
    await load();
    expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Excluding VAT/);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = sentBody('PUT');
    expect(body.items[0]!.unitPrice).toBe(115);
    expect(body.taxRate).toBe(15);
  });

  it('asks nothing of the customer on load: a stored invoice is not refilled', async () => {
    serve();
    await load();
    expect(contactCalls()).toEqual([]);
    expect(due().value).toBe('15 Oct 2026');
    expect(hintFromCustomer()).toEqual([]);
  });

  it('No VAT saves rate 0 on the header and the lines, at the stored price', async () => {
    serve();
    await load();
    await pickMode(/No VAT/);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = sentBody('PUT');
    expect(body.taxRate).toBe(0);
    expect(body.items[0]!.taxRate).toBe(0);
    expect(body.items[0]!.unitPrice).toBe(115);
  });

  it('heads the page with PageHeader, not the always-dark banner', async () => {
    serve();
    const { container } = render(<EditPage />);
    await screen.findByDisplayValue('L');
    expect(screen.getByRole('heading', { level: 1, name: 'INV-1' })).toBeTruthy();
    expect(container.querySelector('.bg-gradient-to-br')).toBeNull();
    expect(screen.getByText('Edit draft')).toBeTruthy();
  });
});
