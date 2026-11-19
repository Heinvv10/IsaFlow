/**
 * The new supplier credit note form previews VAT per line, by the line's VAT type, with the function the
 * server prices with (shared/vatLineAmounts), sends the type it shows, and does not throw while a field is
 * mid-edit.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const push = vi.fn(async () => true);
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => (
    <button type="button" onClick={() => onChange('sup-1', 'Acme Supplies')}>pick-supplier</button>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import NewSupplierCreditNotePage from '../../../pages/accounting/supplier-credit-notes/new';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
/** The amount beside a summary label, digits only ("R 1 650,00" and "R1,650.00" both read 165000). */
const summary = (label: string): string =>
  (screen.getAllByText(label).at(-1)!.nextElementSibling?.textContent ?? '').replace(/\D/g, '');

function setLine(i: number, price: string, vatType: string) {
  fireEvent.change(screen.getAllByPlaceholderText('Item description')[i]!, { target: { value: `line ${i + 1}` } });
  fireEvent.change(screen.getByLabelText(`Line ${i + 1} unit price`), { target: { value: price } });
  fireEvent.change(screen.getByLabelText(`Line ${i + 1} VAT type`), { target: { value: vatType } });
}

describe('new supplier credit note: VAT per line', () => {
  beforeEach(() => { fetchMock.mockReset(); push.mockClear(); });

  it('offers the document VAT types, labelled with the rate', () => {
    render(<NewSupplierCreditNotePage />);
    const options = Array.from(screen.getByLabelText('Line 1 VAT type').querySelectorAll('option'));
    expect(options.map((o) => [o.getAttribute('value'), o.textContent])).toEqual([
      ['standard', 'Standard (15%)'], ['zero_rated', 'Zero-rated (0%)'], ['exempt', 'Exempt'],
    ]);
  });

  it('charges VAT only on the standard line and sends each line its type', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { id: 'cn-1' } }), { status: 201 }));
    render(<NewSupplierCreditNotePage />);
    fireEvent.click(screen.getByText('pick-supplier'));
    setLine(0, '1000', 'standard');
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    setLine(1, '500', 'zero_rated');
    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    setLine(2, '250', 'exempt');
    expect(summary('Subtotal')).toBe('175000');
    expect(summary('VAT')).toBe('15000');
    expect(summary('Total')).toBe('190000');

    fireEvent.click(screen.getByRole('button', { name: /save as draft/i }));
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as { lineItems: Array<{ vatType: string }> };
    expect(body.lineItems.map((l) => l.vatType)).toEqual(['standard', 'zero_rated', 'exempt']);
  });

  it('prices quantity x unit price as decimals, as the server does', () => {
    render(<NewSupplierCreditNotePage />);
    fireEvent.change(screen.getByLabelText('Line 1 quantity'), { target: { value: '3' } });
    setLine(0, '1.005', 'exempt');
    expect(summary('Subtotal')).toBe('302');
  });

  it('renders zeros, without throwing, while an amount is absurd or empty', () => {
    render(<NewSupplierCreditNotePage />);
    setLine(0, '1e300', 'standard');
    expect(summary('Total')).toBe('000');
    fireEvent.change(screen.getByLabelText('Line 1 unit price'), { target: { value: '' } });
    expect(summary('VAT')).toBe('000');
  });
});
