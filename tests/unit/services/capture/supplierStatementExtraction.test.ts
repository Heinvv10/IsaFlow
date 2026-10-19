/**
 * Where a supplier statement's lines come from: a PDF is read page by page by the VLM (there is no
 * deterministic parser for supplier layouts), an image in one call. Nothing here touches a
 * database except fetching the stored bytes, by company.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupplierStatementExtraction } from '@/modules/accounting/services/bank/vlmSupplierStatementService';

const m = vi.hoisted(() => ({
  fetchRawBytes: vi.fn(),
  readStatementPdf: vi.fn(),
  extractImage: vi.fn(),
  readPage: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/documentStorage', () => ({ fetchRawBytes: m.fetchRawBytes }));
vi.mock('@/modules/accounting/services/bank/vlmSupplierStatementService', () => ({
  extractSupplierStatementImage: m.extractImage, readSupplierStatementPage: m.readPage,
}));
vi.mock('@/modules/accounting/services/bank/vlmStatementPages', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/bank/vlmStatementPages')>()),
  readStatementPdf: m.readStatementPdf,
}));

import { extractSupplierStatementFromDocument } from '@/modules/accounting/services/capture/supplierStatementExtraction';

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const DOC = 'cccccccc-0000-0000-0000-000000000003';
const PDF = Buffer.from('%PDF-1.4 fake');
const page = (over: Partial<SupplierStatementExtraction> = {}): SupplierStatementExtraction => ({ lines: [], warnings: [], ...over });

beforeEach(() => {
  vi.resetAllMocks();
  process.env.VLLM_BASE_URL = 'http://vlm.test';
  m.fetchRawBytes.mockResolvedValue({ buffer: PDF, hash: 'h', size: PDF.length, fileType: 'pdf' });
});

describe('a PDF', () => {
  it('is read page by page and the pages merged', async () => {
    m.readStatementPdf.mockResolvedValue([
      page({ supplierName: 'Acme', openingBalance: 0, lines: [{ reference: 'INV1', debit: 10 }] }),
      page({ closingBalance: 30, lines: [{ reference: 'INV2', debit: 20 }] }),
    ]);
    const onProgress = vi.fn();
    const out = await extractSupplierStatementFromDocument(CO, DOC, onProgress);
    expect(m.fetchRawBytes).toHaveBeenCalledWith(DOC, CO);
    expect(m.readStatementPdf).toHaveBeenCalledWith(PDF, 'supplier', m.readPage, onProgress);
    expect(out.supplierName).toBe('Acme');
    expect(out.closingBalance).toBe(30);
    expect(out.lines.map((l) => l.reference)).toEqual(['INV1', 'INV2']);
  });

  it('fails when vLLM is not configured, without reading any page', async () => {
    delete process.env.VLLM_BASE_URL;
    await expect(extractSupplierStatementFromDocument(CO, DOC)).rejects.toMatchObject({ code: 'unavailable' });
    expect(m.readStatementPdf).not.toHaveBeenCalled();
  });

  it('lets a page-read failure fail the extraction', async () => {
    m.readStatementPdf.mockRejectedValue(new Error('Page 2 of 3 could not be read.'));
    await expect(extractSupplierStatementFromDocument(CO, DOC)).rejects.toThrow('Page 2 of 3');
  });
});

describe('an image', () => {
  beforeEach(() => {
    m.fetchRawBytes.mockResolvedValue({ buffer: Buffer.from('imgbytes'), hash: 'h', size: 8, fileType: 'jpeg' });
  });

  it('is read in one call with its mime type', async () => {
    m.extractImage.mockResolvedValue(page({ lines: [{ reference: 'A', debit: 1 }] }));
    const out = await extractSupplierStatementFromDocument(CO, DOC);
    expect(m.extractImage).toHaveBeenCalledWith(Buffer.from('imgbytes').toString('base64'), 'image/jpeg');
    expect(m.readStatementPdf).not.toHaveBeenCalled();
    expect(out.lines).toHaveLength(1);
  });

  it('fails when the model gives no answer', async () => {
    m.extractImage.mockResolvedValue(null);
    await expect(extractSupplierStatementFromDocument(CO, DOC)).rejects.toMatchObject({ code: 'page_failed' });
  });

  it('fails when vLLM is not configured', async () => {
    delete process.env.VLLM_BASE_URL;
    await expect(extractSupplierStatementFromDocument(CO, DOC)).rejects.toMatchObject({ code: 'unavailable' });
    expect(m.extractImage).not.toHaveBeenCalled();
  });
});

describe('a file that is neither a PDF nor an image', () => {
  it('is refused without a call to the model', async () => {
    m.fetchRawBytes.mockResolvedValue({ buffer: Buffer.from('x'), hash: 'h', size: 1, fileType: 'bin' });
    await expect(extractSupplierStatementFromDocument(CO, DOC)).rejects.toMatchObject({ code: 'unreadable' });
    expect(m.extractImage).not.toHaveBeenCalled();
  });
});

describe('a missing document', () => {
  it('fails with a user-safe message', async () => {
    m.fetchRawBytes.mockResolvedValue(null);
    await expect(extractSupplierStatementFromDocument(CO, DOC)).rejects.toMatchObject({
      code: 'unreadable', message: 'The uploaded file could not be found. Upload it again.',
    });
  });
});
