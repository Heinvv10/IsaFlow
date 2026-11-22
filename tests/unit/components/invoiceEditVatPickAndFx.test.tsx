/**
 * Review of the line-level invoice form, test gap 9a and finding 3 on the edit page:
 * - a VAT type picked in the line grid is what Save Changes sends for that line;
 * - a foreign-currency draft shows its ZAR equivalent under the totals, as the new page does (the edit page showed
 *   none, before this branch too), at the rate on the form.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { pickVatType, totalsText } from '../helpers/invoiceDefaultsHarness';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

const DRAFT = { id: 'inv-1', invoice_number: 'INV-1', status: 'draft', client_id: 'c-1', invoice_date: '2026-09-15', due_date: '2026-10-15',
  tax_rate: 15, total_amount: 345, notes: '', currency_code: 'ZAR', exchange_rate: 1,
  items: [
    { description: 'One', quantity: 1, unit_price: 100, amount: 100, vat_type: 'standard', tax_amount: 15, tax_rate: 15 },
    { description: 'Two', quantity: 1, unit_price: 200, amount: 200, vat_type: 'standard', tax_amount: 30, tax_rate: 15 },
  ] };
function serve(invoice: object) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('currencies')) return ok([{ code: 'USD', name: 'US Dollar' }]);
    const id = /customers\?id=([^&]+)/.exec(u)?.[1];
    if (id) return ok({ id, default_vat_type: null });
    if (u.includes('/customers')) return ok([{ id: 'c-1', name: 'Acme' }]);
    if (u.includes('customer-invoices-detail') && init?.method === 'PUT') return ok({ updated: true });
    if (u.includes('customer-invoices-detail')) return ok(invoice);
    return ok([]);
  });
}
const puts = () => vi.mocked(apiFetch).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');

describe('the edit page', () => {
  it('a VAT type picked on the second line is what Save Changes sends for it; the first keeps its own', async () => {
    serve(DRAFT);
    render(<EditPage />);
    await screen.findByDisplayValue('Two');
    await pickVatType(1, /Exempt/);
    const save = screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(String((puts()[0]![1] as RequestInit).body)) as { taxRate?: number; items: { description: string; vatType: string }[] };
    expect(body.items.map((i) => [i.description, i.vatType])).toEqual([['One', 'standard'], ['Two', 'exempt']]);
    expect('taxRate' in body).toBe(false);
  });

  it('a USD draft at 18.5 shows its ZAR equivalent under the totals, and follows a new rate', async () => {
    serve({ ...DRAFT, currency_code: 'USD', exchange_rate: 18.5 });
    render(<EditPage />);
    await screen.findByDisplayValue('Two');
    expect(totalsText()).toMatch(/ZAR equivalent\s*R\s?6\s?382\.50/); // USD 345.00 x 18.5
    fireEvent.change(document.querySelector('input[name="exchangeRate"]')!, { target: { value: '20' } });
    expect(totalsText()).toMatch(/ZAR equivalent\s*R\s?6\s?900\.00/);
    expect(totalsText()).toMatch(/@ 20 USD\/ZAR/);
  });

  it('a ZAR draft shows no ZAR equivalent', async () => {
    serve(DRAFT);
    render(<EditPage />);
    await screen.findByDisplayValue('Two');
    expect(totalsText()).not.toMatch(/ZAR equivalent/);
  });
});
