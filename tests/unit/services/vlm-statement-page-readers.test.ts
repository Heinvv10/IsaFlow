/**
 * One VLM call per statement page. A page goes as text or as a PNG, is told
 * which page of how many it is, and a reply that is missing or is not JSON is a
 * failed page (null), never an empty one. The raw PDF is never sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { readBankStatementPage, extractBankStatementWithVlm } from '@/modules/accounting/services/bank/vlmBankService';
import {
  readSupplierStatementPage, extractSupplierStatementImage,
} from '@/modules/accounting/services/bank/vlmSupplierStatementService';
import type { PageRequest } from '@/modules/accounting/services/bank/vlmStatementPages';

const reply = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const json = (o: unknown) => reply(JSON.stringify(o));

type Part = { type: string; text?: string; image_url?: { url: string } };
function sent(fetch: ReturnType<typeof vi.fn>): { system: string; parts: Part[] } {
  const body = JSON.parse((fetch.mock.calls[0][1] as { body: string }).body) as { messages: Array<{ content: unknown }> };
  return { system: body.messages[0].content as string, parts: body.messages[1].content as Part[] };
}

const textPage = (page: number, total: number, text = 'ROW ONE\nROW TWO'): PageRequest => ({ page, total, text, pngBase64: null });
const pngPage = (page: number, total: number): PageRequest => ({ page, total, text: null, pngBase64: 'iVBORpng' });

beforeEach(() => {
  process.env.VLLM_BASE_URL = 'http://vlm.test';
  process.env.VLLM_MODEL = 'test-model';
  process.env.VLLM_API_KEY = 'test-key';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VLLM_BASE_URL;
  delete process.env.VLLM_MODEL;
  delete process.env.VLLM_API_KEY;
});

const BANK_PAGE = {
  bankName: 'FNB', accountNumber: '62012345678', openingBalance: 100, closingBalance: null,
  transactions: [{ date: '2026-03-05', description: 'Pick n Pay', amount: -20.5, balance: 79.5 }],
};

describe('readBankStatementPage', () => {
  it('sends a text page as text only, saying which page of how many it is', async () => {
    const fetch = vi.fn(async () => json(BANK_PAGE));
    vi.stubGlobal('fetch', fetch);
    const page = await readBankStatementPage(textPage(2, 5, 'THE PAGE TEXT'));
    const { parts } = sent(fetch);
    expect(parts.map((p) => p.type)).toEqual(['text']);
    expect(parts[0].text).toContain('page 2 of 5');
    expect(parts[0].text).toContain('THE PAGE TEXT');
    expect(parts[0].text).toContain('only the rows printed on this page');
    expect(parts[0].text).toContain('brought forward');
    expect(page!.transactions).toHaveLength(1);
    expect(page!.transactions[0].amount).toBe(-20.5);
    expect(page!.bankName).toBe('FNB');
  });

  it('sends a scanned page as a PNG', async () => {
    const fetch = vi.fn(async () => json(BANK_PAGE));
    vi.stubGlobal('fetch', fetch);
    await readBankStatementPage(pngPage(1, 3));
    const { parts } = sent(fetch);
    expect(parts.map((p) => p.type)).toEqual(['image_url', 'text']);
    expect(parts[0].image_url!.url).toBe('data:image/png;base64,iVBORpng');
    expect(parts[1].text).toContain('page 1 of 3');
  });

  it('asks the model to extract transactions, with debits negative', async () => {
    const fetch = vi.fn(async () => json(BANK_PAGE));
    vi.stubGlobal('fetch', fetch);
    await readBankStatementPage(textPage(1, 1));
    expect(sent(fetch).system).toContain('Debit (money out) amounts should be NEGATIVE');
  });

  it('returns null when the VLM gives no answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })));
    expect(await readBankStatementPage(textPage(1, 2))).toBeNull();
  });

  it('returns null for a reply that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('Sorry, I cannot read this page.')));
    expect(await readBankStatementPage(textPage(1, 2))).toBeNull();
  });

  it('returns null when vLLM is not configured', async () => {
    delete process.env.VLLM_BASE_URL;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await readBankStatementPage(textPage(1, 2))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads a page with no transactions as an empty page, with no warning of its own', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ transactions: [] })));
    const page = await readBankStatementPage(textPage(3, 3));
    expect(page!.transactions).toEqual([]);
    expect(page!.warnings).toEqual([]);
  });
});

describe('extractBankStatementWithVlm (a single image)', () => {
  it('still warns when an image has no transactions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ transactions: [] })));
    const out = await extractBankStatementWithVlm('abc', 'image/png');
    expect(out!.warnings).toContain('No transactions extracted from bank statement');
  });

  it('never sends a PDF to the model', async () => {
    const fetch = vi.fn(async () => json(BANK_PAGE));
    vi.stubGlobal('fetch', fetch);
    expect(await extractBankStatementWithVlm('JVBERi0=', 'application/pdf')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

const SUPPLIER_PAGE = {
  supplierName: 'Acme', statementDate: '2026-03-31', openingBalance: 0, closingBalance: 115,
  lines: [{ date: '2026-03-02', reference: 'INV-1', description: 'Widgets', debit: 115, credit: null, runningBalance: 115 }],
};

describe('readSupplierStatementPage', () => {
  it('sends a text page as text only, saying which page of how many it is', async () => {
    const fetch = vi.fn(async () => json(SUPPLIER_PAGE));
    vi.stubGlobal('fetch', fetch);
    const page = await readSupplierStatementPage(textPage(2, 4, 'SUPPLIER PAGE TEXT'));
    const { parts } = sent(fetch);
    expect(parts.map((p) => p.type)).toEqual(['text']);
    expect(parts[0].text).toContain('page 2 of 4');
    expect(parts[0].text).toContain('SUPPLIER PAGE TEXT');
    expect(parts[0].text).toContain('brought forward');
    expect(page!.lines).toHaveLength(1);
    expect(page!.lines[0].debit).toBe(115);
  });

  it('sends a scanned page as a PNG', async () => {
    const fetch = vi.fn(async () => json(SUPPLIER_PAGE));
    vi.stubGlobal('fetch', fetch);
    await readSupplierStatementPage(pngPage(1, 2));
    expect(sent(fetch).parts.map((p) => p.type)).toEqual(['image_url', 'text']);
  });

  it('returns null for no answer, and for a reply that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, text: async () => '' })));
    expect(await readSupplierStatementPage(textPage(1, 2))).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => reply('not json')));
    expect(await readSupplierStatementPage(textPage(1, 2))).toBeNull();
  });

  it('reads a page with no lines as an empty page, with no warning of its own', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ lines: [] })));
    const page = await readSupplierStatementPage(textPage(2, 2));
    expect(page!.lines).toEqual([]);
    expect(page!.warnings).toEqual([]);
  });
});

describe('extractSupplierStatementImage (a single image)', () => {
  it('returns the lines of an image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(SUPPLIER_PAGE)));
    const out = await extractSupplierStatementImage('abc', 'image/png');
    expect(out!.lines).toHaveLength(1);
    expect(out!.supplierName).toBe('Acme');
  });

  it('returns null, not an empty statement, when the VLM fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => '' })));
    expect(await extractSupplierStatementImage('abc', 'image/png')).toBeNull();
  });

  it('never sends a PDF to the model', async () => {
    const fetch = vi.fn(async () => json(SUPPLIER_PAGE));
    vi.stubGlobal('fetch', fetch);
    expect(await extractSupplierStatementImage('JVBERi0=', 'application/pdf')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
