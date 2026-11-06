/**
 * Master plan wave 4, PR PV: the PDF preview of an unsaved invoice (the new page). It starts closed, POSTs the body
 * Create would send to invoice-pdf-preview (never the stored-invoice route), re-renders 3 s after the last change only
 * while open, sends nothing while the form has a problem, and keeps the last good PDF through a refusal, showing why.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { InvoicePdfPreview } from '@/components/accounting/customer-invoices/InvoicePdfPreview';

const pdf = () => new Response('%PDF', { status: 200, headers: { 'Content-Type': 'application/pdf' } });
const refusal = (status: number, message: string) => new Response(JSON.stringify({ success: false, error: { code: 'X', message } }),
  { status, headers: { 'Content-Type': 'application/json' } });
const body = (description: string) => ({ body: { clientId: 'c', items: [{ description, quantity: 1, unitPrice: 10 }] } });

let urls: number;
const createObjectURL = vi.fn(() => `blob:preview-${++urls}`);
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const frame = () => screen.queryByTitle('Invoice PDF preview') as HTMLIFrameElement | null;
const toggle = () => screen.getByRole('button', { name: /preview pdf/i });
const sent = (call: number) => apiFetch.mock.calls[call] as [string, RequestInit];

beforeEach(() => {
  (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
  vi.useFakeTimers();
  urls = 0;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async () => pdf());
  createObjectURL.mockClear();
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  // Even at lg the unsaved preview starts closed: each render of it is a request.
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('InvoicePdfPreview, unsaved', () => {
  it('starts closed and sends nothing until opened, then POSTs the body to invoice-pdf-preview', async () => {
    render(<InvoicePdfPreview unsaved={body('Consulting')} />);
    await flush();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(toggle());
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = sent(0);
    expect(url).toBe('/api/accounting/invoice-pdf-preview');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body('Consulting').body);
    expect(frame()?.getAttribute('src')).toBe('blob:preview-1');
  });

  it('re-renders once for a burst of changes, 3 s after the last', async () => {
    const view = render(<InvoicePdfPreview unsaved={body('a')} />);
    fireEvent.click(toggle());
    await flush();
    view.rerender(<InvoicePdfPreview unsaved={body('ab')} />);
    await advance(1000);
    view.rerender(<InvoicePdfPreview unsaved={body('abc')} />);
    await advance(2999);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(sent(1)[1].body)).items[0].description).toBe('abc');
  });

  it('an unchanged body (a re-render) sends nothing', async () => {
    const view = render(<InvoicePdfPreview unsaved={body('a')} />);
    fireEvent.click(toggle());
    await flush();
    view.rerender(<InvoicePdfPreview unsaved={body('a')} />);
    await advance(5000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('with a problem it sends nothing, says what to fix, and keeps the last PDF', async () => {
    const view = render(<InvoicePdfPreview unsaved={{ problem: 'Select a client' }} />);
    fireEvent.click(toggle());
    await advance(5000);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('Select a client.');
    view.rerender(<InvoicePdfPreview unsaved={body('a')} />);
    await advance(3000);
    expect(frame()?.getAttribute('src')).toBe('blob:preview-1');
    view.rerender(<InvoicePdfPreview unsaved={{ problem: 'Add at least one line item' }} />);
    await advance(5000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toMatch(/^Add at least one line item\. What is shown is the last version/);
    expect(frame()?.getAttribute('src')).toBe('blob:preview-1');
  });

  it('a refusal keeps the last good PDF and shows the server\'s message', async () => {
    const view = render(<InvoicePdfPreview unsaved={body('a')} />);
    fireEvent.click(toggle());
    await flush();
    apiFetch.mockImplementationOnce(async () => refusal(400, 'Line quantities must be positive numbers'));
    view.rerender(<InvoicePdfPreview unsaved={body('b')} />);
    await advance(3000);
    expect(screen.getByRole('alert').textContent).toMatch(/^Line quantities must be positive numbers What is shown may be out of date\./);
    expect(frame()?.getAttribute('src')).toBe('blob:preview-1');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('a first refusal shows the server\'s message with nothing framed', async () => {
    apiFetch.mockImplementationOnce(async () => refusal(404, 'Customer not found'));
    render(<InvoicePdfPreview unsaved={body('a')} />);
    fireEvent.click(toggle());
    await flush();
    expect(screen.getByRole('alert').textContent).toMatch(/^Customer not found/);
    expect(frame()).toBeNull();
  });
});
