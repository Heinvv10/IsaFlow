/**
 * A captured document is read in the background (design 2026-10-22): the upload answers at once with a
 * 'reading' document, the page polls GET ?id= every 3 s until it is 'done' or 'failed', the list shows a
 * badge, the detail page disables its actions while reading, and Scan & Fill polls GET ?job= every 2 s.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const router = vi.hoisted(() => ({ isReady: true, query: { docId: 'd1' } as Record<string, string>, push: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast, default: toast }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));

import { apiFetch } from '@/lib/apiFetch';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { DocumentList } from '@/components/accounting/document-capture/DocumentList';
import DocumentCapturePage from '../../../pages/accounting/document-capture/index';
import DocumentDetailPage from '../../../pages/accounting/document-capture/[docId]';

useApiJsonOverMock();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown, extra: object = {}) => json({ success: true, data, ...extra });
const refused = (message: string, status: number) => json({ success: false, error: { message } }, status);

const EXTRACTED = {
  documentType: 'invoice', vendorName: 'Acme Supplies', vendorVatNumber: null, vendorAddress: null, vendorBankDetails: null,
  customerName: null, customerVatNumber: null, date: '2026-03-05', dueDate: null, paymentTerms: null,
  referenceNumber: 'INV-777', purchaseOrderRef: null, currency: 'ZAR', subtotal: 1000, vatAmount: 150, vatRate: 15,
  totalAmount: 1150, lineItems: [], rawText: '', confidence: 0.91, warnings: [], extractionMethod: 'vlm',
};
const doc = (over: Record<string, unknown> = {}) => ({
  id: 'd1', fileName: 'inv.pdf', fileType: 'application/pdf', fileSize: 2048, documentType: null, extractedData: null,
  vendorName: null, documentDate: null, referenceNumber: null, totalAmount: null, vatAmount: null, status: 'pending',
  matchedInvoiceId: null, matchedBankTxId: null, notes: null, uploadedBy: 'u1', createdAt: '2026-10-22T08:00:00Z',
  readState: 'reading', readError: null, ...over,
});
const READ_DONE = doc({ readState: 'done', extractedData: EXTRACTED });

const calls = () => vi.mocked(apiFetch).mock.calls.map((c) => ({ url: String(c[0]), method: (c[1]?.method ?? 'GET').toUpperCase() }));
const byIdGets = () => calls().filter((c) => c.method === 'GET' && c.url.includes('document-capture?id='));
const jobGets = () => calls().filter((c) => c.method === 'GET' && c.url.includes('vlm-extract?job='));
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const pick = (container: HTMLElement) =>
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'inv.pdf', { type: 'application/pdf' })] } });

/** Script the capture routes: the list is empty, POST answers `posted`, each GET ?id= pops from `polls`. */
function serveCapture(posted: Response, polls: Array<() => Response>) {
  const queue = [...polls];
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') return posted;
    if (u.includes('document-capture?id=')) return (queue.length > 1 ? queue.shift()! : queue[0]!)();
    return ok([], { pagination: { total: 0 } });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  router.query = { docId: 'd1' };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('document capture page', () => {
  async function upload(posted: Response, polls: Array<() => Response>) {
    serveCapture(posted, polls);
    const view = render(<DocumentCapturePage />);
    await screen.findByText(/Drop a document here/);
    pick(view.container);
    return view;
  }

  it('upload shows the reading panel, polls every 3 s, then the review has the extracted figures', async () => {
    await upload(ok({ document: doc() }, {}), [() => ok(doc()), () => ok(READ_DONE)]);
    expect(await screen.findByText('Reading document…')).toBeTruthy();
    expect(screen.getByText(/You can leave this page; it stays in the list/)).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('Document uploaded — reading it now');
    expect(byIdGets()).toHaveLength(0);
    await tick(3000);
    expect(byIdGets()).toHaveLength(1);
    expect(screen.queryByText('Extraction Results')).toBeNull();
    await tick(3000);
    expect(await screen.findByText('Extraction Results')).toBeTruthy();
    expect((screen.getByDisplayValue('Acme Supplies') as HTMLInputElement).value).toBe('Acme Supplies');
    expect(screen.getByDisplayValue('INV-777')).toBeTruthy();
    expect(screen.getByDisplayValue('1150')).toBeTruthy();
    expect(screen.queryByText('Reading document…')).toBeNull();
    await tick(12000);
    expect(byIdGets()).toHaveLength(2);
  });

  it('a failed read shows the reason and stops polling', async () => {
    await upload(ok({ document: doc() }), [() => ok(doc({ readState: 'failed', readError: 'The read was interrupted — upload the document again.' }))]);
    await screen.findByText('Reading document…');
    await tick(3000);
    expect(await screen.findByText('The read was interrupted — upload the document again.')).toBeTruthy();
    expect(screen.queryByText('Reading document…')).toBeNull();
    expect(screen.queryByText('Extraction Results')).toBeNull();
    await tick(12000);
    expect(byIdGets()).toHaveLength(1);
  });

  it('polling stops when the page unmounts', async () => {
    const view = await upload(ok({ document: doc() }), [() => ok(doc())]);
    await screen.findByText('Reading document…');
    await tick(3000);
    expect(byIdGets()).toHaveLength(1);
    view.unmount();
    await tick(15000);
    expect(byIdGets()).toHaveLength(1);
  });

  it('a 429 from the upload shows the server message and no reading panel', async () => {
    await upload(refused('Too many documents are being read — wait for one to finish.', 429), [() => ok(doc())]);
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Too many documents are being read — wait for one to finish.'));
    expect(screen.queryByText('Reading document…')).toBeNull();
  });

  it('a poll that fails backs off instead of stopping, and the read still lands', async () => {
    await upload(ok({ document: doc() }), [() => refused('boom', 500), () => ok(READ_DONE)]);
    await screen.findByText('Reading document…');
    await tick(3000);
    expect(byIdGets()).toHaveLength(1);
    await tick(3000);
    expect(byIdGets()).toHaveLength(1);
    await tick(3000);
    expect(byIdGets()).toHaveLength(2);
    expect(await screen.findByText('Extraction Results')).toBeTruthy();
  });
});

describe('document list', () => {
  it('the page refreshes the list while a document in it is being read, and stops once none is', async () => {
    let lists = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => {
      lists += 1;
      return ok([lists < 3 ? doc() : READ_DONE], { pagination: { total: 1 } });
    });
    render(<DocumentCapturePage />);
    expect(await screen.findByText('Reading…')).toBeTruthy();
    await tick(3000);
    expect(screen.getByText('Reading…')).toBeTruthy();
    await tick(3000);
    expect(screen.queryByText('Reading…')).toBeNull();
    expect(lists).toBe(3);
    await tick(12000);
    expect(lists).toBe(3);
  });

  const props = { total: 3, isLoading: false, error: '', statusFilter: '', onStatusFilterChange: vi.fn() };
  it('badges a document being read and one that failed, and no other', () => {
    render(<DocumentList {...props} documents={[
      doc({ id: 'a', fileName: 'a.pdf' }),
      doc({ id: 'b', fileName: 'b.pdf', readState: 'failed', readError: 'x' }),
      doc({ id: 'c', fileName: 'c.pdf', readState: 'done' }),
    ] as never} />);
    expect(screen.getAllByText('Reading…')).toHaveLength(1);
    expect(screen.getAllByText('Read failed')).toHaveLength(1);
  });
});

describe('document detail page', () => {
  function serveDetail(polls: Array<() => Response>) {
    const queue = [...polls];
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => (queue.length > 1 ? queue.shift()! : queue[0]!)());
  }
  const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

  it('while reading: banner, actions disabled, polls; when done the actions are enabled and the figures show', async () => {
    serveDetail([() => ok(doc()), () => ok(doc()), () => ok(READ_DONE)]);
    render(<DocumentDetailPage />);
    expect(await screen.findByText('Reading document…')).toBeTruthy();
    expect(button(/Confirm & Save/).disabled).toBe(true);
    expect(button(/Reject/).disabled).toBe(true);
    expect(button(/Match/).disabled).toBe(true);
    await tick(3000);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
    expect(button(/Confirm & Save/).disabled).toBe(true);
    await tick(3000);
    expect(await screen.findByDisplayValue('Acme Supplies')).toBeTruthy();
    expect(screen.queryByText('Reading document…')).toBeNull();
    expect(button(/Confirm & Save/).disabled).toBe(false);
    expect(button(/Reject/).disabled).toBe(false);
    await tick(12000);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(3);
  });

  it('a failed read shows its reason', async () => {
    serveDetail([() => ok(doc({ readState: 'failed', readError: 'The read was interrupted — upload the document again.' }))]);
    render(<DocumentDetailPage />);
    expect(await screen.findByText('The read was interrupted — upload the document again.')).toBeTruthy();
    expect(screen.queryByText('Reading document…')).toBeNull();
  });

  it('polling stops when the page unmounts', async () => {
    serveDetail([() => ok(doc())]);
    const view = render(<DocumentDetailPage />);
    await screen.findByText('Reading document…');
    await tick(3000);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
    view.unmount();
    await tick(15000);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
  });
});

describe('Scan & Fill', () => {
  function serveScan(post: () => Response, polls: Array<() => Response>) {
    const queue = [...polls];
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('vlm-status')) return ok({ available: true });
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') return post();
      return (queue.length > 1 ? queue.shift()! : queue[0]!)();
    });
  }
  async function start() {
    const onExtracted = vi.fn();
    const view = render(<ScanAndFillButton onExtracted={onExtracted} />);
    await screen.findByRole('button', { name: /Scan & Fill/ });
    pick(view.container);
    return { onExtracted, view };
  }
  const accepted = () => json({ success: true, data: { jobId: 'job-1' } }, 202);

  it('polls every 2 s, stays "Extracting...", then fills the form with the extracted document', async () => {
    serveScan(accepted, [() => ok({ state: 'reading' }), () => ok({ state: 'reading' }), () => ok({ state: 'done', extracted: EXTRACTED })]);
    const { onExtracted } = await start();
    expect(await screen.findByRole('button', { name: /Extracting/ })).toBeTruthy();
    expect(jobGets()).toHaveLength(0);
    await tick(2000);
    expect(jobGets()).toHaveLength(1);
    expect(jobGets()[0]!.url).toContain('job=job-1');
    expect(screen.getByRole('button', { name: /Extracting/ })).toBeTruthy();
    expect(onExtracted).not.toHaveBeenCalled();
    await tick(2000);
    expect(screen.getByRole('button', { name: /Extracting/ })).toBeTruthy();
    await tick(2000);
    expect(onExtracted).toHaveBeenCalledTimes(1);
    expect(onExtracted).toHaveBeenCalledWith(EXTRACTED);
    expect(toast.success).toHaveBeenCalledWith('Document scanned (91% confidence)');
    expect(await screen.findByRole('button', { name: /Scan & Fill/ })).toBeTruthy();
    await tick(10000);
    expect(jobGets()).toHaveLength(3);
  });

  it('a failed job shows its error and fills nothing', async () => {
    serveScan(accepted, [() => ok({ state: 'failed', error: 'We could not read this document.' })]);
    const { onExtracted } = await start();
    await tick(2000);
    expect(toast.error).toHaveBeenCalledWith('We could not read this document.');
    expect(onExtracted).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /Scan & Fill/ })).toBeTruthy();
  });

  it('an unknown job (404) says the scan was interrupted', async () => {
    serveScan(accepted, [() => refused('Not found', 404)]);
    const { onExtracted } = await start();
    await tick(2000);
    expect(toast.error).toHaveBeenCalledWith('The scan was interrupted — try again.');
    expect(onExtracted).not.toHaveBeenCalled();
    await tick(10000);
    expect(jobGets()).toHaveLength(1);
  });

  it('a 429 on the upload shows the server message and never polls', async () => {
    serveScan(() => refused('Too many scans are running — wait a moment.', 429), [() => ok({ state: 'reading' })]);
    await start();
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Too many scans are running — wait a moment.'));
    await tick(6000);
    expect(jobGets()).toHaveLength(0);
  });

  it('a poll that fails to answer is retried, not fatal', async () => {
    serveScan(accepted, [() => refused('boom', 502), () => ok({ state: 'done', extracted: EXTRACTED })]);
    const { onExtracted } = await start();
    await tick(2000);
    expect(onExtracted).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    await tick(2000);
    expect(onExtracted).toHaveBeenCalledWith(EXTRACTED);
  });

  it('gives up after 10 minutes', async () => {
    serveScan(accepted, [() => ok({ state: 'reading' })]);
    const { onExtracted } = await start();
    await tick(10 * 60_000 + 4000);
    expect(toast.error).toHaveBeenCalledWith('The scan is taking too long — try again.');
    expect(onExtracted).not.toHaveBeenCalled();
    const n = jobGets().length;
    await tick(10000);
    expect(jobGets()).toHaveLength(n);
  });

  it('unmounting stops polling and never fills the form', async () => {
    serveScan(accepted, [() => ok({ state: 'reading' }), () => ok({ state: 'done', extracted: EXTRACTED })]);
    const { onExtracted, view } = await start();
    await tick(2000);
    expect(jobGets()).toHaveLength(1);
    view.unmount();
    await tick(20000);
    expect(jobGets()).toHaveLength(1);
    expect(onExtracted).not.toHaveBeenCalled();
  });
});
