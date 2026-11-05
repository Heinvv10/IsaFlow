/**
 * The Due by date page: defaults by_date to the end of the SAST month, shows the net position, flags
 * "No due date" money, switches AP / AR, and drills into a contact's invoices.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import Page from '../../../pages/accounting/reports/due-by-date';
import { buildDueByDateSide, netPosition } from '@/modules/accounting/utils/dueByDate';
import type { OpenAgingInvoice } from '@/modules/accounting/utils/aging';

useApiJsonOverMock();

const inv = (over: Partial<OpenAgingInvoice>): OpenAgingInvoice => ({
  id: 'i', invoiceNumber: 'INV-1', entityId: 'e', entityName: 'Entity', dueDate: '2026-11-10', dueDateMissing: false,
  totalAmount: 100, amountPaid: 0, balance: 100, invoiceDate: '2026-10-01', reference: null, ...over,
});

function report() {
  const today = '2026-11-01';
  const byDate = '2026-11-30';
  const ap = buildDueByDateSide('ap', [
    inv({ id: 'a1', invoiceNumber: 'BILL-77', entityId: 's1', entityName: 'Acme Supplies', balance: 1000, dueDate: '2026-10-20' }),
    inv({ id: 'a2', invoiceNumber: 'BILL-78', entityId: 's1', entityName: 'Acme Supplies', balance: 250, dueDateMissing: true }),
  ], today, byDate);
  const ar = buildDueByDateSide('ar', [
    inv({ id: 'r1', invoiceNumber: 'INV-9', entityId: 'c1', entityName: 'Blitz Fibre', balance: 5000, dueDate: '2026-11-15' }),
  ], today, byDate);
  return { today, byDate, ap, ar, netPosition: netPosition(ar.totals, ap.totals) };
}

beforeAll(() => {
  // 22:30 UTC on 31 Oct is already 1 Nov in South Africa: the default month is November.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-31T22:30:00Z'));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async () =>
    new Response(JSON.stringify({ success: true, data: report() }), { status: 200 }));
});
afterEach(cleanup);

describe('Due by date page', () => {
  it('asks for the end of the SAST month', async () => {
    render(<Page />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(String(vi.mocked(apiFetch).mock.calls[0]![0])).toContain('by_date=2026-11-30');
  });

  it('shows the net position, receivables less payables', async () => {
    render(<Page />);
    const net = await screen.findByTestId('net-position');
    // 5 000 receivable by the date; 1 000 payable by the date (the 250 has no due date)
    expect(net.textContent).toMatch(/4\s000\.00/);
  });

  it('shows the AP tab first with its five columns, flags No due date, and totals', async () => {
    render(<Page />);
    const table = await screen.findByRole('table');
    for (const h of ['Overdue now', 'Due today to date', 'Total by date', 'Due later', 'No due date']) {
      expect(within(table).getByText(h)).toBeTruthy();
    }
    const row = within(table).getByText('Acme Supplies').closest('tr')!;
    const flagged = within(row).getByText(/R\s250\.00/).closest('td')!;
    expect(flagged.className).toContain('amber');
    const total = within(table).getByText('Total').closest('tr')!;
    expect(total.textContent).toMatch(/^TotalR\s1\s000\.00R\s0\.00R\s1\s000\.00R\s0\.00R\s250\.00$/);
  });

  it('switches to the AR tab', async () => {
    render(<Page />);
    await screen.findByText('Acme Supplies');
    fireEvent.click(screen.getByRole('tab', { name: /Receivables/ }));
    expect(await screen.findByText('Blitz Fibre')).toBeTruthy();
    expect(screen.queryByText('Acme Supplies')).toBeNull();
  });

  it('expands a contact to its invoices, the undated one marked', async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole('button', { name: /Show invoices for Acme Supplies/ }));
    expect(screen.getByText(/BILL-77/)).toBeTruthy();
    const undated = screen.getByText(/BILL-78/).closest('tr')!;
    expect(within(undated).getByText('No due date')).toBeTruthy();
    // the amount sits in the No due date column (last), and nowhere else
    const cells = [...undated.querySelectorAll('td')].map((td) => td.textContent?.replace(/\s+/g, ' ').trim());
    expect(cells.slice(1)).toEqual(['', '', '', '', 'R 250.00']);
    const dated = screen.getByText(/BILL-77/).closest('tr')!;
    expect([...dated.querySelectorAll('td')].map((td) => td.textContent?.replace(/\s+/g, ' ').trim()).slice(1))
      .toEqual(['R 1 000.00', '', 'R 1 000.00', '', '']);
  });

  it('shows the server reason when the report is refused', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response(
      JSON.stringify({ success: false, message: 'by_date must be today or later (today is 2026-11-01)' }), { status: 400 }));
    render(<Page />);
    expect((await screen.findByRole('alert')).textContent).toContain('today or later');
  });
});
