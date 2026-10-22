/**
 * A poll response that comes back after the thing it asked about has changed must be dropped: the detail
 * hook after the id changed, the capture page after a new upload started or the status filter changed.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast, default: toast }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));

import { apiFetch } from '@/lib/apiFetch';
import { useCapturedDocument } from '@/hooks/useCapturedDocument';
import DocumentCapturePage from '../../../pages/accounting/document-capture/index';

useApiJsonOverMock();

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const ok = (data: unknown, extra: object = {}) => json({ success: true, data, ...extra });
const doc = (id: string, over: Record<string, unknown> = {}) => ({
  id, fileName: `${id}.pdf`, fileType: 'application/pdf', fileSize: 1, documentType: null, extractedData: null,
  vendorName: null, documentDate: null, referenceNumber: null, totalAmount: null, vatAmount: null, status: 'pending',
  matchedInvoiceId: null, matchedBankTxId: null, notes: null, uploadedBy: 'u', createdAt: '2026-10-22T08:00:00Z',
  readState: 'reading', readError: null, ...over,
});

/** A request the test answers by hand, later. */
interface Pending { url: string; method: string; answer: (r: Response) => void }
function hold(rules: Array<(url: string, method: string) => Response | undefined> = []) {
  const pending: Pending[] = [];
  vi.mocked(apiFetch).mockReset().mockImplementation((url, init) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    for (const rule of rules) { const r = rule(u, method); if (r) return Promise.resolve(r); }
    return new Promise<Response>((resolve) => { pending.push({ url: u, method, answer: resolve }); });
  });
  return pending;
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('useCapturedDocument', () => {
  it('a late answer for the previous id changes nothing', async () => {
    const pending = hold();
    const onLoaded = vi.fn();
    const { result, rerender } = renderHook(({ id }) => useCapturedDocument(id, onLoaded), { initialProps: { id: 'A' } });
    await flush();
    rerender({ id: 'B' });
    await flush();
    expect(pending.map((p) => p.url.split('id=')[1])).toEqual(['A', 'B']);
    await act(async () => { pending[1]!.answer(ok(doc('B', { readState: 'done' }))); });
    expect(result.current.doc?.id).toBe('B');
    await act(async () => { pending[0]!.answer(ok(doc('A', { readState: 'done' }))); });
    expect(result.current.doc?.id).toBe('B');
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded.mock.calls[0]![0].id).toBe('B');
  });

  it('a stale answer does not end the spinner of the load that is still running', async () => {
    const pending = hold();
    const { result, rerender } = renderHook(({ id }) => useCapturedDocument(id, vi.fn()), { initialProps: { id: 'A' } });
    await flush();
    rerender({ id: 'B' });
    await flush();
    await act(async () => { pending[0]!.answer(ok(doc('A', { readState: 'done' }))); });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.doc).toBeNull();
  });

  it('a late failure for the previous id shows no error', async () => {
    const pending = hold();
    const { result, rerender } = renderHook(({ id }) => useCapturedDocument(id, vi.fn()), { initialProps: { id: 'A' } });
    await flush();
    rerender({ id: 'B' });
    await flush();
    await act(async () => { pending[0]!.answer(new Response('', { status: 500 })); });
    expect(result.current.error).toBe('');
    expect(result.current.isLoading).toBe(true);
  });

  it('a stale poll answer is dropped too', async () => {
    const pending = hold();
    const onLoaded = vi.fn();
    const { result, rerender } = renderHook(({ id }) => useCapturedDocument(id, onLoaded), { initialProps: { id: 'A' } });
    await flush();
    await act(async () => { pending[0]!.answer(ok(doc('A'))); });
    await tick(3000);
    const pollA = pending[1]!;
    expect(pollA.url).toContain('id=A');
    rerender({ id: 'B' });
    await flush();
    await act(async () => { pending[2]!.answer(ok(doc('B', { readState: 'done' }))); });
    await act(async () => { pollA.answer(ok(doc('A', { readState: 'done' }))); });
    expect(result.current.doc?.id).toBe('B');
    expect(onLoaded.mock.calls.map((c) => c[0].id)).toEqual(['A', 'B']); // A's first load, then B; never A's late poll
  });
});

describe('capture page', () => {
  const file = () => new File(['x'], 'inv.pdf', { type: 'application/pdf' });
  const pick = (container: HTMLElement) => fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file()] } });
  const emptyList = (u: string, m: string) => (m === 'GET' && !u.includes('id=') ? ok([], { pagination: { total: 0 } }) : undefined);

  it('a late answer about the previous upload does not replace the new upload', async () => {
    const posts = [ok({ document: doc('A') }), ok({ document: doc('B') })];
    const pending = hold([emptyList, (_u, m) => (m === 'POST' ? posts.shift() : undefined)]);
    const { container } = render(<DocumentCapturePage />);
    await screen.findByText(/Drop a document here/);
    pick(container);
    await screen.findByText('Reading document…');
    await tick(3000);
    const pollA = pending.find((p) => p.url.includes('id=A'))!;
    pick(container);
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    await act(async () => { pollA.answer(ok(doc('A', { readState: 'done', extractedData: { vendorName: 'Stale Vendor', lineItems: [], warnings: [], confidence: 0.9 } }))); });
    expect(screen.queryByText('Extraction Results')).toBeNull();
    expect(screen.getByText('Reading document…')).toBeTruthy();
  });

  it('a late answer does not bring back a document after a new upload started', async () => {
    let hang = false;
    const pending = hold([emptyList, (_u, m) => (m === 'POST' && !hang ? ok({ document: doc('A') }) : undefined)]);
    const { container } = render(<DocumentCapturePage />);
    await screen.findByText(/Drop a document here/);
    pick(container);
    await screen.findByText('Reading document…');
    await tick(3000);
    const pollA = pending.find((p) => p.url.includes('id=A'))!;
    hang = true;
    pick(container);
    await flush();
    expect(screen.queryByText('Reading document…')).toBeNull();
    await act(async () => { pollA.answer(ok(doc('A', { readState: 'failed', readError: 'Old failure' }))); });
    expect(screen.queryByText('Old failure')).toBeNull();
  });

  it('a list poll that was asked under the old filter is dropped', async () => {
    const reading = doc('R', { fileName: 'reading.pdf' });
    const rejected = doc('X', { fileName: 'rejected.pdf', readState: 'done', status: 'rejected' });
    let firstList = true; // the page's own load answers at once; every later unfiltered list request is held
    const pending = hold([
      (u, m) => (m === 'GET' && u.includes('status=rejected') ? ok([rejected], { pagination: { total: 1 } }) : undefined),
      (u, m) => (m === 'GET' && u.endsWith('document-capture?') && firstList ? (firstList = false, ok([reading], { pagination: { total: 1 } })) : undefined),
    ]);
    render(<DocumentCapturePage />);
    await screen.findByText('reading.pdf');
    await tick(3000);
    const stalePoll = pending.find((p) => p.url.endsWith('document-capture?'))!;
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'rejected' } });
    await screen.findByText('rejected.pdf');
    await act(async () => { stalePoll.answer(ok([reading], { pagination: { total: 1 } })); });
    expect(screen.queryByText('reading.pdf')).toBeNull();
    expect(screen.getByText('rejected.pdf')).toBeTruthy();
  });

  it('a slow load under the old filter does not replace the list of the new one', async () => {
    const rejected = doc('X', { fileName: 'rejected.pdf', readState: 'done', status: 'rejected' });
    const pending = hold();
    render(<DocumentCapturePage />);
    await flush();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'rejected' } });
    await flush();
    const [oldLoad, newLoad] = pending.filter((p) => p.method === 'GET');
    expect(newLoad!.url).toContain('status=rejected');
    await act(async () => { newLoad!.answer(ok([rejected], { pagination: { total: 1 } })); });
    await act(async () => { oldLoad!.answer(ok([doc('R', { fileName: 'reading.pdf' })], { pagination: { total: 1 } })); });
    expect(screen.getByText('rejected.pdf')).toBeTruthy();
    expect(screen.queryByText('reading.pdf')).toBeNull();
  });
});
