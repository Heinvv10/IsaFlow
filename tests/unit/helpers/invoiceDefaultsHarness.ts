/**
 * Shared by invoiceDefaults.test.tsx and invoiceTaxModePages.test.tsx (master plan wave 3, PR D): the customers and
 * the invoice the mocked API serves, what the pages sent, and the fields as a reader finds them. The test file mocks
 * `@/lib/apiFetch`, next/router and the rest; those mocks must sit in the test file for vi.mock to hoist them.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { ok } from './d2CensusG4';
import { pickOption } from './kitPick';

interface Contact { payment_terms?: number | null; payment_terms_type?: string | null; default_discount?: string | number | null; default_vat_type?: string | null }
export const ACME: Contact = { payment_terms: 30, payment_terms_type: 'days', default_discount: '10.00', default_vat_type: 'standard' };
export const ZERO: Contact = { payment_terms: null, payment_terms_type: 'days', default_discount: '0.00', default_vat_type: 'zero' };
export const BARE: Contact = { payment_terms: null, payment_terms_type: 'days', default_discount: '0.00', default_vat_type: null };
export const INV = { id: 'inv-1', invoice_number: 'INV-1', status: 'draft', client_id: 'c-acme', invoice_date: '2026-09-15', due_date: '2026-10-15',
  tax_rate: 15, notes: '', currency_code: 'ZAR', exchange_rate: 1, items: [{ description: 'L', quantity: 1, unit_price: 115, amount: 115 }] };

export const TWO_LINES = { ...INV, items: [{ description: 'One', quantity: 1, unit_price: 1000, amount: 1000 }, { description: 'Two', quantity: 1, unit_price: 500, amount: 500 }] };

export function serve(contacts: Record<string, Contact> = { 'c-acme': ACME, 'c-zero': ZERO, 'c-bare': BARE }, invoice: object = INV) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    const id = /customers\?id=([^&]+)/.exec(u)?.[1];
    if (id) return ok({ id, name: id, ...contacts[id] });
    if (u.includes('/customers')) return ok(Object.keys(contacts).map((c) => ({ id: c, name: c })));
    if (u.includes('customer-invoices-create') && init?.method === 'POST') return ok({ id: 'n1' });
    if (u.includes('customer-invoices-detail') && init?.method === 'PUT') return ok({});
    if (u.includes('customer-invoices-detail')) return ok(invoice);
    return ok([]);
  });
}
type Sent = { taxRate: number; dueDate: string; items: { unitPrice: number; discount: number; taxRate?: number }[] };
export const sentBody = (method: string): Sent => {
  const call = vi.mocked(apiFetch).mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === method);
  return JSON.parse(String((call![1] as RequestInit).body)) as Sent;
};
export const contactCalls = () => vi.mocked(apiFetch).mock.calls.filter((c) => String(c[0]).includes('customers?id='));

export const invoiceDate = () => screen.getByLabelText(/^Invoice date/);
export const due = () => screen.getByLabelText('Due date') as HTMLInputElement;
export const descriptionField = (i = 0) => screen.getAllByPlaceholderText('Item description')[i]!;
export const price = (i = 0) => screen.getAllByLabelText(/^Unit price/)[i]!;
export const prices = () => (screen.getAllByLabelText(/^Unit price/) as HTMLInputElement[]).map((p) => p.value);
const qty = (i = 0) => screen.getAllByLabelText('Quantity')[i]!;
export const discounts = () => (screen.getAllByLabelText('Discount %') as HTMLInputElement[]).map((d) => d.value);
export const pickClient = (name: string) => pickOption('Client', name);
export const pickMode = (name: RegExp) => pickOption('Amounts are', name);
export const hintFromCustomer = () => screen.queryAllByText(/from customer|customer terms/i);
export const submitAndWait = async (push: ReturnType<typeof vi.fn>) => {
  const create = screen.getByRole('button', { name: /^create invoice$/i }) as HTMLButtonElement;
  await waitFor(() => expect(create.disabled).toBe(false)); // it waits for the customer's defaults
  fireEvent.click(create);
  await waitFor(() => expect(push).toHaveBeenCalled());
};
export const fillLine = (i = 0, gross = '115', quantity?: string) => {
  fireEvent.change(descriptionField(i), { target: { value: 'Work' } });
  fireEvent.change(price(i), { target: { value: gross } });
  if (quantity) fireEvent.change(qty(i), { target: { value: quantity } });
};
