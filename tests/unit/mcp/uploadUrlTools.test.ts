/**
 * create_upload_urls + finalize_uploads: attach files with no bytes in the tool call.
 *
 * Load-bearing: a target is checked against the company before any url is issued (cross-company reads "Not found");
 * mime / size / sha are refused up front; a file already on its target is duplicate: true with no url; finalize
 * refuses bytes whose sha or magic bytes do not match, writes once, audits each finalize, and a second finalize of the
 * same id returns its first result without writing again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('@/modules/accounting/services/core/mcpUploadIntentSweep', () => ({ sweepExpiredUploadsQuietly: vi.fn(async () => undefined) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/mcpUploadIntentStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/mcpUploadIntentStore')>();
  return {
    ...real, insertUploadIntent: vi.fn(), findFinalizedSameBytes: vi.fn(), lockUploadTarget: vi.fn(),
    lockAndReadUploadUsage: vi.fn(), lockIntentForFinalize: vi.fn(), readStagedBytes: vi.fn(),
    markIntentFinalized: vi.fn(), markIntentRefused: vi.fn(),
  };
});
vi.mock('@/modules/accounting/services/core/bankLineDocumentRouting', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/bankLineDocumentRouting')>();
  return { ...real, bankTxBelongsToCompany: vi.fn(), findBankLineDuplicate: vi.fn() };
});
vi.mock('@/modules/accounting/services/bank/bankLineShaDuplicate', () => ({ findBankLineShaDuplicate: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankTxAttachmentService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/bank/bankTxAttachmentService')>();
  return { ...real, addBankTxAttachment: vi.fn() };
});
vi.mock('@/modules/accounting/services/core/documentStorageService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/documentStorageService')>();
  return { ...real, verifyEntityOwnershipTyped: vi.fn(), findActiveDuplicate: vi.fn(), storeDocumentBytes: vi.fn() };
});
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));

import * as store from '@/modules/accounting/services/core/mcpUploadIntentStore';
import { bankTxBelongsToCompany, findBankLineDuplicate } from '@/modules/accounting/services/core/bankLineDocumentRouting';
import { findBankLineShaDuplicate } from '@/modules/accounting/services/bank/bankLineShaDuplicate';
import { addBankTxAttachment } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { findActiveDuplicate, storeDocumentBytes, verifyEntityOwnershipTyped } from '@/modules/accounting/services/core/documentStorageService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { sweepExpiredUploadsQuietly } from '@/modules/accounting/services/core/mcpUploadIntentSweep';
import { createUploadUrlsTool } from '@/lib/mcp/tools/writeCreateUploadUrls';
import { finalizeUploadsTool } from '@/lib/mcp/tools/writeFinalizeUploads';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import type { McpToolContext } from '@/lib/mcp/types';

const TX = '77777777-7777-4777-8777-777777777777';
const BILL = '88888888-8888-4888-8888-888888888888';
const UP = '99999999-9999-4999-8999-999999999999';
const ctx = (scopes = ['write:invoices', 'write:bank-tx']): McpToolContext => ({
  userId: '11111111-1111-1111-1111-111111111111', companyId: '22222222-2222-2222-2222-222222222222',
  scopes, tokenJti: 'j', oauthAppId: null,
});
const PDF = Buffer.from('%PDF-1.4\n%test file\n%%EOF\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const file = (over: Record<string, unknown> = {}) => ({
  target: { bank_transaction_id: TX }, file_name: 'slip.pdf', mime_type: 'application/pdf', size: PDF.length, sha256: sha(PDF), ...over,
});
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);
const intent = (over: Partial<store.UploadIntent> = {}): store.UploadIntent => ({
  id: UP, companyId: ctx().companyId, targetKind: 'bank_transaction', targetId: TX, documentType: null,
  createdBy: '11111111-1111-1111-1111-111111111111', createdTokenJti: 'j',
  fileName: 'slip.pdf', mimeType: 'application/pdf', declaredSize: PDF.length, sha256: sha(PDF), status: 'uploaded',
  resultDocumentId: null, resultDuplicate: null, refusal: null, expiresAt: 'x', expired: false, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('JWT_SECRET', 'synthetic-upload-key-'.repeat(3));
  vi.mocked(bankTxBelongsToCompany).mockResolvedValue(true);
  vi.mocked(verifyEntityOwnershipTyped).mockResolvedValue(true);
  vi.mocked(findBankLineDuplicate).mockResolvedValue(null);
  vi.mocked(findBankLineShaDuplicate).mockResolvedValue(null);
  vi.mocked(findActiveDuplicate).mockResolvedValue(null);
  vi.mocked(store.findFinalizedSameBytes).mockResolvedValue(null);
  vi.mocked(store.insertUploadIntent).mockResolvedValue({ id: UP, token: 'T'.repeat(43), expiresAt: '2026-11-17T20:00:00.000Z' });
  vi.mocked(store.lockAndReadUploadUsage).mockResolvedValue({ count: 0, bytes: 0 });
  vi.mocked(store.readStagedBytes).mockResolvedValue(PDF);
  vi.mocked(addBankTxAttachment).mockResolvedValue({ ok: true, attachment: {
    id: 'att-1', bankTransactionId: TX, fileName: 'slip.pdf', fileSize: PDF.length, mimeType: 'application/pdf', createdAt: 'now' } });
});

describe('registration', () => {
  it('both are write tools on write:invoices that do not post', () => {
    for (const name of ['create_upload_urls', 'finalize_uploads']) {
      const t = MCP_TOOLS.find((x) => x.name === name)!;
      expect(t.write).toBe(true);
      expect(t.scope).toBe('write:invoices');
      expect(t.requiresPost).toBeFalsy();
      expect(t.inputSchema.required).toContain('idempotency_key');
    }
  });
});

describe('create_upload_urls', () => {
  it('issues a one-time url per new file, with the intent stored against the resolved target', async () => {
    const res = body(await createUploadUrlsTool.handler({ files: [file()], idempotency_key: 'k' }, ctx()));
    expect(res.urls_issued).toBe(1);
    expect(res.uploads[0]).toMatchObject({ status: 'url_issued', upload_id: UP, duplicate: false });
    expect(res.uploads[0].url).toMatch(/\/api\/mcp\/uploads\/T{43}$/);
    expect(vi.mocked(store.insertUploadIntent).mock.calls[0]![1]).toBe('j');
    expect(vi.mocked(store.insertUploadIntent).mock.calls[0]![2]).toMatchObject({
      targetKind: 'bank_transaction', targetId: TX, sha256: sha(PDF), size: PDF.length });
    expect(sweepExpiredUploadsQuietly).toHaveBeenCalledTimes(1);
  });

  it('issues no url, and reads nothing, when the server key for upload tokens is missing', async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const res = await createUploadUrlsTool.handler({ files: [file()], idempotency_key: 'k' }, ctx());
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('not configured');
      expect(store.insertUploadIntent).not.toHaveBeenCalled();
      expect(bankTxBelongsToCompany).not.toHaveBeenCalled();
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });

  it('refuses a cross-company target as Not found and issues no url', async () => {
    vi.mocked(verifyEntityOwnershipTyped).mockResolvedValue(false);
    const res = body(await createUploadUrlsTool.handler({ files: [file({ target: { entity_type: 'supplier_invoice', entity_id: BILL } })], idempotency_key: 'k' }, ctx()));
    expect(res.uploads[0]).toMatchObject({ status: 'refused', error: 'Not found' });
    expect(store.insertUploadIntent).not.toHaveBeenCalled();
  });

  it('refuses a wrong mime, a bad sha, an oversize file, and a bank target without write:bank-tx — per file', async () => {
    const res = body(await createUploadUrlsTool.handler({ files: [
      file({ mime_type: 'text/html' }),
      file({ sha256: 'abc' }),
      file({ size: 2 * 1024 * 1024 + 1 }),
      file({ target: { entity_type: 'supplier_invoice', entity_id: BILL }, mime_type: 'application/x-msdownload' }),
    ], idempotency_key: 'k' }, ctx()));
    expect(res.refused).toBe(4);
    expect(res.uploads.map((u: { error: string }) => u.error)).toEqual([
      expect.stringContaining('invalid mime_type'), expect.stringContaining('sha256'),
      expect.stringContaining('2 MB limit'), expect.stringContaining('invalid mime_type')]);
    const noBank = body(await createUploadUrlsTool.handler({ files: [file()], idempotency_key: 'k' }, ctx(['write:invoices'])));
    expect(noBank.uploads[0].error).toContain('write:bank-tx');
    expect(store.insertUploadIntent).not.toHaveBeenCalled();
  });

  it('reports a file already on its target as duplicate: true with no url, by sha256 only', async () => {
    vi.mocked(findBankLineShaDuplicate).mockResolvedValueOnce({ id: 'att-prev' } as never);
    vi.mocked(store.findFinalizedSameBytes).mockResolvedValueOnce('doc-prev');
    const res = body(await createUploadUrlsTool.handler({ files: [
      file(), file({ target: { entity_type: 'supplier_invoice', entity_id: BILL } }),
    ], idempotency_key: 'k' }, ctx()));
    expect(res.uploads[0]).toMatchObject({ status: 'duplicate', duplicate: true, document_id: 'att-prev' });
    expect(res.uploads[1]).toMatchObject({ status: 'duplicate', duplicate: true, document_id: 'doc-prev' });
    expect(res.uploads[0].url).toBeUndefined();
    expect(findBankLineShaDuplicate).toHaveBeenCalledWith(ctx().companyId, TX, sha(PDF), PDF.length);
    expect(store.findFinalizedSameBytes).toHaveBeenCalledWith(ctx().companyId, 'supplier_invoice', BILL, sha(PDF));
    expect(store.insertUploadIntent).not.toHaveBeenCalled();
  });

  it('never treats the same name and size with different bytes as a duplicate', async () => {
    vi.mocked(findBankLineDuplicate).mockResolvedValue({ id: 'att-name' } as never);
    vi.mocked(findActiveDuplicate).mockResolvedValue({ id: 'doc-name' } as never);
    const res = body(await createUploadUrlsTool.handler({ files: [
      file(), file({ target: { entity_type: 'supplier_invoice', entity_id: BILL } }),
    ], idempotency_key: 'k' }, ctx()));
    expect(res.urls_issued).toBe(2);
  });

  it('refuses, per file, past 300 outstanding uploads or 300 MB declared for the company', async () => {
    vi.mocked(store.lockAndReadUploadUsage).mockResolvedValue({ count: 299, bytes: 300 * 1024 * 1024 - PDF.length - 1 });
    const res = body(await createUploadUrlsTool.handler({ files: [
      file(), file({ sha256: 'a'.repeat(64) }), file({ sha256: 'b'.repeat(64), size: 1 }),
    ], idempotency_key: 'k' }, ctx()));
    expect(res.uploads.map((u: { status: string }) => u.status)).toEqual(['url_issued', 'refused', 'refused']);
    expect(res.uploads[1].error).toMatch(/300 uploads outstanding/);
    expect(store.insertUploadIntent).toHaveBeenCalledTimes(1);
    vi.mocked(store.lockAndReadUploadUsage).mockResolvedValue({ count: 0, bytes: 300 * 1024 * 1024 - 1 });
    const refusedAll = await createUploadUrlsTool.handler({ files: [file()], idempotency_key: 'k' }, ctx());
    expect(body(refusedAll).uploads[0].error).toMatch(/300 MB/);
    // No url issued: the key is freed so the same call can run once the cap allows.
    expect(refusedAll.wroteNothing).toBe(true);
  });

  it('caps size per target kind (bank 2 MB, entity 10 MB) and the file name at 200 characters', async () => {
    const mb = 1024 * 1024;
    const entity = { target: { entity_type: 'supplier_invoice', entity_id: BILL } };
    const res = body(await createUploadUrlsTool.handler({ files: [
      file({ size: 2 * mb }), file({ size: 2 * mb + 1, sha256: 'a'.repeat(64) }),
      file({ ...entity, size: 10 * mb }), file({ ...entity, size: 10 * mb + 1, sha256: 'b'.repeat(64) }),
      file({ file_name: `${'n'.repeat(196)}.pdf`, sha256: 'c'.repeat(64) }),
      file({ file_name: `${'n'.repeat(197)}.pdf`, sha256: 'd'.repeat(64) }),
    ], idempotency_key: 'k' }, ctx()));
    expect(res.uploads.map((u: { status: string }) => u.status))
      .toEqual(['url_issued', 'refused', 'url_issued', 'refused', 'url_issued', 'refused']);
    expect(res.uploads[1].error).toContain('2 MB limit');
    expect(res.uploads[3].error).toContain('10 MB limit');
    expect(res.uploads[5].error).toContain('200 characters');
  });

  it('issues one url when the same bytes are listed twice for one target', async () => {
    const res = body(await createUploadUrlsTool.handler({ files: [file(), file({ file_name: 'copy.pdf' })], idempotency_key: 'k' }, ctx()));
    expect(res.urls_issued).toBe(1);
    expect(res.uploads[1]).toMatchObject({ duplicate: true, duplicate_of_index: 0 });
  });

  it('refuses more than 100 files before reading anything', async () => {
    const res = await createUploadUrlsTool.handler({ files: Array.from({ length: 101 }, () => file()), idempotency_key: 'k' }, ctx());
    expect(res.isError).toBe(true);
    expect(bankTxBelongsToCompany).not.toHaveBeenCalled();
  });
});

describe('finalize_uploads', () => {
  it('verifies the staged bytes, writes the attachment once, marks it finalized and audits it', async () => {
    vi.mocked(store.lockIntentForFinalize).mockResolvedValue(intent());
    const res = body(await finalizeUploadsTool.handler({ upload_ids: [UP], idempotency_key: 'k' }, ctx()));
    expect(res.files[0]).toMatchObject({ status: 'finalized', document_id: 'att-1', duplicate: false });
    expect(vi.mocked(addBankTxAttachment).mock.calls[0]![1]).toMatchObject({ bankTransactionId: TX, maxBytes: 2 * 1024 * 1024 });
    expect(store.markIntentFinalized).toHaveBeenCalledWith(ctx().companyId, UP, 'att-1', false);
    expect(sweepExpiredUploadsQuietly).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAuditOrThrow).mock.calls[0]![0]).toMatchObject({ entityId: TX, action: 'create' });
  });

  it('writes an entity file to the entity store without extraction', async () => {
    vi.mocked(store.lockIntentForFinalize).mockResolvedValue(intent({ targetKind: 'supplier_invoice', targetId: BILL, documentType: 'invoice' }));
    vi.mocked(storeDocumentBytes).mockResolvedValue({ id: 'doc-1' } as never);
    const res = body(await finalizeUploadsTool.handler({ upload_ids: [UP], idempotency_key: 'k' }, ctx()));
    expect(res.files[0]).toMatchObject({ status: 'finalized', document_id: 'doc-1' });
    expect(vi.mocked(storeDocumentBytes).mock.calls[0]![0]).toMatchObject({ entityType: 'supplier_invoice', entityId: BILL, extract: false });
  });

  it('refuses bytes whose sha256 does not match, and bytes whose magic does not match the mime', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    vi.mocked(store.lockIntentForFinalize)
      .mockResolvedValueOnce(intent({ sha256: 'f'.repeat(64) }))
      .mockResolvedValueOnce(intent({ declaredSize: png.length, sha256: sha(png) }));
    vi.mocked(store.readStagedBytes).mockResolvedValueOnce(PDF).mockResolvedValueOnce(png);
    const res = body(await finalizeUploadsTool.handler({ upload_ids: [UP, '99999999-9999-4999-8999-999999999990'], idempotency_key: 'k' }, ctx()));
    expect(res.files.map((f: { status: string }) => f.status)).toEqual(['refused', 'refused']);
    expect(res.files[0].error).toContain('sha256');
    expect(res.files[1].error).toContain('do not match mime_type');
    expect(addBankTxAttachment).not.toHaveBeenCalled();
    expect(store.markIntentRefused).toHaveBeenCalledTimes(2);
  });

  it('returns the first result for an already finalized id, writing nothing', async () => {
    vi.mocked(store.lockIntentForFinalize).mockResolvedValue(intent({ status: 'finalized', resultDocumentId: 'att-1', resultDuplicate: false }));
    const res = body(await finalizeUploadsTool.handler({ upload_ids: [UP], idempotency_key: 'k2' }, ctx()));
    expect(res.files[0]).toMatchObject({ status: 'finalized', document_id: 'att-1', duplicate: false });
    expect(addBankTxAttachment).not.toHaveBeenCalled();
    expect(logAuditOrThrow).not.toHaveBeenCalled();
  });

  it('finalizes a file already on the line as duplicate: true without storing it again', async () => {
    vi.mocked(store.lockIntentForFinalize).mockResolvedValue(intent());
    vi.mocked(findBankLineShaDuplicate).mockResolvedValue({ id: 'att-old' } as never);
    const res = body(await finalizeUploadsTool.handler({ upload_ids: [UP], idempotency_key: 'k' }, ctx()));
    expect(res.files[0]).toMatchObject({ status: 'finalized', document_id: 'att-old', duplicate: true });
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });

  it('reports not_uploaded, expired and not_found (another company\'s id reads as not_found)', async () => {
    vi.mocked(store.lockIntentForFinalize)
      .mockResolvedValueOnce(intent({ status: 'pending' }))
      .mockResolvedValueOnce(intent({ status: 'uploaded', expired: true }))
      .mockResolvedValueOnce(null);
    const ids = [UP, '99999999-9999-4999-8999-999999999991', '99999999-9999-4999-8999-999999999992'];
    const res = body(await finalizeUploadsTool.handler({ upload_ids: ids, idempotency_key: 'k' }, ctx()));
    expect(res.files.map((f: { status: string }) => f.status)).toEqual(['not_uploaded', 'expired', 'not_found']);
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });

  it('refuses a bank-line upload to a token without write:bank-tx, verifying and writing nothing', async () => {
    vi.mocked(store.lockIntentForFinalize).mockResolvedValue(intent());
    const res = body(await finalizeUploadsTool.handler({ upload_ids: [UP], idempotency_key: 'k' }, ctx(['write:invoices'])));
    expect(res.files[0]).toMatchObject({ status: 'refused' });
    expect(res.files[0].error).toContain('write:bank-tx');
    expect(addBankTxAttachment).not.toHaveBeenCalled();
    expect(store.markIntentRefused).not.toHaveBeenCalled();
    expect(store.markIntentFinalized).not.toHaveBeenCalled();
  });

  it('finalizes only for the principal that created the upload (same user and same token)', async () => {
    vi.mocked(store.lockIntentForFinalize)
      .mockResolvedValueOnce(intent({ createdBy: '33333333-3333-4333-8333-333333333333' }))
      .mockResolvedValueOnce(intent({ createdTokenJti: 'other-token' }));
    const ids = [UP, '99999999-9999-4999-8999-999999999993'];
    const res = body(await finalizeUploadsTool.handler({ upload_ids: ids, idempotency_key: 'k' }, ctx()));
    expect(res.files.map((f: { status: string }) => f.status)).toEqual(['not_found', 'not_found']);
    expect(addBankTxAttachment).not.toHaveBeenCalled();
    expect(store.markIntentFinalized).not.toHaveBeenCalled();
  });

  it('refuses a non-uuid upload id before reading anything', async () => {
    const res = await finalizeUploadsTool.handler({ upload_ids: ['nope'], idempotency_key: 'k' }, ctx());
    expect(res.isError).toBe(true);
    expect(store.lockIntentForFinalize).not.toHaveBeenCalled();
  });
});
