// A statement being read is polled every 3 s. A poll that cannot succeed must not go on for ever: it
// stops on 404/403 (gone, or not ours) and after 3 failed polls in a row, and says why.
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const router = vi.hoisted(() => ({ isReady: true, query: {} as Record<string, string>, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { usePollWhileReading, type PollOutcome } from '@/hooks/usePollWhileReading';
import BankImportPage from '../../../pages/accounting/bank/statements/import-pdf';
import SupplierDetailPage from '../../../pages/accounting/ap/supplier-statements/[id]';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const failing = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, error: { message } }), { status });

const bankImp = () => ({
  id: 'i1', bankAccountId: 'b', periodStart: null, periodEnd: null, openingBalance: null, closingBalance: null,
  rowCount: 0, importedCount: 0, duplicateCount: 0, status: 'extracting', rows: [], warnings: [],
  extractionError: null, retryable: false, pagesDone: null, pagesTotal: null, createdAt: '2026-10-17T08:00:00Z', committedAt: null,
});
const supplierRecon = () => ({
  id: 'r1', supplierId: 's', supplierName: 'Acme', statementDate: '2026-10-17', periodStart: null, periodEnd: null,
  supplierBalance: null, isaflowBalance: null, variance: null, status: 'extracting', missingInIsaflowCount: 0,
  missingInStatementCount: 0, amountDiffCount: 0, lines: [], missingInvoices: [], extractionError: null,
  retryable: false, pagesDone: null, pagesTotal: null, createdAt: '2026-10-17T08:00:00Z', reconciledAt: null,
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

it('usePollWhileReading stops once a poll reports the statement is gone', async () => {
  const reload = vi.fn(async (): Promise<PollOutcome> => 'stop');
  renderHook(() => usePollWhileReading('extracting', reload));
  await tick(3000);
  expect(reload).toHaveBeenCalledTimes(1);
  await tick(15000);
  expect(reload).toHaveBeenCalledTimes(1);
});

it('usePollWhileReading stops after 3 failed polls in a row', async () => {
  const reload = vi.fn(async (): Promise<PollOutcome> => 'failed');
  renderHook(() => usePollWhileReading('extracting', reload));
  await tick(3000);
  await tick(3000);
  expect(reload).toHaveBeenCalledTimes(2);
  await tick(3000);
  expect(reload).toHaveBeenCalledTimes(3);
  await tick(30000);
  expect(reload).toHaveBeenCalledTimes(3);
});

it('usePollWhileReading counts only failures in a row: a good poll starts the count again', async () => {
  const outcomes: PollOutcome[] = ['failed', 'failed', 'ok', 'failed', 'failed', 'ok'];
  const reload = vi.fn(async (): Promise<PollOutcome> => outcomes.shift() ?? 'ok');
  renderHook(() => usePollWhileReading('extracting', reload));
  for (let i = 0; i < 6; i += 1) await tick(3000);
  expect(reload).toHaveBeenCalledTimes(6);
  await tick(3000);
  expect(reload).toHaveBeenCalledTimes(7);
});

// ── the pages ───────────────────────────────────────────────────────────────

it.each([[404, 'Statement not found'], [403, 'Not allowed']])(
  'bank: a poll answered %i stops polling and shows the error', async (status, message) => {
    router.query = { id: 'i1' };
    let n = 0;
    vi.mocked(apiFetch).mockImplementation(async () => (++n === 1 ? ok(bankImp()) : failing(status, message)));
    render(<BankImportPage />);
    await screen.findByText('Reading statement…');
    await tick(3000);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(gets()).toHaveLength(2);
    await tick(30000);
    expect(gets()).toHaveLength(2);
  });

it('bank: stops after 3 failed polls in a row (server errors) and shows the error', async () => {
  router.query = { id: 'i1' };
  let n = 0;
  vi.mocked(apiFetch).mockImplementation(async () => (++n === 1 ? ok(bankImp()) : failing(500, 'Server fell over')));
  render(<BankImportPage />);
  await screen.findByText('Reading statement…');
  for (let i = 0; i < 3; i += 1) await tick(3000);
  expect(await screen.findByText('Server fell over')).toBeTruthy();
  expect(gets()).toHaveLength(4);
  await tick(30000);
  expect(gets()).toHaveLength(4);
});

it('bank: a failed poll between good ones does not stop the polling', async () => {
  router.query = { id: 'i1' };
  const answers = [() => ok(bankImp()), () => failing(500, 'blip'), () => ok(bankImp()), () => failing(500, 'blip'), () => ok(bankImp())];
  let n = 0;
  vi.mocked(apiFetch).mockImplementation(async () => (answers[n++] ?? answers[4]!)());
  render(<BankImportPage />);
  await screen.findByText('Reading statement…');
  for (let i = 0; i < 6; i += 1) await tick(3000);
  expect(gets().length).toBeGreaterThanOrEqual(7);
});

it.each([[404, 'Reconciliation not found'], [403, 'Not allowed']])(
  'supplier: a poll answered %i stops polling and shows the error', async (status, message) => {
    router.query = { id: 'r1' };
    let n = 0;
    vi.mocked(apiFetch).mockImplementation(async () => (++n === 1 ? ok(supplierRecon()) : failing(status, message)));
    render(<SupplierDetailPage />);
    await screen.findByText('Reading statement…');
    await tick(3000);
    expect(await screen.findByText(message)).toBeTruthy();
    await tick(30000);
    expect(gets()).toHaveLength(2);
  });

it('supplier: stops after 3 failed polls in a row and shows the error', async () => {
  router.query = { id: 'r1' };
  let n = 0;
  vi.mocked(apiFetch).mockImplementation(async () => (++n === 1 ? ok(supplierRecon()) : failing(502, 'Bad gateway')));
  render(<SupplierDetailPage />);
  await screen.findByText('Reading statement…');
  for (let i = 0; i < 3; i += 1) await tick(3000);
  expect(await screen.findByText('Bad gateway')).toBeTruthy();
  expect(gets()).toHaveLength(4);
  await tick(30000);
  expect(gets()).toHaveLength(4);
});
