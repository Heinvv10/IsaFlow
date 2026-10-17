/**
 * Where a bank statement's rows come from: the deterministic PDF parsers first, the per-page VLM
 * read only when they find nothing, one image in one call. Nothing here touches a database
 * except fetching the stored bytes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedBankStatement } from '@/modules/accounting/types/documentCapture.types';
import type { BankCsvParseResult } from '@/modules/accounting/types/bank.types';

const m = vi.hoisted(() => ({
  fetchRawBytes: vi.fn(),
  parseBankPdf: vi.fn(),
  readStatementPdf: vi.fn(),
  extractImage: vi.fn(),
  readBankStatementPage: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/documentStorage', () => ({ fetchRawBytes: m.fetchRawBytes }));
vi.mock('@/modules/accounting/utils/bankPdfParser', () => ({ parseBankPdf: m.parseBankPdf }));
vi.mock('@/modules/accounting/services/bank/vlmBankService', () => ({
  extractBankStatementWithVlm: m.extractImage, readBankStatementPage: m.readBankStatementPage,
}));
vi.mock('@/modules/accounting/services/bank/vlmStatementPages', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/bank/vlmStatementPages')>()),
  readStatementPdf: m.readStatementPdf,
}));

import { StatementReadError } from '@/modules/accounting/services/bank/vlmStatementPages';
import { extractBankStatementFromDocument } from '@/modules/accounting/services/bank/bankStatementExtraction';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const DOC = 'cccccccc-0000-0000-0000-000000000003';
const PDF = Buffer.from('%PDF-1.4 fake');

const parsed = (over: Partial<BankCsvParseResult> = {}): BankCsvParseResult => ({
  transactions: [], errors: [], bankFormat: 'unknown', ...over,
});
const page = (over: Partial<ExtractedBankStatement> = {}): ExtractedBankStatement => ({
  bankName: null, accountNumber: null, statementPeriod: null, openingBalance: null, closingBalance: null,
  transactions: [], confidence: 0.85, warnings: [], ...over,
});
const vlmTx = (description: string, amount: number) => (
  { date: '2026-03-05', description, amount, balance: null, reference: null, transactionType: null });

beforeEach(() => {
  vi.resetAllMocks();
  process.env.VLLM_BASE_URL = 'http://vlm.test';
  m.fetchRawBytes.mockResolvedValue({ buffer: PDF, hash: 'h', size: PDF.length, fileType: 'pdf' });
  m.parseBankPdf.mockResolvedValue(parsed());
});

describe('a PDF the deterministic parsers can read', () => {
  const absa = parsed({
    bankFormat: 'absa',
    parser: 'native',
    accountNumber: '4102426629',
    transactions: [
      { transactionDate: '2026-03-10', amount: 5000, description: 'Salary', balance: 15000, reference: 'SAL' },
      { transactionDate: '2026-03-05', amount: -200, description: 'Shop' },
    ],
    errors: [{ row: 7, error: 'Could not read the amount' }],
  });

  it('uses their rows and never calls the VLM', async () => {
    m.parseBankPdf.mockResolvedValue(absa);
    const out = await extractBankStatementFromDocument(CO, DOC);
    expect(m.readStatementPdf).not.toHaveBeenCalled();
    expect(m.parseBankPdf).toHaveBeenCalledWith(PDF);
    expect(out.transactions).toEqual([
      { date: '2026-03-10', description: 'Salary', amount: 5000, balance: 15000, reference: 'SAL', transactionType: null },
      { date: '2026-03-05', description: 'Shop', amount: -200, balance: null, reference: null, transactionType: null },
    ]);
    expect(out.accountNumber).toBe('4102426629');
  });

  it('spans the period over the rows and carries the parser\'s row errors as warnings', async () => {
    m.parseBankPdf.mockResolvedValue(absa);
    const out = await extractBankStatementFromDocument(CO, DOC);
    expect(out.statementPeriod).toEqual({ from: '2026-03-05', to: '2026-03-10' });
    expect(out.warnings).toEqual(['Could not read the amount']);
  });

  it('fetches the bytes for this company only', async () => {
    m.parseBankPdf.mockResolvedValue(absa);
    await extractBankStatementFromDocument(CO, DOC);
    expect(m.fetchRawBytes).toHaveBeenCalledWith(DOC, CO);
  });
});

describe('rows from the ABSA-pattern fallback', () => {
  // The router's last resort is the ABSA date-amount pattern on a layout it has no parser for. On a real
  // digital GoTyme statement (66 rows) it returned 10, silently: a partial read must not beat the page
  // reader, whether the bank was recognised (its own parser found nothing) or not.
  const fallback = (bankFormat: string) => parsed({
    bankFormat,
    parser: 'fallback',
    transactions: [{ transactionDate: '2026-03-05', amount: -200, description: 'Shop' }],
  });

  it.each(['unknown', 'nedbank'])('are not trusted for a %s statement; the page reader reads it', async (format) => {
    m.parseBankPdf.mockResolvedValue(fallback(format));
    m.readStatementPdf.mockResolvedValue([page({ transactions: [vlmTx('a', -10), vlmTx('b', -20)] })]);
    const out = await extractBankStatementFromDocument(CO, DOC);
    expect(m.readStatementPdf).toHaveBeenCalledTimes(1);
    expect(out.transactions.map((t) => t.description)).toEqual(['a', 'b']);
  });

  it('with no VLM configured, fail rather than keep the fallback\'s partial rows', async () => {
    m.parseBankPdf.mockResolvedValue(fallback('nedbank'));
    delete process.env.VLLM_BASE_URL;
    await expect(extractBankStatementFromDocument(CO, DOC)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rows from a recognised bank\'s own parser are trusted', async () => {
    m.parseBankPdf.mockResolvedValue({ ...fallback('nedbank'), parser: 'native' });
    const out = await extractBankStatementFromDocument(CO, DOC);
    expect(m.readStatementPdf).not.toHaveBeenCalled();
    expect(out.transactions).toHaveLength(1);
  });
});

describe('a PDF the deterministic parsers cannot read', () => {
  it('reads it page by page and merges the pages', async () => {
    m.readStatementPdf.mockResolvedValue([
      page({ openingBalance: 100, transactions: [vlmTx('a', -10)] }),
      page({ closingBalance: 70, transactions: [vlmTx('b', -20)] }),
    ]);
    const out = await extractBankStatementFromDocument(CO, DOC);
    expect(m.readStatementPdf).toHaveBeenCalledTimes(1);
    expect(m.readStatementPdf.mock.calls[0][0]).toBe(PDF);
    expect(m.readStatementPdf.mock.calls[0][1]).toBe('bank');
    expect(m.readStatementPdf.mock.calls[0][2]).toBe(m.readBankStatementPage);
    expect(out.transactions.map((t) => t.description)).toEqual(['a', 'b']);
    expect(out.openingBalance).toBe(100);
    expect(out.closingBalance).toBe(70);
  });

  it('passes the progress callback through to the page reader', async () => {
    m.readStatementPdf.mockResolvedValue([page()]);
    const onProgress = vi.fn();
    await extractBankStatementFromDocument(CO, DOC, onProgress);
    expect(m.readStatementPdf.mock.calls[0][3]).toBe(onProgress);
  });

  it('fails when vLLM is not configured, without reading any page', async () => {
    delete process.env.VLLM_BASE_URL;
    const err = await extractBankStatementFromDocument(CO, DOC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StatementReadError);
    expect((err as StatementReadError).code).toBe('unavailable');
    expect(m.readStatementPdf).not.toHaveBeenCalled();
  });

  it('lets a page-read failure fail the extraction', async () => {
    m.readStatementPdf.mockRejectedValue(new StatementReadError('page_failed', 'Page 2 of 3 could not be read. Retry the import.'));
    await expect(extractBankStatementFromDocument(CO, DOC)).rejects.toThrow('Page 2 of 3');
  });
});

describe('an image', () => {
  beforeEach(() => {
    m.fetchRawBytes.mockResolvedValue({ buffer: Buffer.from('imgbytes'), hash: 'h', size: 8, fileType: 'jpeg' });
  });

  it('is read in one call with its own mime type, and never goes through the PDF parsers', async () => {
    m.extractImage.mockResolvedValue(page({ transactions: [vlmTx('a', -1)] }));
    const out = await extractBankStatementFromDocument(CO, DOC);
    expect(m.extractImage).toHaveBeenCalledWith(Buffer.from('imgbytes').toString('base64'), 'image/jpeg');
    expect(m.parseBankPdf).not.toHaveBeenCalled();
    expect(m.readStatementPdf).not.toHaveBeenCalled();
    expect(out.transactions).toHaveLength(1);
  });

  it('fails when the model gives no answer', async () => {
    m.extractImage.mockResolvedValue(null);
    await expect(extractBankStatementFromDocument(CO, DOC)).rejects.toMatchObject({ code: 'page_failed' });
  });

  it('fails when vLLM is not configured', async () => {
    delete process.env.VLLM_BASE_URL;
    await expect(extractBankStatementFromDocument(CO, DOC)).rejects.toMatchObject({ code: 'unavailable' });
    expect(m.extractImage).not.toHaveBeenCalled();
  });
});

describe('a file that is neither a PDF nor an image', () => {
  it('is refused without a call to the model', async () => {
    m.fetchRawBytes.mockResolvedValue({ buffer: Buffer.from('x'), hash: 'h', size: 1, fileType: 'bin' });
    await expect(extractBankStatementFromDocument(CO, DOC)).rejects.toMatchObject({ code: 'unreadable' });
    expect(m.extractImage).not.toHaveBeenCalled();
  });
});

describe('a missing document', () => {
  it('fails with a user-safe message', async () => {
    m.fetchRawBytes.mockResolvedValue(null);
    await expect(extractBankStatementFromDocument(CO, DOC)).rejects.toMatchObject({
      code: 'unreadable', message: 'The uploaded file could not be found. Upload it again.',
    });
  });
});
