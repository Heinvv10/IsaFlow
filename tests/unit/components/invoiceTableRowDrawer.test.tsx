/**
 * Master plan U (M10): a plain click on an invoice row, its number included, opens the drawer. Ctrl, Cmd, Shift and
 * the middle button still open the page: on the number the browser does it from the real href, elsewhere the row does.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerInvoiceTable, type CustomerInvoiceRow } from '@/components/accounting/customer-invoices/CustomerInvoiceTable';

const INV: CustomerInvoiceRow = {
  id: 'inv-1', invoice_number: 'INV-001', project_id: 'p', client_name: 'Acme', total_amount: 115, amount_paid: 0,
  status: 'sent', invoice_date: '2026-06-01',
};
const PAGE = '/accounting/customer-invoices/inv-1';
const onOpen = vi.fn();
const openTab = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('open', openTab);
  render(<CustomerInvoiceTable invoices={[INV]} page={1} limit={25} total={1} onPage={vi.fn()} onOpen={onOpen} />);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const link = () => screen.getByRole('link', { name: 'INV-001' });
const cell = () => screen.getByText('Acme');

describe('CustomerInvoiceTable row', () => {
  it('a plain click on a cell opens the drawer', () => {
    fireEvent.click(cell());
    expect(onOpen).toHaveBeenCalledWith('inv-1');
    expect(openTab).not.toHaveBeenCalled();
  });

  it('a plain click on the number opens the drawer once and does not navigate', () => {
    const notPrevented = fireEvent.click(link());
    expect(notPrevented).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('the number keeps its real href, which is what Ctrl and the middle button open', () => {
    expect(link().getAttribute('href')).toBe(PAGE);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }])('%o on the number is left to the browser', (mod) => {
    const notPrevented = fireEvent.click(link(), mod);
    expect(notPrevented).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
    expect(openTab, 'the browser opens it; a second tab would be a bug').not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])('%o on a cell opens the page', (mod) => {
    fireEvent.click(cell(), mod);
    expect(openTab).toHaveBeenCalledWith(PAGE, '_blank', 'noopener');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('the middle button on a cell opens the page', () => {
    fireEvent(cell(), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(openTab).toHaveBeenCalledWith(PAGE, '_blank', 'noopener');
  });

  it('the middle button on the number is left to the browser', () => {
    fireEvent(link(), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(openTab).not.toHaveBeenCalled();
  });

  it('the right button does nothing', () => {
    fireEvent(cell(), new MouseEvent('auxclick', { bubbles: true, button: 2 }));
    expect(openTab).not.toHaveBeenCalled();
  });
});
