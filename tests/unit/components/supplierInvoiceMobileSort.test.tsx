/**
 * Below lg the table's header row (and its sort buttons) is hidden, so the supplier invoice list offers
 * the same sort as a select and an order button. The controls are lg:hidden; the behaviour is tested here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { InvoiceTable } from '@/components/accounting/supplier-invoices/InvoiceTable';

afterEach(cleanup);

const inv = { id: 'i1', invoiceNumber: 'SIV1', supplierName: 'Acme', reference: 'r', invoiceDate: '2026-10-01', totalAmount: 100, amountPaid: 0, balance: 100, status: 'approved' };

function setup() {
  const onSort = vi.fn();
  render(<InvoiceTable invoices={[inv] as never} selected={new Set()} toggleRow={vi.fn()} toggleAll={vi.fn()}
    sort="invoice_date" sortOrder="desc" onSort={onSort} page={1} perPage={25 as never} total={1}
    onPage={vi.fn()} onPerPage={vi.fn()} filtersActive={false} />);
  return onSort;
}

describe('supplier invoice mobile sort', () => {
  it('the select changes the sort column', () => {
    const onSort = setup();
    const sel = screen.getByLabelText('Sort by') as HTMLSelectElement;
    expect(sel.value).toBe('invoice_date');
    expect(sel.className.split(/\s+/)).not.toContain('hidden');
    fireEvent.change(sel, { target: { value: 'total_amount' } });
    expect(onSort).toHaveBeenCalledWith('total_amount');
  });
  it('the order button reverses the current sort and names the order', () => {
    const onSort = setup();
    const btn = screen.getByRole('button', { name: /Sort order: descending/ });
    fireEvent.click(btn);
    expect(onSort).toHaveBeenCalledWith('invoice_date');
  });
  it('is hidden from lg up', () => {
    setup();
    expect(screen.getByLabelText('Sort by').closest('div')!.className.split(/\s+/)).toContain('lg:hidden');
  });
});
