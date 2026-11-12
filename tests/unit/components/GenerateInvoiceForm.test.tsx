/**
 * Generate Invoice form (audit 11 Nov 2026, P2.5 item 2): pick a practice client,
 * tick its unbilled WIP, preview the shared invoice totals, and post to the
 * existing WIP invoice route. Only apiFetch and the VAT hook are mocked;
 * assertOk, apiErrorMessage and invoiceTotals are the real ones.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GenerateInvoiceForm } from '@/components/accounting/practice/GenerateInvoiceForm';
import { apiFetch } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';

const vat = vi.hoisted(() => ({ value: { setting: 'bi-monthly', isRegistered: true, known: true } }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => vat.value }));
vi.mock('@/lib/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(),
}));

const CLIENTS = [
  { id: 'pc-1', legalName: 'Acme Practice Client', tradingName: null, linkCustomerId: 'cust-1' },
  { id: 'pc-2', legalName: 'Unlinked Client', tradingName: null, linkCustomerId: null },
  { id: 'pc-3', legalName: 'Quiet Client', tradingName: null, linkCustomerId: 'cust-3' },
];
const entry = (id: string, desc: string, lineTotal: number) => ({
  id, entryDate: '2026-11-01', taskDescription: desc, hours: 1, appliedRate: lineTotal, lineTotal,
  jobCategoryName: 'Advisory', workItemName: null,
});
const WIP = {
  practiceClientId: 'pc-1', legalName: 'Acme Practice Client', linkCustomerId: 'cust-1',
  totalHours: 2, totalValue: 1500, oldestApprovedDate: '2026-11-01',
  entries: [entry('te-1', 'Audit planning', 1000), entry('te-2', 'Tax review', 500)],
};

type PostHandler = (body: Record<string, unknown>) => Response;
let onPost: PostHandler;
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(() => {
  vat.value = { setting: 'bi-monthly', isRegistered: true, known: true };
  onPost = () => Response.json({ success: true, data: { invoiceId: 'inv-1', invoiceNumber: 'INV-9', subtotal: 1500, taxAmount: 225, totalAmount: 1725, lineCount: 2, skippedEntryCount: 0 } }, { status: 201 });
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST') return onPost(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (u.startsWith('/api/accounting/practice/clients')) return Response.json({ success: true, data: { clients: CLIENTS, total: 3 } });
    if (u.includes('practiceClientId=pc-1')) return Response.json({ success: true, data: [WIP] });
    if (u.includes('practiceClientId=pc-2')) return Response.json({ success: true, data: [{ ...WIP, practiceClientId: 'pc-2', linkCustomerId: null }] });
    return Response.json({ success: true, data: [] });
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

async function pick(id: string) {
  const select = await screen.findByLabelText('Client');
  await screen.findByRole('option', { name: 'Acme Practice Client' });
  fireEvent.change(select, { target: { value: id } });
}
const totalsText = () => ({
  sub: screen.getByTestId('gi-subtotal').textContent, vat: screen.getByTestId('gi-vat').textContent, total: screen.getByTestId('gi-total').textContent,
});

it('lists the active clients and fetches the picked client’s WIP by its id', async () => {
  render(<GenerateInvoiceForm />);
  await pick('pc-1');
  expect(await screen.findByText('Audit planning')).toBeInTheDocument();
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/accounting/practice/clients?status=active&limit=500');
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/accounting/practice/wip?practiceClientId=pc-1');
});

it('ticks every entry by default, and unticking one moves subtotal, VAT and total', async () => {
  render(<GenerateInvoiceForm />);
  await pick('pc-1');
  await screen.findByText('Audit planning');
  expect(screen.getByRole('checkbox', { name: 'Select entry Audit planning' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Select entry Tax review' })).toBeChecked();
  expect(totalsText()).toEqual({ sub: formatMoney(1500), vat: formatMoney(225), total: formatMoney(1725) });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select entry Tax review' }));
  expect(totalsText()).toEqual({ sub: formatMoney(1000), vat: formatMoney(150), total: formatMoney(1150) });
  expect(screen.getByText(/1 of 2 entries selected/)).toBeInTheDocument();
});

it('previews 0 VAT for a company that is not VAT registered', async () => {
  vat.value = { setting: 'none', isRegistered: false, known: true };
  render(<GenerateInvoiceForm />);
  await pick('pc-1');
  await screen.findByText('Audit planning');
  expect(screen.getByLabelText('VAT Rate (%)')).toHaveValue(0);
  expect(totalsText()).toEqual({ sub: formatMoney(1500), vat: formatMoney(0), total: formatMoney(1500) });
});

it('shows an empty state when the client has no unbilled WIP', async () => {
  render(<GenerateInvoiceForm />);
  await pick('pc-3');
  expect(await screen.findByText(/No unbilled approved time for this client/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Go to Approvals' })).toHaveAttribute('href', '/accounting/practice/approvals');
  expect(screen.queryByRole('button', { name: /generate draft invoice/i })).not.toBeInTheDocument();
});

it('points an unlinked client at its record and keeps Generate disabled', async () => {
  render(<GenerateInvoiceForm />);
  await pick('pc-2');
  await screen.findByText('Audit planning');
  expect(screen.getByRole('link', { name: 'Set the linked customer' })).toHaveAttribute('href', '/accounting/practice/clients/pc-2');
  expect(screen.getByRole('button', { name: /generate draft invoice/i })).toBeDisabled();
});

it('blocks the POST with an inline error when the due date is before the invoice date', async () => {
  render(<GenerateInvoiceForm />);
  await pick('pc-1');
  await screen.findByText('Audit planning');
  const inv = screen.getByRole('textbox', { name: /invoice date/i });
  fireEvent.change(inv, { target: { value: '2026-11-10' } }); fireEvent.blur(inv);
  const due = screen.getByRole('textbox', { name: /due date/i });
  fireEvent.change(due, { target: { value: '2026-11-05' } }); fireEvent.blur(due);
  fireEvent.click(screen.getByRole('button', { name: /generate draft invoice/i }));
  expect(await screen.findByText('Due date cannot be before the invoice date.')).toBeInTheDocument();
  expect(posts()).toHaveLength(0);
});

it('blocks the POST when no entry is selected', async () => {
  render(<GenerateInvoiceForm />);
  await pick('pc-1');
  await screen.findByText('Audit planning');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select all entries' }));
  fireEvent.click(screen.getByRole('button', { name: /generate draft invoice/i }));
  expect(await screen.findByText('Select at least one time entry.')).toBeInTheDocument();
  expect(posts()).toHaveLength(0);
});

it('shows the server’s refusal message, not "[object Object]"', async () => {
  onPost = () => Response.json({ success: false, error: { code: 'BAD_REQUEST', message: 'no eligible approved time entries in selection' } }, { status: 400 });
  render(<GenerateInvoiceForm />);
  await pick('pc-1');
  await screen.findByText('Audit planning');
  fireEvent.click(screen.getByRole('button', { name: /generate draft invoice/i }));
  expect(await screen.findByText('no eligible approved time entries in selection')).toBeInTheDocument();
  expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
});

it('posts the selection, due date and notes, then links to the draft invoice', async () => {
  render(<GenerateInvoiceForm />);
  await pick('pc-1');
  await screen.findByText('Audit planning');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select entry Tax review' }));
  const inv = screen.getByRole('textbox', { name: /invoice date/i });
  fireEvent.change(inv, { target: { value: '2026-11-05' } }); fireEvent.blur(inv);
  const due = screen.getByRole('textbox', { name: /due date/i });
  fireEvent.change(due, { target: { value: '2026-11-30' } }); fireEvent.blur(due);
  fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'October advisory' } });
  fireEvent.click(screen.getByRole('button', { name: /generate draft invoice/i }));
  const status = await screen.findByRole('status');
  expect(within(status).getByText(/Draft invoice INV-9 created/)).toBeInTheDocument();
  expect(within(status).getByRole('link', { name: 'View draft invoice' })).toHaveAttribute('href', '/accounting/customer-invoices/inv-1');
  await waitFor(() => expect(posts()).toHaveLength(1));
  const body = JSON.parse(String(posts()[0]![1]!.body)) as Record<string, unknown>;
  expect(body).toMatchObject({
    practiceClientId: 'pc-1', timeEntryIds: ['te-1'], invoiceDate: '2026-11-05', dueDate: '2026-11-30',
    notes: 'October advisory', taxRate: 15, groupBy: 'detailed',
  });
});

it('ignores a slow response for a client that is no longer picked', async () => {
  let releaseA: (r: Response) => void = () => undefined;
  const slowA = new Promise<Response>((res) => { releaseA = res; });
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).includes('practiceClientId=pc-1')) return slowA;
    return base(url, init);
  });
  render(<GenerateInvoiceForm />);
  await pick('pc-1');
  fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'pc-3' } });
  await waitFor(() => expect(screen.getByLabelText('Client')).toHaveProperty('value', 'pc-3'));
  releaseA(Response.json({ success: true, data: [{ ...WIP, entries: [entry('te-x', 'Belongs to client A', 700)] }] }));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText('Belongs to client A')).toBeNull();
});

it('does not offer an entry with no line total (the server lock would drop it)', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/accounting/practice/clients')) return Response.json({ success: true, data: { clients: CLIENTS, total: 3 } });
    if (u.includes('practiceClientId=pc-1')) {
      return Response.json({ success: true, data: [{ ...WIP, entries: [entry('te-1', 'Audit planning', 1000), { ...entry('te-9', 'No total yet', 0), lineTotal: null }] }] });
    }
    return Response.json({ success: true, data: [] });
  });
  render(<GenerateInvoiceForm />);
  await pick('pc-1');
  await screen.findByText('Audit planning');
  expect(screen.queryByText('No total yet')).not.toBeInTheDocument();
  expect(screen.getByText(/1 of 1 entries selected/)).toBeInTheDocument();
});

it('locks the client picker while the invoice is being generated', async () => {
  let release: (r: Response) => void = () => undefined;
  onPost = () => { throw new Error('unused'); };
  const base = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => (
    init?.method === 'POST' ? new Promise<Response>((r) => { release = r; }) : base(url, init)
  ));
  render(<GenerateInvoiceForm />);
  await pick('pc-1');
  await screen.findByText('Audit planning');
  fireEvent.click(screen.getByRole('button', { name: 'Generate draft invoice' }));
  await waitFor(() => expect(screen.getByLabelText('Client')).toBeDisabled());
  release(Response.json({ success: true, data: { invoiceId: 'inv-1', invoiceNumber: 'INV-9', subtotal: 1500, taxAmount: 225, totalAmount: 1725, lineCount: 2, skippedEntryCount: 0 } }, { status: 201 }));
  await waitFor(() => expect(screen.getByLabelText('Client')).not.toBeDisabled());
});
