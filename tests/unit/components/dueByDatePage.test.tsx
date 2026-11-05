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
import { reportWithoutInvoices, buildDueByDateSide, netPosition } from '@/modules/accounting/utils/dueByDate';
import { typeDate } from '../helpers/dateFields';
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
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status });

/** The summary has no invoices; one contact's drill-down is asked for with side + entity_id. */
async function serve(url: unknown): Promise<Response> {
  const q = new URL(String(url), 'http://x').searchParams;
  const full = report();
  if (q.get('entity_id')) {
    const side = full[q.get('side') as 'ap' | 'ar'];
    return json({ today: full.today, byDate: full.byDate, side: side.side, contact: side.contacts.find((c) => c.contactId === q.get('entity_id')) });
  }
  return json(reportWithoutInvoices(full));
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(serve);
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
    expect(await screen.findByText(/BILL-77/)).toBeTruthy();
    const undated = screen.getByText(/BILL-78/).closest('tr')!;
    expect(within(undated).getByText('No due date')).toBeTruthy();
    // the amount sits in the No due date column (last), and nowhere else
    const cells = [...undated.querySelectorAll('td')].map((td) => td.textContent?.replace(/\s+/g, ' ').trim());
    expect(cells.slice(1)).toEqual(['', '', '', '', 'R 250.00']);
    const dated = screen.getByText(/BILL-77/).closest('tr')!;
    expect([...dated.querySelectorAll('td')].map((td) => td.textContent?.replace(/\s+/g, ' ').trim()).slice(1))
      .toEqual(['R 1 000.00', '', 'R 1 000.00', '', '']);
  });

  it('reads no invoices until a contact is opened, then one contact only, once', async () => {
    render(<Page />);
    const open = await screen.findByRole('button', { name: /Show invoices for Acme Supplies/ });
    const urls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => new URL(String(u), 'http://x').searchParams);
    expect(urls().filter((q) => q.get('entity_id'))).toEqual([]);
    fireEvent.click(open);
    await screen.findByText(/BILL-77/);
    const asked = urls().filter((q) => q.get('entity_id'));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.get('entity_id')).toBe('s1');
    expect(asked[0]!.get('side')).toBe('ap');
    expect(asked[0]!.get('by_date')).toBe('2026-11-30');
    // close and open again: the invoices in hand are shown, not fetched again
    fireEvent.click(screen.getByRole('button', { name: /Hide invoices for Acme Supplies/ }));
    fireEvent.click(screen.getByRole('button', { name: /Show invoices for Acme Supplies/ }));
    await screen.findByText(/BILL-77/);
    expect(urls().filter((q) => q.get('entity_id'))).toHaveLength(1);
  });

  it('says so when a contact\'s invoices cannot be read, and retries on reopen', async () => {
    render(<Page />);
    const open = await screen.findByRole('button', { name: /Show invoices for Acme Supplies/ });
    vi.mocked(apiFetch).mockImplementation(async (url) => (String(url).includes('entity_id')
      ? new Response(JSON.stringify({ success: false, message: 'Database is busy' }), { status: 500 })
      : serve(url)));
    fireEvent.click(open);
    expect((await screen.findByText(/Database is busy/)).textContent).toContain('retry');
    vi.mocked(apiFetch).mockImplementation(serve);
    fireEvent.click(screen.getByRole('button', { name: /Hide invoices for Acme Supplies/ }));
    fireEvent.click(screen.getByRole('button', { name: /Show invoices for Acme Supplies/ }));
    expect(await screen.findByText(/BILL-77/)).toBeTruthy();
  });

  it('says what the net position leaves out: documents with no due date, payables and receivables', async () => {
    render(<Page />);
    const note = await screen.findByTestId('net-excludes');
    // AP has R 250 with no due date; AR has none
    expect(note.textContent).toMatch(/^Excludes R\s250\.00 payables and R\s0\.00 receivables with no due date\.$/);
  });

  it('shows the report for the date on screen when a slower answer for an earlier date arrives last', async () => {
    const early = report();
    const later = report();
    later.ap.contacts[0]!.contactName = 'Later Date Supplies';
    const pending = new Map<string, (r: Response) => void>();
    vi.mocked(apiFetch).mockReset().mockImplementation((url) => new Promise<Response>((resolve) => {
      pending.set(new URL(String(url), 'http://x').searchParams.get('by_date')!, resolve);
    }));
    render(<Page />);
    await waitFor(() => expect(pending.has('2026-11-30')).toBe(true));
    typeDate(screen.getByRole('textbox', { name: 'Due by date' }), '15 Dec 2026');
    await waitFor(() => expect(pending.has('2026-12-15')).toBe(true));
    pending.get('2026-12-15')!(json(reportWithoutInvoices({ ...later, byDate: '2026-12-15' })));
    expect(await screen.findByText('Later Date Supplies')).toBeTruthy();
    // the slow answer for 30 Nov now lands, last
    pending.get('2026-11-30')!(json(reportWithoutInvoices(early)));
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(screen.getByText('Later Date Supplies')).toBeTruthy();
    expect(screen.queryByText('Acme Supplies')).toBeNull();
    expect(screen.getByTestId('net-position').textContent).toContain('2026-12-15');
  });

  it('does not let a slower FAILURE for an earlier date wipe the report for the date on screen', async () => {
    const pending = new Map<string, (r: Response) => void>();
    vi.mocked(apiFetch).mockReset().mockImplementation((url) => new Promise<Response>((resolve) => {
      pending.set(new URL(String(url), 'http://x').searchParams.get('by_date')!, resolve);
    }));
    render(<Page />);
    await waitFor(() => expect(pending.has('2026-11-30')).toBe(true));
    typeDate(screen.getByRole('textbox', { name: 'Due by date' }), '15 Dec 2026');
    await waitFor(() => expect(pending.has('2026-12-15')).toBe(true));
    pending.get('2026-12-15')!(json(reportWithoutInvoices({ ...report(), byDate: '2026-12-15' })));
    await screen.findByText('Acme Supplies');
    pending.get('2026-11-30')!(new Response(JSON.stringify({ success: false, message: 'Database is busy' }), { status: 500 }));
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(screen.getByText('Acme Supplies')).toBeTruthy();
    expect(screen.queryByText(/Database is busy/)).toBeNull();
  });

  it('shows the server reason when the report is refused', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response(
      JSON.stringify({ success: false, message: 'by_date must be today or later (today is 2026-11-01)' }), { status: 400 }));
    render(<Page />);
    expect((await screen.findByRole('alert')).textContent).toContain('today or later');
  });
});
