// A statement being read is polled every 3 s. It stops on 404/403 (gone, or not ours) and says why. Any other
// failed poll (a deploy restart, a blip) is not the end of the read: the polling backs off, doubling up to 60 s,
// keeps the error on screen, and picks the result up when the server is back.
import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const bankImp = (over: Record<string, unknown> = {}) => ({
  id: 'i1', bankAccountId: 'b', periodStart: null, periodEnd: null, openingBalance: null, closingBalance: null,
  rowCount: 0, importedCount: 0, duplicateCount: 0, status: 'extracting', rows: [], warnings: [],
  extractionError: null, retryable: false, pagesDone: null, pagesTotal: null, createdAt: '2026-10-17T08:00:00Z', committedAt: null, ...over,
});
const supplierRecon = () => ({
  id: 'r1', supplierId: 's', supplierName: 'Acme', statementDate: '2026-10-17', periodStart: null, periodEnd: null,
  supplierBalance: null, isaflowBalance: null, variance: null, status: 'extracting', missingInIsaflowCount: 0,
  missingInStatementCount: 0, amountDiffCount: 0, lines: [], missingInvoices: [], extractionError: null,
  retryable: false, pagesDone: null, pagesTotal: null, createdAt: '2026-10-17T08:00:00Z', reconciledAt: null,
});

const gets = () => vi.mocked(apiFetch).mock.calls.filter((c) => !c[1]?.method || c[1].method === 'GET');
const polls = () => gets().filter((c) => String(c[0]).includes('/bank-statements/i1'));
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

// The hook tests assert on 1 ms edges (5999 then 1), so they run on pure fake timers: with `shouldAdvanceTime`
// real wall time leaks into the fake clock, and on a loaded machine 1 ms of it is enough to fire a timer early.
describe('usePollWhileReading', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('usePollWhileReading stops once a poll reports the statement is gone', async () => {
    const reload = vi.fn(async (): Promise<PollOutcome> => 'stop');
    renderHook(() => usePollWhileReading('extracting', reload));
    await tick(3000);
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(15000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('usePollWhileReading backs off after a bad poll, doubling the wait up to 60 s, and never gives up', async () => {
    const reload = vi.fn(async (): Promise<PollOutcome> => 'bad');
    renderHook(() => usePollWhileReading('extracting', reload));
    await tick(3000);            // poll 1 at 3 s
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(5999);            // next waits 6 s
    expect(reload).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(reload).toHaveBeenCalledTimes(2);
    await tick(11999);           // then 12 s
    expect(reload).toHaveBeenCalledTimes(2);
    await tick(1);
    expect(reload).toHaveBeenCalledTimes(3);
    await tick(24000);           // 24 s
    await tick(48000);           // 48 s
    expect(reload).toHaveBeenCalledTimes(5);
    await tick(59999);           // capped at 60 s from here on
    expect(reload).toHaveBeenCalledTimes(5);
    await tick(1);
    expect(reload).toHaveBeenCalledTimes(6);
    await tick(60000);
    expect(reload).toHaveBeenCalledTimes(7);
    await tick(60000);
    expect(reload).toHaveBeenCalledTimes(8);
  });

  it('usePollWhileReading goes back to the normal interval after a good poll', async () => {
    const outcomes: PollOutcome[] = ['bad', 'bad', 'ok'];
    const reload = vi.fn(async (): Promise<PollOutcome> => outcomes.shift() ?? 'ok');
    renderHook(() => usePollWhileReading('extracting', reload));
    await tick(3000 + 6000 + 12000);
    expect(reload).toHaveBeenCalledTimes(3);
    await tick(3000);
    expect(reload).toHaveBeenCalledTimes(4);
    await tick(3000);
    expect(reload).toHaveBeenCalledTimes(5);
  });
});

// ── the pages ───────────────────────────────────────────────────────────────
// The pages are searched with findBy*, which waits in real time, so the clock here also moves with it: no "not yet"
// check below sits closer than 2.5 s under a timer edge (the clock only runs ahead, so the "has fired" checks sit past it).
describe('the pages', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    router.push.mockReset();
    router.query = {};
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(apiFetch).mockReset();
  });


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

  it('bank: a server error does not end the polling: the error shows, the wait grows, and the result is picked up when the server is back', async () => {
    router.query = { id: 'i1' };
    let n = 0;
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (!url.includes('/bank-statements/i1')) return ok([]);
      n += 1;
      if (n === 1) return ok(bankImp());
      return n <= 5 ? failing(502, 'Server fell over') : ok(bankImp({ status: 'extracted', rowCount: 1 }));
    });
    render(<BankImportPage />);
    await screen.findByText('Reading statement…');
    // The clock also moves with real time while the page is searched, so each "not yet" check keeps clear of its edge:
    // 2.5 s at the tightest (poll 2 due at 9 s, checked at 6.5 s; poll 3 due at 21 s, checked at 18.5 s), 3 s and 7 s after.
    await tick(3000);            // poll 1 fails; the next waits 6 s
    expect(await screen.findByText('Server fell over')).toBeTruthy();
    expect(polls()).toHaveLength(2);
    await tick(3500);
    expect(polls()).toHaveLength(2);
    await tick(3500);            // poll 2; then 12 s
    expect(polls()).toHaveLength(3);
    await tick(8500);
    expect(polls()).toHaveLength(3);
    await tick(3500);            // poll 3; then 24 s
    expect(polls()).toHaveLength(4);
    expect(screen.getByText('Server fell over')).toBeTruthy();
    await tick(20000);
    expect(polls()).toHaveLength(4);
    await tick(4000);            // poll 4, still failing; then 48 s
    expect(polls()).toHaveLength(5);
    await tick(40000);
    expect(polls()).toHaveLength(5);
    await tick(10000);           // poll 5: the server is back, the read is done
    await vi.waitFor(() => expect(screen.queryByText('Server fell over')).toBeNull());
    expect(screen.queryByText('Reading statement…')).toBeNull();
    const settled = polls().length;
    expect(settled).toBeGreaterThanOrEqual(6);
    await tick(120000);          // finished: no more polls
    expect(polls()).toHaveLength(settled);
  });

  it('bank: a failed poll between good ones does not stop the polling', async () => {
    router.query = { id: 'i1' };
    const answers = [() => ok(bankImp()), () => failing(500, 'blip'), () => ok(bankImp()), () => failing(500, 'blip'), () => ok(bankImp())];
    let n = 0;
    vi.mocked(apiFetch).mockImplementation(async () => (answers[n++] ?? answers[4]!)());
    render(<BankImportPage />);
    await screen.findByText('Reading statement…');
    for (let i = 0; i < 10; i += 1) await tick(3000);   // a blip costs one longer wait, then the 3 s rhythm is back
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

  it('supplier: a server error does not end the polling: the error shows and the poll is tried again after a longer wait', async () => {
    router.query = { id: 'r1' };
    let n = 0;
    vi.mocked(apiFetch).mockImplementation(async () => (++n === 1 ? ok(supplierRecon()) : failing(502, 'Bad gateway')));
    render(<SupplierDetailPage />);
    await screen.findByText('Reading statement…');
    await tick(3000);            // poll 1 fails; the next waits 6 s
    expect(await screen.findByText('Bad gateway')).toBeTruthy();
    expect(gets()).toHaveLength(2);
    await tick(3500);
    expect(gets()).toHaveLength(2);
    await tick(3500);            // poll 2
    expect(gets()).toHaveLength(3);
    expect(screen.getByText('Bad gateway')).toBeTruthy();
    await tick(11500);           // poll 3 (12 s after poll 2)
    expect(gets()).toHaveLength(4);
  });
});
