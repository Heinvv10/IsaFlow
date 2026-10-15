/**
 * MCP write tool `attach_entity_document`.
 *
 * Load-bearing: every refusal precedes the store (the service uploads, then
 * INSERTs); ownership is checked against the DECLARED entity type; a re-run
 * with the same file returns the existing row instead of storing it twice;
 * extraction is off unless asked for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/core/documentStorageService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/documentStorageService')>();
  return {
    ...real,
    verifyEntityOwnershipTyped: vi.fn(),
    findActiveDuplicate: vi.fn(),
    storeDocumentBytes: vi.fn(),
  };
});
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  findActiveDuplicate,
  storeDocumentBytes,
  verifyEntityOwnershipTyped,
} from '@/modules/accounting/services/core/documentStorageService';
import { ATTACH_ENTITY_MAX_BYTES, attachEntityDocumentTool } from '@/lib/mcp/tools/writeAttachEntityDocument';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import type { McpToolContext } from '@/lib/mcp/types';

const BILL = '66666666-6666-4666-8666-666666666666';
const ctx: McpToolContext = {
  userId: '11111111-1111-1111-1111-111111111111', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['write:invoices'], tokenJti: 'j', oauthAppId: null,
};
const PDF = Buffer.from('%PDF-1.4\n%test\n', 'latin1');
const base = {
  entity_type: 'supplier_invoice', entity_id: BILL, file_name: 'SIV0005104 FTTX.pdf',
  mime_type: 'application/pdf', idempotency_key: 'k',
};
const stored = {
  id: 'd1', entityType: 'supplier_invoice', entityId: BILL, documentType: 'invoice' as const,
  documentName: 'SIV0005104_FTTX.pdf', fileUrl: 'u', fileSize: PDF.length, mimeType: 'application/pdf',
  uploadedBy: ctx.userId, uploadedAt: '2026-10-15T00:00:00.000Z', isActive: true, source: 'direct' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyEntityOwnershipTyped).mockResolvedValue(true);
  vi.mocked(findActiveDuplicate).mockResolvedValue(null);
  vi.mocked(storeDocumentBytes).mockResolvedValue(stored);
});

describe('attach_entity_document', () => {
  it('is a write tool on write:invoices that does NOT require write:post', () => {
    const t = MCP_TOOLS.find((x) => x.name === 'attach_entity_document')!;
    expect(t.write).toBe(true);
    expect(t.scope).toBe('write:invoices');
    expect(t.requiresPost).toBeFalsy();
    expect(t.inputSchema.required).toEqual(
      expect.arrayContaining(['entity_type', 'entity_id', 'content', 'idempotency_key']),
    );
  });

  it('stores decoded bytes with the ctx identities, default document type and extraction off', async () => {
    const res = await attachEntityDocumentTool.handler({ ...base, content: PDF.toString('base64') }, ctx);
    expect(res.isError).toBeFalsy();
    expect(verifyEntityOwnershipTyped).toHaveBeenCalledWith('supplier_invoice', BILL, ctx.companyId);
    const input = vi.mocked(storeDocumentBytes).mock.calls[0]![0];
    expect(input.companyId).toBe(ctx.companyId);
    expect(input.uploadedBy).toBe(ctx.userId);
    expect(input.documentType).toBe('invoice');
    expect(input.extract).toBe(false);
    expect(Buffer.compare(input.buffer, PDF)).toBe(0);
    expect(input.size).toBe(PDF.length);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ document_id: 'd1', duplicate: false });
  });

  it('defaults credit notes to credit_note_doc and payments to proof_of_payment; passes extract through', async () => {
    await attachEntityDocumentTool.handler({ ...base, entity_type: 'credit_note', content: PDF.toString('base64') }, ctx);
    await attachEntityDocumentTool.handler(
      { ...base, entity_type: 'supplier_payment', extract: true, content: PDF.toString('base64') }, ctx,
    );
    const [cn, pay] = vi.mocked(storeDocumentBytes).mock.calls.map((c) => c[0]);
    expect(cn!.documentType).toBe('credit_note_doc');
    expect(pay!.documentType).toBe('proof_of_payment');
    expect(pay!.extract).toBe(true);
  });

  it('returns the existing row and stores nothing when the same file is already on the entity', async () => {
    vi.mocked(findActiveDuplicate).mockResolvedValueOnce(stored);
    const res = await attachEntityDocumentTool.handler({ ...base, content: PDF.toString('base64') }, ctx);
    expect(findActiveDuplicate).toHaveBeenCalledWith('supplier_invoice', BILL, base.file_name, PDF.length);
    expect(storeDocumentBytes).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ document_id: 'd1', duplicate: true });
  });

  it('reads a foreign or wrong-type entity as Not found, before any store', async () => {
    vi.mocked(verifyEntityOwnershipTyped).mockResolvedValueOnce(false);
    const res = await attachEntityDocumentTool.handler({ ...base, content: PDF.toString('base64') }, ctx);
    expect(res.content[0]!.text).toBe('Not found');
    expect(findActiveDuplicate).not.toHaveBeenCalled();
    expect(storeDocumentBytes).not.toHaveBeenCalled();
  });

  it('refuses bad arguments pre-write', async () => {
    const b64 = PDF.toString('base64');
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, entity_type: 'bank_transaction', content: b64 }, 'invalid entity_type'],
      [{ ...base, entity_id: 'abc', content: b64 }, 'entity_id'],
      [{ ...base, document_type: 'payslip', content: b64 }, 'invalid document_type'],
      [{ ...base, mime_type: 'text/html', content: b64 }, 'invalid mime_type'],
      [{ ...base, mime_type: 'image/png', content: b64 }, 'do not match mime_type'],
      [{ ...base, content: '' }, 'content is required'],
      [{ ...base, file_name: 'x'.repeat(201), content: b64 }, 'file_name exceeds'],
    ];
    for (const [args, text] of cases) {
      const res = await attachEntityDocumentTool.handler(args, ctx);
      expect(res.isError, text).toBe(true);
      expect(res.content[0]!.text).toContain(text);
    }
    expect(verifyEntityOwnershipTyped).not.toHaveBeenCalled();
    expect(storeDocumentBytes).not.toHaveBeenCalled();
  });

  it('refuses a file over the 2 MB cap before the ownership read', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(ATTACH_ENTITY_MAX_BYTES)]);
    const res = await attachEntityDocumentTool.handler({ ...base, content: big.toString('base64') }, ctx);
    expect(res.content[0]!.text).toContain('exceeds the 2 MB limit');
    expect(verifyEntityOwnershipTyped).not.toHaveBeenCalled();
  });
});
