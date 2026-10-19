// A bank or supplier statement is read in the background: while it is 'extracting' the page polls every
// 3 s and says "Reading statement…"; a failed read shows why, with Retry (not for a too-long statement)
// and Delete. Polling stops when the read ends or the page goes.
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const router = vi.hoisted(() => ({ isReady: true, query: {} as Record<string, string>, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { usePollWhileReading } from '@/hooks/usePollWhileReading';
import BankImportPage from '../../../pages/accounting/bank/statements/import-pdf';
import BankImportsList from '../../../pages/accounting/bank/statements/index';
import SupplierDetailPage from '../../../pages/accounting/ap/supplier-statements/[id]';
import SupplierList from '../../../pages/accounting/ap/supplier-statements/index';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refused = (message: string) => new Response(JSON.stringify({ success: false, error: { message } }), { status: 409 });

const bankImp = (over: Record<string, unknown> = {}) => ({
  id: 'i1', bankAccountId: 'b', periodStart: null, periodEnd: null, openingBalance: null, closingBalance: null,
  rowCount: 0, importedCount: 0, duplicateCount: 0, status: 'extracting', rows: [], warnings: [],
  extractionError: null, retryable: false, pagesDone: null, pagesTotal: null, createdAt: '2026-10-17T08:00:00Z', committedAt: null, ...over,
});
const supplierRecon = (over: Record<string, unknown> = {}) => ({
  id: 'r1', supplierId: 's', supplierName: 'Acme', statementDate: '2026-10-17', periodStart: null, periodEnd: null,
  supplierBalance: 0, isaflowBalance: 0, variance: 0, status: 'extracting', missingInIsaflowCount: 0,
  missingInStatementCount: 0, amountDiffCount: 0, lines: [], missingInvoices: [], extractionError: null,
  retryable: false, pagesDone: null, pagesTotal: null, createdAt: '2026-10-17T08:00:00Z', reconciledAt: null, ...over,
});

const gets = () => vi.mocked(apiFetch).mock.calls.filter((c) => !c[1]?.method || c[1].method === 'GET');
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  router.push.mockReset();
  router.query = {};
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(apiFetch).mockReset();
});

// ── the hook ────────────────────────────────────────────────────────────────

it('usePollWhileReading calls reload every 3 s while extracting, and stops once the status changes', async () => {
  const reload = vi.fn(async () => undefined);
  const { rerender } = renderHook(({ status }) => usePollWhileReading(status, reload), { initialProps: { status: 'extracting' } });
  expect(reload).not.toHaveBeenCalled();
  await tick(3000);
  expect(reload).toHaveBeenCalledTimes(1);
  await tick(3000);
  expect(reload).toHaveBeenCalledTimes(2);
  rerender({ status: 'extracted' });
  await tick(12000);
  expect(reload).toHaveBeenCalledTimes(2);
});

it('usePollWhileReading never polls a statement that is not extracting', async () => {
  const reload = vi.fn(async () => undefined);
  renderHook(() => usePollWhileReading('extracted', reload));
  await tick(12000);
  expect(reload).not.toHaveBeenCalled();
});

it('usePollWhileReading stops when the page unmounts', async () => {
  const reload = vi.fn(async () => undefined);
  const { unmount } = renderHook(() => usePollWhileReading('extracting', reload));
  await tick(3000);
  unmount();
  await tick(12000);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('usePollWhileReading waits for a slow reload before scheduling the next', async () => {
  let release: () => void = () => undefined;
  const reload = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  renderHook(() => usePollWhileReading('extracting', reload));
  await tick(3000);
  await tick(9000);
  expect(reload).toHaveBeenCalledTimes(1);
  release();
  await tick(3000);
  expect(reload).toHaveBeenCalledTimes(2);
});

it('usePollWhileReading does not schedule another call when the page unmounted during one', async () => {
  let release: () => void = () => undefined;
  const reload = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const { unmount } = renderHook(() => usePollWhileReading('extracting', reload));
  await tick(3000);
  expect(reload).toHaveBeenCalledTimes(1);
  unmount();
  release();
  await tick(12000);
  expect(reload).toHaveBeenCalledTimes(1);
});

// ── bank import page ────────────────────────────────────────────────────────

it('bank: shows "Reading statement…" with the page, polls, and shows the rows once extracted — then stops', async () => {
  router.query = { id: 'i1' };
  let n = 0;
  vi.mocked(apiFetch).mockImplementation(async () => {
    n += 1;
    if (n === 1) return ok(bankImp({ pagesDone: 2, pagesTotal: 9 }));
    return ok(bankImp({
      status: 'extracted', rowCount: 1,
      rows: [{ date: '2026-03-05', description: 'Shop', reference: null, amount: -10, runningBalance: null, isDuplicate: false }],
    }));
  });
  render(<BankImportPage />);
  expect(await screen.findByText('Reading statement…')).toBeTruthy();
  expect(screen.getByText(/Page 3 of 9/)).toBeTruthy();
  expect(gets()).toHaveLength(1);

  await tick(3000);
  expect(await screen.findByText('Shop')).toBeTruthy();
  expect(screen.queryByText('Reading statement…')).toBeNull();
  expect(gets()).toHaveLength(2);

  await tick(15000);
  expect(gets()).toHaveLength(2);
});

it('bank: stops polling when the page unmounts', async () => {
  router.query = { id: 'i1' };
  vi.mocked(apiFetch).mockImplementation(async () => ok(bankImp()));
  const { unmount } = render(<BankImportPage />);
  await screen.findByText('Reading statement…');
  await tick(3000);
  expect(gets()).toHaveLength(2);
  unmount();
  await tick(15000);
  expect(gets()).toHaveLength(2);
});

it('bank: a failed read shows why, with Retry; Retry posts to /retry and goes back to reading', async () => {
  router.query = { id: 'i1' };
  const calls: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/retry')) return ok(bankImp());
    return ok(calls.some((c) => c.endsWith('/retry'))
      ? bankImp()
      : bankImp({ status: 'failed', extractionError: 'Page 2 of 3 could not be read. Retry the import.', retryable: true }));
  });
  render(<BankImportPage />);
  expect(await screen.findByText('Page 2 of 3 could not be read. Retry the import.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
  expect(await screen.findByText('Reading statement…')).toBeTruthy();
  expect(calls).toContain('POST /api/accounting/bank-statements/i1/retry');
});

it('bank: a statement with too many pages shows why and offers Delete but no Retry', async () => {
  router.query = { id: 'i1' };
  vi.mocked(apiFetch).mockImplementation(async () => ok(bankImp({
    status: 'failed', retryable: false,
    extractionError: "This statement has 31 pages; the most IsaFlow reads is 20. Split it into smaller files, or import the bank's CSV export.",
  })));
  render(<BankImportPage />);
  expect(await screen.findByText(/This statement has 31 pages/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Delete/ })).toBeTruthy();
});

it('bank: Delete sends DELETE and returns to the list', async () => {
  router.query = { id: 'i1' };
  const calls: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'DELETE') return ok({ deleted: true });
    return ok(bankImp({ status: 'failed', extractionError: 'x', retryable: true }));
  });
  render(<BankImportPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Delete/ }));
  await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/accounting/bank/statements'));
  expect(calls).toContain('DELETE /api/accounting/bank-statements/i1');
});

it('bank: a refused retry shows the server\'s reason', async () => {
  router.query = { id: 'i1' };
  vi.mocked(apiFetch).mockImplementation(async (url: string) => (url.endsWith('/retry')
    ? refused('This statement is still being read.')
    : ok(bankImp({ status: 'failed', extractionError: 'x', retryable: true }))));
  render(<BankImportPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Retry/ }));
  expect(await screen.findByText('This statement is still being read.')).toBeTruthy();
});

// ── supplier detail page ────────────────────────────────────────────────────

it('supplier: shows "Reading statement…", polls, and shows the reconciliation once read — then stops', async () => {
  router.query = { id: 'r1' };
  let n = 0;
  vi.mocked(apiFetch).mockImplementation(async () => {
    n += 1;
    return ok(n === 1 ? supplierRecon() : supplierRecon({ status: 'unreconciled', supplierBalance: 115, variance: 115 }));
  });
  render(<SupplierDetailPage />);
  expect(await screen.findByText('Reading statement…')).toBeTruthy();
  await tick(3000);
  expect(await screen.findByText('Statement lines')).toBeTruthy();
  expect(screen.queryByText('Reading statement…')).toBeNull();
  await tick(15000);
  expect(gets()).toHaveLength(2);
});

it('supplier: a failed read shows why with Retry, and a too-long one only Delete', async () => {
  router.query = { id: 'r1' };
  vi.mocked(apiFetch).mockImplementation(async () => ok(supplierRecon({ status: 'failed', extractionError: 'Extraction was interrupted — retry it.', retryable: true })));
  const first = render(<SupplierDetailPage />);
  expect(await screen.findByText('Extraction was interrupted — retry it.')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  first.unmount();

  vi.mocked(apiFetch).mockImplementation(async () => ok(supplierRecon({ status: 'failed', extractionError: 'This statement has 31 pages', retryable: false })));
  render(<SupplierDetailPage />);
  expect(await screen.findByText(/This statement has 31 pages/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
});

it('supplier: Retry posts to /retry', async () => {
  router.query = { id: 'r1' };
  const calls: string[] = [];
  vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    return ok(supplierRecon({ status: 'failed', extractionError: 'x', retryable: true }));
  });
  render(<SupplierDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Retry/ }));
  await vi.waitFor(() => expect(calls).toContain('POST /api/accounting/supplier-statements/r1/retry'));
});

// ── the lists ───────────────────────────────────────────────────────────────

it('bank list: a statement being read, and a failed one, show their state instead of crashing', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => ok([bankImp({ id: 'a' }), bankImp({ id: 'b', status: 'failed' })]));
  render(<BankImportsList />);
  expect(await screen.findByText('Reading…')).toBeTruthy();
  expect(screen.getByText('Failed')).toBeTruthy();
});

it('supplier list: a statement being read, and a failed one, show their state and no figures (null renders as a dash)', async () => {
  const unread = { statementDate: null, supplierBalance: null, isaflowBalance: null, variance: null };
  vi.mocked(apiFetch).mockImplementation(async () => ok([
    supplierRecon({ id: 'a', ...unread }), supplierRecon({ id: 'b', status: 'failed', supplierName: 'Beta', ...unread }),
  ]));
  const { container } = render(<SupplierList />);
  expect(await screen.findByText('Reading…')).toBeTruthy();
  expect(screen.getByText('Failed')).toBeTruthy();
  expect(container.textContent).not.toMatch(/R\s0[.,]00/);
  expect(container.textContent).not.toMatch(/Invalid Date|NaN|1970/);
  const cells = Array.from(container.querySelectorAll('tbody tr:first-child td')).map((td) => td.textContent);
  expect(cells[0]).toBe('—'); // statement date
  expect(cells.slice(3, 6)).toEqual(['—', '—', '—']); // supplier bal., IsaFlow bal., variance
});

it('supplier list: a statement that has been read shows its figures, a genuine zero variance included', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => ok([
    supplierRecon({ id: 'a', status: 'unreconciled', supplierBalance: 115.5, isaflowBalance: 115.5, variance: 0 }),
  ]));
  const { container } = render(<SupplierList />);
  await screen.findByText('Unreconciled');
  const cells = Array.from(container.querySelectorAll('tbody tr:first-child td')).map((td) => td.textContent ?? '');
  expect(cells[3]).toMatch(/R\s115[.,]50/);
  expect(cells[5]).toMatch(/R\s0[.,]00/);
});
