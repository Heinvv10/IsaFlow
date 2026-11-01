/**
 * Master plan wave 3, PR D review, F3: the user's VAT choice stands, but the form says when it conflicts with the
 * customer's VAT type: on the new page however the choice got there, and on the edit page once the customer is changed.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import { ACME, BARE, descriptionField, INV, invoiceDate, pickClient, pickMode, sentBody, serve, ZERO } from '../helpers/invoiceDefaultsHarness';

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

const CONTACTS = {
  'c-acme': ACME, 'c-zero': ZERO, 'c-bare': BARE,
  'c-shout': { ...ZERO, default_vat_type: '  EXEMPT ' },
  'c-odd': { ...BARE, default_vat_type: 'Reduced' },
};
const open = async () => { serve(CONTACTS); render(<NewPage />); await screen.findByRole('combobox', { name: 'Client' }); typeDate(invoiceDate(), '1 Oct 2026'); };
const rateField = () => screen.getByLabelText('VAT rate %') as HTMLInputElement;
const mode = () => screen.getByRole('combobox', { name: 'Amounts are' }).textContent;

describe('new page', () => {
  it('a rate touched first: the rate stands and the conflict is on screen', async () => {
    await open();
    fireEvent.change(rateField(), { target: { value: '14' } });
    await pickClient('c-zero');
    await screen.findByText('This customer is zero-rated, but this invoice charges VAT at 14%.');
    expect(rateField().value).toBe('14');
  });

  it('a scan with a rate over a zero-rated customer: the scan stands and the conflict is on screen', async () => {
    await open();
    await pickClient('c-zero');
    await waitFor(() => expect(rateField().disabled).toBe(true));
    expect(screen.queryByText(/but this invoice/)).toBeNull();
    scan.current = { vatRate: 15, lineItems: [] };
    fireEvent.click(screen.getByText('scan stub'));
    await screen.findByText('This customer is zero-rated, but this invoice charges VAT at 15%.');
    expect(rateField().value).toBe('15');
  });

  it('No VAT chosen for a standard customer is a conflict too', async () => {
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(screen.getByText(/from customer: standard rate/i)).toBeTruthy());
    expect(screen.queryByText(/but this invoice/)).toBeNull();
    await pickMode(/No VAT/);
    await screen.findByText('This customer is standard-rated, but this invoice charges no VAT.');
  });

  it('the warning goes when the conflict does', async () => {
    await open();
    fireEvent.change(rateField(), { target: { value: '14' } });
    await pickClient('c-zero');
    await screen.findByText(/zero-rated, but/);
    await pickMode(/No VAT/);
    await waitFor(() => expect(screen.queryByText(/but this invoice/)).toBeNull());
  });

  it('a VAT type in the wrong case or with spaces is read as what it says', async () => {
    await open();
    await pickClient('c-shout');
    await waitFor(() => expect(rateField().disabled).toBe(true));
    expect(screen.getByText(/from customer: VAT exempt/i)).toBeTruthy();
    expect(screen.queryByText(/not one IsaFlow knows/)).toBeNull();
  });

  it('a VAT type nobody knows is flagged, and is not treated as standard', async () => {
    await open();
    await pickClient('c-odd');
    await screen.findByText(/VAT type "reduced" is not one IsaFlow knows/);
    expect(mode()).toMatch(/Excluding VAT/);
    expect(screen.queryByText(/from customer/i)).toBeNull();
  });
});

describe('a customer who never answers', () => {
  it('gives up after 15 s: Save opens and the page says so', async () => {
    const abort = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
    serve(CONTACTS);
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (!String(url).includes('customers?id=')) return inner(url, init);
      return new Promise<Response>((_, reject) => {
        (init as RequestInit).signal!.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
      });
    });
    render(<NewPage />);
    await screen.findByRole('combobox', { name: 'Client' });
    await pickClient('c-acme');
    const create = screen.getByRole('button', { name: /^create invoice$/i }) as HTMLButtonElement;
    await waitFor(() => expect(timeout).toHaveBeenCalledWith(15_000));
    expect(create.disabled).toBe(true);
    await act(async () => { abort.abort(); });
    await waitFor(() => expect(create.disabled).toBe(false));
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join('|')).toMatch(/customer's terms/i);
    timeout.mockRestore();
  });
});

describe('edit page', () => {
  const load = async () => { serve(CONTACTS); render(<EditPage />); await screen.findByDisplayValue('L'); };
  const saveButton = () => screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;

  it('a conflict already on the draft warns on load, and nothing is refilled', async () => {
    serve(CONTACTS, { ...INV, client_id: 'c-zero' });
    render(<EditPage />);
    await screen.findByText('This customer is zero-rated, but this invoice charges VAT at 15%.');
    expect(rateField().value).toBe('15');
    expect(mode()).toMatch(/Excluding VAT/);
  });

  it('Save does not wait for the loaded customer: the invoice is the invoice', async () => {
    const slow: { release?: () => void } = {};
    serve(CONTACTS);
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=')) await new Promise<void>((r) => { slow.release = r; });
      return inner(url, init);
    });
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    await waitFor(() => expect(slow.release).toBeTruthy());
    expect(saveButton().disabled).toBe(false);
  });

  it('changing to a zero-rated customer warns, and the stored rate and price stand', async () => {
    await load();
    await pickClient('c-zero');
    await screen.findByText('This customer is zero-rated, but this invoice charges VAT at 15%.');
    expect(rateField().value).toBe('15');
    expect(mode()).toMatch(/Excluding VAT/);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(sentBody('PUT').taxRate).toBe(15);
    expect(sentBody('PUT').items[0]!.unitPrice).toBe(115);
  });

  it('Save waits for the changed customer, and opens again when it cannot be read', async () => {
    const slow: { fail?: () => void } = {};
    serve(CONTACTS);
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=c-zero')) await new Promise<void>((_, reject) => { slow.fail = () => reject(new TypeError('Failed to fetch')); });
      return inner(url, init);
    });
    render(<EditPage />);
    await waitFor(() => expect(descriptionField()).toBeTruthy());
    await pickClient('c-zero');
    await waitFor(() => expect(slow.fail).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
    await act(async () => { slow.fail!(); });
    await screen.findByText(/could not load the customer/i);
    expect(saveButton().disabled).toBe(false);
  });
});
