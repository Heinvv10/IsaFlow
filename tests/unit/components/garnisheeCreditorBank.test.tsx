/**
 * Wave 7 GC1 (review #1895 T1, A3): the creditor bank-details line on a garnishee order. The form PUTs the five fields
 * (a blank holder as null), is cleared and closed after a save, shows the route's refusal, prefills only the bank and
 * type on a change (never the number), and offers no form to someone the rules refuse: a manager on entered details,
 * or on an order that is ended or already deducted by an approved run (adminOnly).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GarnisheeCreditorBank } from '@/components/payroll/GarnisheeCreditorBank';
import type { CreditorBank } from '@/modules/accounting/services/payroll/payrollGarnisheeCreditorBank';

const { apiFetch, role } = vi.hoisted(() => ({ apiFetch: vi.fn(), role: { value: 'owner' } }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role.value, activeCompany: { id: 'c1' } }) }));

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const URL_ = '/api/payroll/employees/e1/garnishee-orders';
const BANK: CreditorBank = { bankName: 'Standard Bank', accountNumber: '…3939', branchCode: '…01', accountType: 'savings', accountHolder: 'A…', masked: true, setAt: null };
const puts: Array<{ url: string; body: Record<string, unknown> }> = [];
let onSaved: ReturnType<typeof vi.fn>;

beforeEach(() => {
  puts.length = 0; role.value = 'owner';
  onSaved = vi.fn(async () => undefined);
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    puts.push({ url, body: JSON.parse(String(init?.body)) });
    return json(200, { success: true, data: BANK });
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const field = (name: string | RegExp) => screen.getByLabelText(name) as HTMLInputElement;

it('enters the details: PUTs the five fields with a blank holder as null, then closes the form and reloads', async () => {
  render(<GarnisheeCreditorBank url={URL_} orderId="o1" bank={null} adminOnly={false} onSaved={onSaved} />);
  expect(screen.getByText('No creditor bank details yet')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Enter bank details' }));
  fireEvent.change(field("Creditor's bank"), { target: { value: 'First National Bank' } });
  fireEvent.change(field('Branch code'), { target: { value: '250655' } });
  fireEvent.change(field('Account number'), { target: { value: '62001234567' } });
  fireEvent.change(field('Account holder (optional)'), { target: { value: '   ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(puts).toEqual([{ url: `${URL_}/o1`, body: {
    bankName: 'First National Bank', branchCode: '250655', accountNumber: '62001234567', accountType: 'cheque', accountHolder: null,
  } }]);
  expect(apiFetch.mock.calls[0]![1]).toMatchObject({ method: 'PUT' });
  expect(screen.queryByLabelText('Account number')).toBeNull();
});

it('shows the route\'s refusal and keeps the form open', async () => {
  apiFetch.mockResolvedValueOnce(json(403, { success: false, error: { code: 'FORBIDDEN', message: 'Only an owner or admin can enter the creditor\'s bank details on an order that has ended or that an approved pay run has deducted.', details: { reason: 'FIRST_ENTRY_REQUIRES_ADMIN' } } }));
  render(<GarnisheeCreditorBank url={URL_} orderId="o1" bank={null} adminOnly={false} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enter bank details' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Only an owner or admin can enter/);
  expect(onSaved).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Account number')).toBeTruthy();
});

it('an owner changing entered details: the bank and type are prefilled, the number and branch are not', () => {
  render(<GarnisheeCreditorBank url={URL_} orderId="o1" bank={BANK} adminOnly onSaved={onSaved} />);
  expect(screen.getByText(/Pays into Standard Bank savings …3939, branch …01, holder A…/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Change bank details' }));
  expect(field("Creditor's bank").value).toBe('Standard Bank');
  expect(field('Account number').value).toBe('');
  expect(field('Branch code').value).toBe('');
});

it.each([
  ['entered details', BANK, false, /an owner or admin changes them/],
  ['an ended or approved-deducted order', null, true, /an owner or admin enters them on this order/],
] as const)('a manager is offered no form on %s', (_case, bank, adminOnly, note) => {
  role.value = 'manager';
  render(<GarnisheeCreditorBank url={URL_} orderId="o1" bank={bank} adminOnly={adminOnly} onSaved={onSaved} />);
  expect(screen.queryByRole('button', { name: /bank details/ })).toBeNull();
  expect(screen.getByText(note)).toBeTruthy();
});

it('a manager may make the first entry on an order no approved run has deducted', () => {
  role.value = 'manager';
  render(<GarnisheeCreditorBank url={URL_} orderId="o1" bank={null} adminOnly={false} onSaved={onSaved} />);
  expect(screen.getByRole('button', { name: 'Enter bank details' })).toBeTruthy();
});
