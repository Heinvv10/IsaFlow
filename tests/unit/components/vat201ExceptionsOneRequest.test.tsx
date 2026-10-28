// One Generate means one GET /api/accounting/sars/vat-exceptions. React StrictMode (on in dev) runs the panel's
// mount effect twice, and the period-lock form reads the same report: both share the in-flight request.
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
const company = vi.hoisted(() => ({ id: 'co1' }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', activeCompany: { id: company.id } }) }));

import { apiFetch } from '@/lib/apiFetch';
import { VAT201ExceptionsPanel } from '@/components/accounting/sars/VAT201ExceptionsPanel';
import { fetchVatExceptions } from '@/components/accounting/sars/vatExceptionsFetch';
import type { VatExceptionsReport } from '@/modules/accounting/services/reports/vatExceptionsTypes';

const report: VatExceptionsReport = {
  periodStart: '2026-07-01', periodEnd: '2026-08-31',
  uncodedGlLines: [], uncodedGlLineCount: 0,
  invoiceTaxCodeIssues: [], invoiceTaxCodeIssueCount: 0,
  billTaxCodeWarnings: [], billTaxCodeWarningCount: 0, billTaxCodeWarningPotentialVat: 0,
  invoiceGlMismatches: [], invoiceGlMismatchCount: 0,
  vatOnBalanceSheetLines: [], vatOnBalanceSheetCount: 0,
  vatNonSupplyLines: [], vatNonSupplyCount: 0,
  controlRecon: {
    outputVat201: 0, outputGl: 0, outputVariance: 0, inputVat201: 0, inputGl: 0, inputVariance: 0,
    netVat201: 0, netGl: 0, netVariance: 0, unpostedCustomerVat: 0, unpostedCustomerCount: 0,
    unpostedSupplierVat: 0, unpostedSupplierCount: 0,
  },
  unpostedInvoiceVat: [], unpostedInvoiceVatCount: 0,
  declaredElsewhereVat: [], declaredElsewhereVatCount: 0,
  unsupportedInputVat: [], unsupportedInputVatCount: 0,
  inputVatWithoutTaxInvoice: [], inputVatWithoutTaxInvoiceCount: 0,
  totalExceptions: 0,
  degradedData: false,
  degradedSources: [],
};


afterEach(() => { vi.clearAllMocks(); company.id = 'co1'; });

const ok = () => new Response(JSON.stringify({ success: true, data: report }), { status: 200 });
const exceptionCalls = () => vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).includes('vat-exceptions')).length;

it('the panel sends one request when StrictMode mounts its effect twice', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => ok());
  render(<StrictMode><VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={1} /></StrictMode>);
  await waitFor(() => expect(screen.getByText('No exceptions')).toBeTruthy());
  expect(exceptionCalls()).toBe(1);
});

it('two callers asking for the same period at once share one request; a later ask sends a fresh one', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => ok());
  const [a, b] = await Promise.all([
    fetchVatExceptions('2026-07-01', '2026-08-31', 'failed', 'test'),
    fetchVatExceptions('2026-07-01', '2026-08-31', 'failed', 'test'),
  ]);
  expect(a).toEqual(b);
  expect(exceptionCalls()).toBe(1);
  await fetchVatExceptions('2026-07-01', '2026-08-31', 'failed', 'test');
  expect(exceptionCalls()).toBe(2);
});

it('a different period is its own request', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => ok());
  await Promise.all([
    fetchVatExceptions('2026-07-01', '2026-08-31', 'failed', 'test'),
    fetchVatExceptions('2026-09-01', '2026-10-31', 'failed', 'test'),
  ]);
  expect(exceptionCalls()).toBe(2);
});

const gate = () => { let release!: () => void; const wait = new Promise<void>((r) => { release = r; }); return { wait, release }; };

it('the same period for a different company is its own request, so a company switch never hands over the old report', async () => {
  const a = { ...report, totalExceptions: 7 };
  const b = { ...report, totalExceptions: 0 };
  const hold = gate();
  let n = 0;
  vi.mocked(apiFetch).mockImplementation(async () => { const mine = ++n === 1 ? a : b; await hold.wait; return new Response(JSON.stringify({ success: true, data: mine }), { status: 200 }); });
  const first = fetchVatExceptions('2026-07-01', '2026-08-31', 'failed', 'test', { companyId: 'co1' });
  const second = fetchVatExceptions('2026-07-01', '2026-08-31', 'failed', 'test', { companyId: 'co2' });
  hold.release();
  expect(await first).toMatchObject({ totalExceptions: 7 });
  expect(await second).toMatchObject({ totalExceptions: 0 });
  expect(exceptionCalls()).toBe(2);
});

it('an explicit reload while a request is in flight sends a new one', async () => {
  const hold = gate();
  vi.mocked(apiFetch).mockImplementation(async () => { await hold.wait; return ok(); });
  const first = fetchVatExceptions('2026-07-01', '2026-08-31', 'failed', 'test', { companyId: 'co1' });
  const again = fetchVatExceptions('2026-07-01', '2026-08-31', 'failed', 'test', { companyId: 'co1', fresh: true });
  hold.release();
  await Promise.all([first, again]);
  expect(exceptionCalls()).toBe(2);
});

it('Generate clicked while the panel is loading asks the server again', async () => {
  const hold = gate();
  vi.mocked(apiFetch).mockImplementation(async () => { await hold.wait; return ok(); });
  const { rerender } = render(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={1} />);
  await waitFor(() => expect(exceptionCalls()).toBe(1));
  rerender(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={2} />);
  await waitFor(() => expect(exceptionCalls()).toBe(2));
  hold.release();
  await waitFor(() => expect(screen.getByText('No exceptions')).toBeTruthy());
});

it('a company switch while the panel is loading asks for the new company\'s report', async () => {
  const hold = gate();
  vi.mocked(apiFetch).mockImplementation(async () => { await hold.wait; return ok(); });
  const view = render(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={1} />);
  await waitFor(() => expect(exceptionCalls()).toBe(1));
  company.id = 'co2';
  view.rerender(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={1} />);
  await waitFor(() => expect(exceptionCalls()).toBe(2));
  hold.release();
});

const PANEL_FAILED = 'Could not load exceptions - try again';
const LOCK_FAILED = 'Could not check the VAT exceptions for this period - the server will check again when you lock it';
const refused = (message?: string) => new Response(message ? JSON.stringify({ success: false, error: { message } }) : '', { status: message ? 400 : 500 });

it('the panel and the lock form share one request, and each gets its own message when the server says nothing', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => refused());
  const [panel, lock] = await Promise.allSettled([
    fetchVatExceptions('2026-07-01', '2026-08-31', PANEL_FAILED, 'panel', { companyId: 'co1' }),
    fetchVatExceptions('2026-07-01', '2026-08-31', LOCK_FAILED, 'lock', { companyId: 'co1' }),
  ]);
  expect(exceptionCalls()).toBe(1);
  expect(panel).toMatchObject({ status: 'rejected', reason: { message: PANEL_FAILED, status: 500 } });
  expect(lock).toMatchObject({ status: 'rejected', reason: { message: LOCK_FAILED, status: 500 } });
});

it('a message the server sent reaches both sharing callers instead of either fallback', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => refused('Period is not open'));
  const [panel, lock] = await Promise.allSettled([
    fetchVatExceptions('2026-07-01', '2026-08-31', PANEL_FAILED, 'panel'),
    fetchVatExceptions('2026-07-01', '2026-08-31', LOCK_FAILED, 'lock'),
  ]);
  expect(exceptionCalls()).toBe(1);
  expect(panel).toMatchObject({ status: 'rejected', reason: { message: 'Period is not open' } });
  expect(lock).toMatchObject({ status: 'rejected', reason: { message: 'Period is not open' } });
});

it('a reload after an unmark is fresh: it never joins the request that was already running before the write', async () => {
  const withItem: VatExceptionsReport = {
    ...report,
    declaredElsewhereVatCount: 1,
    declaredElsewhereVat: [{ invoiceId: 'ci-1', invoiceKind: 'customer', invoiceNumber: 'INV-1', counterpartyName: 'Acme', invoiceDate: '2026-07-01', vat: 150, markedAt: '2026-08-01', markedBy: 'u1', markedByName: 'Ann', markedReason: 'old' }],
  };
  const hold = gate();
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    if (String(url).includes('vat-declared-elsewhere')) return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    reads += 1;
    if (reads === 1) return new Response(JSON.stringify({ success: true, data: withItem }), { status: 200 });
    await hold.wait; // the Generate click's request: started before the unmark, so its report is pre-write
    return new Response(JSON.stringify({ success: true, data: reads === 2 ? withItem : report }), { status: 200 });
  });
  const { rerender } = render(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={1} />);
  await screen.findByText('INV-1');
  rerender(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={2} />);
  await waitFor(() => expect(exceptionCalls()).toBe(2));
  fireEvent.click(screen.getByRole('button', { name: 'Unmark' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Declared in error' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm unmark' }));
  await waitFor(() => expect(exceptionCalls()).toBe(3));
  hold.release();
});

it('an older request that resolves after the fresh reload cannot overwrite the report or the eFiling gate', async () => {
  const withItem: VatExceptionsReport = {
    ...report,
    totalExceptions: 1,
    declaredElsewhereVatCount: 1,
    declaredElsewhereVat: [{ invoiceId: 'ci-1', invoiceKind: 'customer', invoiceNumber: 'INV-1', counterpartyName: 'Acme', invoiceDate: '2026-07-01', vat: 150, markedAt: '2026-08-01', markedBy: 'u1', markedByName: 'Ann', markedReason: 'old' }],
  };
  const hold = gate();
  const json = (data: VatExceptionsReport) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
  let reads = 0;
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
    if (String(url).includes('vat-declared-elsewhere')) return json({} as VatExceptionsReport);
    reads += 1;
    if (reads === 1) return json(withItem);
    if (reads === 2) { await hold.wait; return json(withItem); } // pre-write request, resolves last
    return json(report); // the fresh reload after the unmark
  });
  const onLoaded = vi.fn();
  const { rerender } = render(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={1} onLoaded={onLoaded} />);
  await screen.findByText('INV-1');
  rerender(<VAT201ExceptionsPanel from="2026-07-01" to="2026-08-31" reloadKey={2} onLoaded={onLoaded} />);
  await waitFor(() => expect(exceptionCalls()).toBe(2));
  fireEvent.click(screen.getByRole('button', { name: 'Unmark' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Declared in error' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm unmark' }));
  await waitFor(() => expect(screen.getByText('No exceptions')).toBeTruthy());
  expect(onLoaded).toHaveBeenLastCalledWith(report);
  const callsBefore = onLoaded.mock.calls.length;
  hold.release();
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.getByText('No exceptions')).toBeTruthy();
  expect(screen.queryByText('INV-1')).toBeNull();
  expect(onLoaded).toHaveBeenCalledTimes(callsBefore);
});
