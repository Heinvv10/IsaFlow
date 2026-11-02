/**
 * Master plan wave 3, PR D: the new-invoice page takes its due date from the customer, and never over what the user
 * typed. "+30" counts from the invoice date, not from today. Line discount: invoiceDefaultDiscount.test.tsx. VAT mode:
 * invoiceTaxModePages.test.tsx.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import type { InvoiceHeaderForm } from '@/components/accounting/customer-invoices/invoiceHeaderForm';
import type { InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import type { TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { useContactDefaults } from '@/components/accounting/customer-invoices/useContactDefaults';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { typeDate } from '../helpers/dateFields';
import {
  contactCalls, discounts, due, fillLine, hintFromCustomer, invoiceDate, pickClient, sentBody, serve, submitAndWait,
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

describe('a choice made as the customer lands', () => {
  // A layout effect runs after the answer's commit and before that commit's passive effects: the window a click can land
  // in. Those effects closed over the old `touched`, so the default would be queued after the user's choice and win.
  function PicksAsTheAnswerLands({ choose }: { choose: (contact: ReturnType<typeof useContactDefaults>, setMode: (m: TaxMode) => void, setForm: (f: InvoiceHeaderForm) => void) => void }) {
    const [form, setForm] = useState({ dueDate: '' } as InvoiceHeaderForm);
    const [, setLines] = useState<InvoiceLine[]>([]);
    const [mode, setMode] = useState<TaxMode>('exclusive');
    const contact = useContactDefaults({ clientId: 'c-acme', invoiceDate: '2026-10-01', setForm, setLines, setTaxMode: setMode });
    const chose = useRef(false);
    useLayoutEffect(() => {
      if (chose.current || contact.vatType === null) return;
      chose.current = true;
      choose(contact, setMode, setForm);
    });
    return <output>{`mode ${mode}, due ${form.dueDate || 'empty'}`}</output>;
  }

  it('a VAT mode picked then is not undone by the default', async () => {
    serve();
    render(<PicksAsTheAnswerLands choose={(contact, setMode) => { contact.touch('taxMode'); setMode('inclusive'); }} />);
    await screen.findByText(/^mode inclusive/);
  });

  it('a Due touched then is not filled by the default', async () => {
    serve();
    render(<PicksAsTheAnswerLands choose={(contact) => { contact.touch('dueDate'); }} />);
    await waitFor(() => expect(contactCalls().length).toBe(1));
    await screen.findByText(/due empty$/);
    await act(async () => { await new Promise((r) => { setTimeout(r); }); });
    expect(screen.getByRole('status').textContent).toMatch(/due empty$/);
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
