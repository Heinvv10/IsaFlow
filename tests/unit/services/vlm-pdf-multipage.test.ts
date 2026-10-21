/**
 * A scanned invoice is read past page 1: pages 1..min(N,3) go to the VLM in ONE
 * call, in page order, inside ONE 'vlm-page-reads' slot.
 *
 * 2026-10-17: the OCR benchmark scored 0/6 on every multi-page scan, because
 * each had a payment-request cover page and only page 1 was read. Only the vLLM
 * HTTP boundary is faked here: the PDFs are real scans (tests/helpers/
 * scanInvoicePdf), rendered by the real Ghostscript and parsed by the real
 * pdf-parse, through the real caller (ocrService.extractFromPdf).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const gsSpy = vi.hoisted(() => ({ failPage: 0, live: 0, peak: 0, outsideSlot: 0 }));
const slot = vi.hoisted(() => {
  // A counting stand-in for the shared 'vlm-page-reads' limiter (max 2, FIFO),
  // registered before the service loads so the service picks it up.
  const state = { runs: 0, active: 0, peak: 0 };
  const waiting: Array<() => void> = [];
  let inFlight = 0;
  const limiter = {
    async run<T>(work: () => Promise<T>): Promise<T> {
      state.runs++;
      if (inFlight < 2) inFlight++;
      else await new Promise<void>((r) => waiting.push(r));
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      try {
        return await work();
      } finally {
        state.active--;
        const next = waiting.shift();
        if (next) next(); else inFlight--;
      }
    },
  };
  const g = globalThis as Record<symbol, Map<string, unknown>>;
  const key = Symbol.for('isaflow.vlmSlotLimiters');
  (g[key] ??= new Map()).set('vlm-page-reads', limiter);
  return state;
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: ((cmd: string, args: string[], opts: object) => {
      if (slot.active === 0) gsSpy.outsideSlot++;
      gsSpy.live++;
      gsSpy.peak = Math.max(gsSpy.peak, gsSpy.live);
      const fail = gsSpy.failPage > 0 && args.includes(`-dFirstPage=${gsSpy.failPage}`);
      const child = fail
        ? actual.spawn('sh', ['-c', 'cat >/dev/null; exit 1'], opts)
        : actual.spawn(cmd, args, opts);
      child.on('close', () => { gsSpy.live--; });
      return child;
    }) as typeof actual.spawn,
  };
});

import { extractFromPdf } from '@/modules/accounting/services/core/ocrService';
import { renderPdfPage } from '@/modules/accounting/services/bank/vlmPdfRender';
import { buildScanInvoicePdf, INVOICE } from '../../helpers/scanInvoicePdf';

const GOOD = {
  documentType: 'invoice', vendorName: INVOICE.vendorName, date: INVOICE.date, referenceNumber: INVOICE.referenceNumber,
  subtotal: INVOICE.subtotal, vatAmount: INVOICE.vatAmount, totalAmount: INVOICE.totalAmount,
  lineItems: [{ description: 'Drop cable', total: 8500 }, { description: 'Splice closure', total: 3650 }],
};
const reply = (doc: Record<string, unknown>) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(doc) } }] }),
});

type Part = { type: string; text?: string; image_url?: { url: string } };
function bodyOf(call: unknown[]): { max_tokens: number; messages: Array<{ content: unknown }> } {
  return JSON.parse((call[1] as { body: string }).body);
}
const partsOf = (call: unknown[]) => bodyOf(call).messages[1].content as Part[];
const images = (parts: Part[]) => parts.filter((p) => p.type === 'image_url').map((p) => p.image_url!.url);
const png = (b64: string | null) => `data:image/png;base64,${b64}`;

let scan1: Buffer;
let scan3: Buffer;
let scan5: Buffer;

describe('multi-page invoice scans', () => {
  beforeAll(() => {
    scan1 = buildScanInvoicePdf(1);
    scan3 = buildScanInvoicePdf(3);
    scan5 = buildScanInvoicePdf(5);
  });
  beforeEach(() => {
    process.env.VLLM_BASE_URL = 'http://vlm.test';
    process.env.VLLM_MODEL = 'test-model';
    process.env.VLLM_API_KEY = 'test-key';
    Object.assign(gsSpy, { failPage: 0, live: 0, peak: 0, outsideSlot: 0 });
    Object.assign(slot, { runs: 0, active: 0, peak: 0 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VLLM_BASE_URL;
    delete process.env.VLLM_MODEL;
    delete process.env.VLLM_API_KEY;
  });

  it('renders three distinct pages of a real scan through Ghostscript', async () => {
    const pages = await Promise.all([1, 2, 3].map((p) => renderPdfPage(scan3, p)));
    for (const p of pages) expect(Buffer.from(p!, 'base64').subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    expect(new Set(pages).size).toBe(3);
  }, 30_000);

  it('sends pages 1-3 of a 3-page scan in ONE call, in page order, with no partial-read warning', async () => {
    const fetch = vi.fn(async () => reply(GOOD));
    vi.stubGlobal('fetch', fetch);
    const doc = await extractFromPdf(scan3);
    expect(fetch).toHaveBeenCalledTimes(1);
    const parts = partsOf(fetch.mock.calls[0]);
    const expected = await Promise.all([1, 2, 3].map((p) => renderPdfPage(scan3, p)));
    expect(images(parts)).toEqual(expected.map(png));
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    expect(text).toContain('pages 1-3 of a 3-page PDF');
    expect(text).toContain('SUPPLIER INVOICE');
    expect(doc.totalAmount).toBe(INVOICE.totalAmount);
    expect(doc.warnings.filter((w) => /page/i.test(w))).toEqual([]);
  }, 30_000);

  it('reads only pages 1-3 of a 5-page scan and says so', async () => {
    const fetch = vi.fn(async () => reply(GOOD));
    vi.stubGlobal('fetch', fetch);
    const doc = await extractFromPdf(scan5);
    expect(fetch).toHaveBeenCalledTimes(1);
    const expected = await Promise.all([1, 2, 3].map((p) => renderPdfPage(scan5, p)));
    expect(images(partsOf(fetch.mock.calls[0]))).toEqual(expected.map(png));
    expect(partsOf(fetch.mock.calls[0]).at(-1)!.text).toContain('pages 1-3 of a 5-page PDF');
    expect(doc.warnings).toContain('Read pages 1–3 of 5 — check later pages.');
  }, 30_000);

  it('sends a 1-page scan exactly as before: one image and the unchanged prompt', async () => {
    const fetch = vi.fn(async () => reply(GOOD));
    vi.stubGlobal('fetch', fetch);
    const doc = await extractFromPdf(scan1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const page1 = await renderPdfPage(scan1, 1);
    const rawText = doc.rawText;
    expect(rawText).toMatch(/-- 1 of 1 --/);
    expect(bodyOf(fetch.mock.calls[0]).max_tokens).toBe(4096);
    expect(partsOf(fetch.mock.calls[0])).toEqual([
      { type: 'image_url', image_url: { url: png(page1) } },
      {
        type: 'text',
        text: 'Extract all accounting data from this document image.\n\nThe PDF text layer also contains the '
          + `following text (use it to cross-check your extraction):\n\n${rawText.substring(0, 4000)}`,
      },
    ]);
    expect(doc.warnings.filter((w) => /page/i.test(w))).toEqual([]);
  }, 30_000);

  it('reads the pages that rendered when page 2 fails, and names the page it skipped', async () => {
    const fetch = vi.fn(async () => reply(GOOD));
    vi.stubGlobal('fetch', fetch);
    gsSpy.failPage = 2;
    const doc = await extractFromPdf(scan3);
    gsSpy.failPage = 0;
    expect(fetch).toHaveBeenCalledTimes(1);
    const expected = await Promise.all([1, 3].map((p) => renderPdfPage(scan3, p)));
    expect(images(partsOf(fetch.mock.calls[0]))).toEqual(expected.map(png));
    expect(doc.warnings).toContain('Page 2 of 3 could not be read — check it by hand.');
  }, 30_000);

  it('makes no VLM call when page 1 of a scan cannot be rendered (as before)', async () => {
    const fetch = vi.fn(async () => reply(GOOD));
    vi.stubGlobal('fetch', fetch);
    gsSpy.failPage = 1;
    const doc = await extractFromPdf(scan3);
    expect(fetch).not.toHaveBeenCalled();
    expect(doc.extractionMethod).not.toBe('vlm');
  }, 30_000);

  it('warns when the model reports more than one invoice in the pages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ ...GOOD, multipleInvoices: true })));
    const doc = await extractFromPdf(scan3);
    expect(doc.totalAmount).toBe(INVOICE.totalAmount);
    expect(doc.warnings).toContain('This PDF may contain more than one invoice.');
  }, 30_000);

  it('holds ONE page-read slot per invoice, rendering its pages one at a time inside it', async () => {
    const fetch = vi.fn(async () => {
      if (slot.active === 0) gsSpy.outsideSlot++;
      await new Promise((r) => setTimeout(r, 20));
      return reply(GOOD);
    });
    vi.stubGlobal('fetch', fetch);
    const docs = await Promise.all(Array.from({ length: 4 }, () => extractFromPdf(scan3)));
    expect(docs.every((d) => d.totalAmount === INVOICE.totalAmount)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(slot.runs).toBe(4);
    expect(slot.peak).toBe(2);
    expect(gsSpy.outsideSlot).toBe(0);
    expect(gsSpy.peak).toBeLessThanOrEqual(2);
  }, 60_000);
});
