/**
 * PDF invoices reach the VLM as text or as a rendered page — never as a PDF.
 *
 * 2026-10-16: 3,789 PDF uploads were each sent to vLLM as `image_url` with
 * `data:application/pdf` (always 400 "cannot identify image file"), and the
 * render fallback silently produced nothing, so they fell to regex at low
 * confidence. The pipeline is now: text layer → rendered page → nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const render = vi.hoisted(() => vi.fn<(buf: Buffer) => Promise<string | null>>());
vi.mock('@/modules/accounting/services/bank/vlmPdfRender', () => ({ renderPdfFirstPage: render }));

import { extractPdfWithVlm } from '@/modules/accounting/services/bank/vlmInvoiceService';

const GOOD = {
  documentType: 'invoice', vendorName: 'Acme Supplies', date: '2026-09-01', referenceNumber: 'INV-1',
  subtotal: 100, vatAmount: 15, totalAmount: 115, lineItems: [{ description: 'Widget', total: 100 }],
};
const WEAK = { documentType: 'unknown', vendorName: null, totalAmount: null, lineItems: [] };
const reply = (doc: Record<string, unknown>) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(doc) } }] }),
});

type Part = { type: string; image_url?: { url: string } };
function partsOf(call: unknown[]): Part[] {
  const body = JSON.parse((call[1] as { body: string }).body) as { messages: Array<{ content: unknown }> };
  return body.messages[1].content as Part[];
}

const TEXT_LAYER = 'ACME SUPPLIES (PTY) LTD  TAX INVOICE INV-1  2026-09-01\n'.repeat(5);
const PDF = Buffer.from('%PDF-1.7 fake');

describe('extractPdfWithVlm', () => {
  beforeEach(() => {
    process.env.VLLM_BASE_URL = 'http://vlm.test';
    process.env.VLLM_MODEL = 'test-model';
    process.env.VLLM_API_KEY = 'test-key';
    render.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VLLM_BASE_URL;
    delete process.env.VLLM_MODEL;
    delete process.env.VLLM_API_KEY;
  });

  it('reads a digital PDF from its text layer alone, without rendering', async () => {
    const fetch = vi.fn(async () => reply(GOOD));
    vi.stubGlobal('fetch', fetch);
    const doc = await extractPdfWithVlm(PDF, TEXT_LAYER);
    expect(doc!.vendorName).toBe('Acme Supplies');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(partsOf(fetch.mock.calls[0]).map((p) => p.type)).toEqual(['text']);
    expect(render).not.toHaveBeenCalled();
  });

  it('retries a weak text read with the rendered page as a PNG', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply(WEAK)).mockResolvedValueOnce(reply(GOOD));
    vi.stubGlobal('fetch', fetch);
    render.mockResolvedValue('iVBORpng');
    const doc = await extractPdfWithVlm(PDF, TEXT_LAYER);
    expect(doc!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(partsOf(fetch.mock.calls[1])[0].image_url!.url).toBe('data:image/png;base64,iVBORpng');
  });

  it('keeps the text read when the page read scores worse', async () => {
    const MEDIUM = { ...WEAK, documentType: 'invoice', vendorName: 'Acme', date: '2026-09-01', totalAmount: 115 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(MEDIUM)).mockResolvedValueOnce(reply(WEAK)));
    render.mockResolvedValue('iVBORpng');
    const doc = await extractPdfWithVlm(PDF, TEXT_LAYER);
    expect(doc!.vendorName).toBe('Acme');
    expect(doc!.confidence).toBe(0.55);
  });

  it('treats a scan whose text is only page markers as a scan', async () => {
    const fetch = vi.fn(async () => reply(GOOD));
    vi.stubGlobal('fetch', fetch);
    render.mockResolvedValue('iVBORpng');
    const markers = Array.from({ length: 40 }, (_, i) => `\n\n-- ${i + 1} of 40 --\n\n`).join('');
    const doc = await extractPdfWithVlm(PDF, markers);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(partsOf(fetch.mock.calls[0])[0].type).toBe('image_url');
    expect(doc!.warnings).toContain('Read from page 1 of 40 only — check later pages for totals.');
  });

  it('says so when the text layer was cut short', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(GOOD)));
    const doc = await extractPdfWithVlm(PDF, TEXT_LAYER.repeat(40));
    expect(doc!.warnings.some((w) => w.startsWith('Read the first 8000 characters'))).toBe(true);
  });

  it('runs at most two page reads (render + VLM call) at once', async () => {
    let live = 0;
    let peak = 0;
    render.mockImplementation(async () => { live++; peak = Math.max(peak, live); return 'iVBORpng'; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      live--;
      return reply(GOOD);
    }));
    await Promise.all(Array.from({ length: 6 }, () => extractPdfWithVlm(PDF, '')));
    expect(render).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });

  it('keeps the weak text read when the page cannot be rendered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(WEAK)));
    render.mockResolvedValue(null);
    const doc = await extractPdfWithVlm(PDF, TEXT_LAYER);
    expect(doc).not.toBeNull();
    expect(doc!.confidence).toBeLessThan(0.6);
  });

  it('sends a scan (no text layer) as a rendered PNG, never as a PDF', async () => {
    const fetch = vi.fn(async () => reply(GOOD));
    vi.stubGlobal('fetch', fetch);
    render.mockResolvedValue('iVBORpng');
    await extractPdfWithVlm(PDF, '  ');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(partsOf(fetch.mock.calls[0])[0].image_url!.url).toBe('data:image/png;base64,iVBORpng');
  });

  it('makes no call at all for an unrenderable scan', async () => {
    const fetch = vi.fn(async () => reply(GOOD));
    vi.stubGlobal('fetch', fetch);
    render.mockResolvedValue(null);
    expect(await extractPdfWithVlm(PDF, '')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
