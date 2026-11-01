/**
 * The invoice PDF preview: collapsed below lg, one fetch for a burst of version
 * bumps, no fetch while closed, an object URL revoked when replaced and on
 * unmount, and never another invoice's PDF under this invoice's name.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { InvoicePdfPreview } from '@/components/accounting/customer-invoices/InvoicePdfPreview';

const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const pdf = () => new Response(new Blob(['%PDF'], { type: 'application/pdf' }), { status: 200 });

let urls: number;
const createObjectURL = vi.fn(() => `blob:preview-${++urls}`);
const revokeObjectURL = vi.fn();

function setWidth(lg: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: lg && q === '(min-width: 1024px)' }));
}
/** Lets effects, the zero-delay timer and the fetch's promises all land. */
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const frame = () => screen.queryByTitle('Invoice PDF preview') as HTMLIFrameElement | null;

beforeEach(() => {
  // happy-dom would try to navigate the iframe to the fake blob: URL.
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  vi.useFakeTimers();
  urls = 0;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async () => pdf());
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  setWidth(true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('InvoicePdfPreview', () => {
  it('is collapsed below lg and fetches nothing until opened', async () => {
    setWidth(false);
    render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(frame()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(frame()?.getAttribute('src')).toBe('blob:preview-1');
  });

  it('opens at lg and asks for the inline PDF of this invoice', async () => {
    render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0]![0]).toBe(`/api/accounting/invoice-pdf?invoiceId=${A}&disposition=inline`);
    expect(screen.getByRole('button', { name: /preview/i }).getAttribute('aria-expanded')).toBe('true');
  });

  it('refetches once for a burst of versions, 3 s after the last', async () => {
    const view = render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    view.rerender(<InvoicePdfPreview invoiceId={A} version={2} />);
    await advance(2000);
    view.rerender(<InvoicePdfPreview invoiceId={A} version={3} />);
    await advance(2999);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(frame()?.getAttribute('src')).toBe('blob:preview-2');
  });

  it('does not refetch while closed, and catches up at once on opening', async () => {
    const view = render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    const toggle = screen.getByRole('button', { name: /preview/i });
    fireEvent.click(toggle);
    await flush();
    view.rerender(<InvoicePdfPreview invoiceId={A} version={2} />);
    await advance(10_000);
    expect(apiFetch).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('does not refetch on reopening when nothing changed', async () => {
    render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    const toggle = screen.getByRole('button', { name: /preview/i });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(frame()?.getAttribute('src')).toBe('blob:preview-1');
  });

  it('revokes the old URL when replaced and the last one on unmount', async () => {
    const view = render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    view.rerender(<InvoicePdfPreview invoiceId={A} version={2} />);
    await advance(3000);
    expect(revokeObjectURL.mock.calls.map((c) => c[0])).toEqual(['blob:preview-1']);

    view.unmount();
    expect(revokeObjectURL.mock.calls.map((c) => c[0])).toEqual(['blob:preview-1', 'blob:preview-2']);
  });

  it('drops the previous invoice at once and ignores its late answer', async () => {
    let answerA: (r: Response) => void = () => undefined;
    const view = render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    expect(frame()).not.toBeNull();

    apiFetch.mockImplementationOnce(() => new Promise<Response>((r) => { answerA = r; }));
    view.rerender(<InvoicePdfPreview invoiceId={A} version={2} />);
    await advance(3000);
    expect(apiFetch).toHaveBeenCalledTimes(2);

    view.rerender(<InvoicePdfPreview invoiceId={B} version={1} />);
    expect(frame()).toBeNull();
    await flush();
    expect(apiFetch.mock.calls[2]![0]).toContain(`invoiceId=${B}`);
    expect((apiFetch.mock.calls[1]![1] as RequestInit).signal?.aborted).toBe(true);
    await act(async () => { answerA(pdf()); await vi.advanceTimersByTimeAsync(0); });
    expect(frame()?.getAttribute('src')).toBe('blob:preview-2');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it('says so when the PDF fails, and Retry fetches again', async () => {
    apiFetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500 }));
    render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    expect(screen.getByRole('alert').textContent).toMatch(/could not load/i);
    expect(frame()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(frame()).not.toBeNull();
  });

  it('stays debounced after a failed first load', async () => {
    apiFetch.mockImplementationOnce(async () => new Response('{}', { status: 500 }));
    const view = render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    view.rerender(<InvoicePdfPreview invoiceId={A} version={2} />);
    await advance(2999);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('does not show one invoice\'s failure on the next', async () => {
    apiFetch.mockImplementationOnce(async () => new Response('{}', { status: 500 }));
    const view = render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    expect(screen.getByRole('alert')).toBeTruthy();
    apiFetch.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    view.rerender(<InvoicePdfPreview invoiceId={B} version={1} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('marks a kept preview as out of date when its refresh fails', async () => {
    const view = render(<InvoicePdfPreview invoiceId={A} version={1} />);
    await flush();
    apiFetch.mockImplementationOnce(async () => new Response('{}', { status: 500 }));
    view.rerender(<InvoicePdfPreview invoiceId={A} version={2} />);
    await advance(3000);
    expect(screen.getByRole('alert').textContent).toMatch(/out of date/i);
    expect(frame()?.getAttribute('src')).toBe('blob:preview-1');
  });
});
