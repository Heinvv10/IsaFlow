/**
 * parseBankPdf runs inside an HTTP request (bulk preview/commit, the MCP import), so it must never
 * wait on the VLM: a page takes ~55 s. A PDF its text parsers cannot read is refused with a pointer
 * to the upload page that reads scans in the background. (Its old fallback sent the raw PDF to
 * vLLM, which has always rejected it with a 400.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statementRows, syntheticPdf } from '../helpers/syntheticPdf';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { parseBankPdf } from '@/modules/accounting/utils/bankPdfParser';

const fetchSpy = vi.fn();

beforeEach(() => {
  process.env.VLLM_BASE_URL = 'http://vlm.test';
  process.env.VLLM_MODEL = 'test-model';
  process.env.VLLM_API_KEY = 'test-key';
  vi.stubGlobal('fetch', fetchSpy);
  fetchSpy.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VLLM_BASE_URL;
  delete process.env.VLLM_MODEL;
  delete process.env.VLLM_API_KEY;
});

describe('parseBankPdf without a parser for the layout', () => {
  it('does not call the VLM, and points at the upload page that reads any PDF', async () => {
    const result = await parseBankPdf(syntheticPdf([['Totally unknown bank', ...statementRows(3, 'ZZZ')]]));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.transactions).toEqual([]);
    expect(result.errors[0].error).toContain('Upload Bank Statement PDF');
  });

  it('does not call the VLM for a scan either, and points at the same page', async () => {
    const result = await parseBankPdf(syntheticPdf([[], []]));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.transactions).toEqual([]);
    expect(result.errors[0].error).toContain('Upload Bank Statement PDF');
  });
});
