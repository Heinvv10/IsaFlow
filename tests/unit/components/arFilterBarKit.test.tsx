/** The invoice list's filter bar on the kit (wave-4 NS1): Status is a kit Select, the search is named by its label, no native select. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARFilterBar } from '@/components/accounting/customer-invoices/ARFilterBar';
import type { CustomerInvoiceListState } from '@/components/accounting/customer-invoices/useCustomerInvoiceListState';

vi.mock('@/components/accounting/customer-invoices/CustomerTypeahead', () => ({ CustomerTypeahead: () => null }));

function stateWith(setStatus = vi.fn(), setSearch = vi.fn()): CustomerInvoiceListState {
  return {
    filters: { status: 'all', search: '', customerId: '', from: '', to: '', aging: [], page: 1 },
    hydrated: true, customerLabel: '', nameCustomer: vi.fn(), setStatus, setSearch, selectCustomer: vi.fn(), clearCustomer: vi.fn(),
    setRange: vi.fn(), setAging: vi.fn(), setPage: vi.fn(), clearAll: vi.fn(),
  } as unknown as CustomerInvoiceListState;
}
afterEach(cleanup);

describe('ARFilterBar on the kit', () => {
  it('draws no native select, names the search by its label, and Status is a labelled combobox', () => {
    const { container } = render(<ARFilterBar state={stateWith()} total={3} />);
    expect(container.querySelector('select')).toBeNull();
    expect(screen.getByLabelText('Search invoices')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Status' }).textContent).toBe('All Statuses');
  });

  it('choosing a status by keyboard reports it', () => {
    const setStatus = vi.fn();
    render(<ARFilterBar state={stateWith(setStatus)} total={null} />);
    const status = screen.getByRole('combobox', { name: 'Status' });
    fireEvent.keyDown(status, { key: 'Enter' });
    fireEvent.keyDown(status, { key: 'p' }); // type-ahead to the next label starting with "p"
    expect(setStatus).not.toHaveBeenCalled();
    fireEvent.keyDown(status, { key: 'Enter' });
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(String(setStatus.mock.calls[0]![0])).toMatch(/^p/);
  });
});
