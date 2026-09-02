/**
 * MCP write tool `attach_document`.
 *
 * Every refusal is pre-write (the service checks bytes and ownership before
 * its INSERT), so toolError is the right shape throughout. The load-bearing
 * assertions: the service receives DECODED bytes (not the base64), the
 * declared mime is gated at runtime (schema enums are advisory), and a
 * cross-tenant transaction reads as the generic NOT_FOUND.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/bank/bankTxAttachmentService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/bank/bankTxAttachmentService')>();
  return { ...real, addBankTxAttachment: vi.fn() };
});
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReferences: vi.fn(async () => new Map()),
}));

import { addBankTxAttachment } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { findBankTransactionsByReferences } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { ATTACH_MAX_BYTES, attachDocumentTool } from '@/lib/mcp/tools/writeAttachDocument';
import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import type { McpToolContext } from '@/lib/mcp/types';

const TX = '55555555-5555-5555-5555-555555555555';
const ctx: McpToolContext = {
  userId: '11111111-1111-1111-1111-111111111111', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['write:bank-tx'], tokenJti: 'j', oauthAppId: null,
};
// A real PNG header so the (unmocked) magic-byte path could pass if it ran.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const base = { transaction_id: TX, file_name: 'slip.png', mime_type: 'image/png', idempotency_key: 'k' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(addBankTxAttachment).mockResolvedValue({
    ok: true,
    attachment: { id: 'a1', bankTransactionId: TX, fileName: 'slip.png', fileSize: PNG.length, mimeType: 'image/png', createdAt: 'now' },
  });
});

describe('attach_document', () => {
  it('is a write tool on write:bank-tx that does NOT require write:post', () => {
    const t = MCP_TOOLS.find((x) => x.name === 'attach_document')!;
    expect(t.write).toBe(true);
    expect(t.scope).toBe('write:bank-tx');
    expect(t.requiresPost).toBeFalsy();
    expect(t.inputSchema.required).toContain('idempotency_key');
  });

  it('decodes raw base64 and hands the service bytes, cap and ctx identities', async () => {
    const res = await attachDocumentTool.handler({ ...base, content: PNG.toString('base64') }, ctx);
    expect(res.isError).toBeFalsy();
    const [companyId, input] = vi.mocked(addBankTxAttachment).mock.calls[0]!;
    expect(companyId).toBe(ctx.companyId);
    expect(input.bankTransactionId).toBe(TX);
    expect(Buffer.compare(input.bytes, PNG)).toBe(0);
    expect(input.maxBytes).toBe(ATTACH_MAX_BYTES);
    expect(input.uploadedBy).toBe(ctx.userId);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ attachment_id: 'a1', file_size: PNG.length });
  });

  it('accepts a data: URL and strips the prefix before decoding', async () => {
    await attachDocumentTool.handler({ ...base, content: `data:image/png;base64,${PNG.toString('base64')}` }, ctx);
    expect(Buffer.compare(vi.mocked(addBankTxAttachment).mock.calls[0]![1].bytes, PNG)).toBe(0);
  });

  it('gates mime_type at runtime — the schema enum is advisory', async () => {
    const res = await attachDocumentTool.handler({ ...base, mime_type: 'text/html', content: 'AAAA' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('invalid mime_type');
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });

  it('refuses an uncastable transaction_id and an absent selector pre-write', async () => {
    const bad = await attachDocumentTool.handler({ ...base, transaction_id: 'abc', content: 'AAAA' }, ctx);
    expect(bad.content[0]!.text).toBe('invalid transaction_id');
    const none = await attachDocumentTool.handler({ ...base, transaction_id: undefined, content: 'AAAA' }, ctx);
    expect(none.isError).toBe(true);
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });

  it('resolves bank_reference through the shared selector and refuses a miss generically', async () => {
    const res = await attachDocumentTool.handler(
      { ...base, transaction_id: undefined, bank_reference: 'REF-1', content: 'AAAA' }, ctx,
    );
    expect(findBankTransactionsByReferences).toHaveBeenCalledWith(ctx.companyId, ['REF-1'], undefined);
    expect(res.content[0]!.text).toBe('Not found');
    expect(addBankTxAttachment).not.toHaveBeenCalled();
  });

  it('maps each service refusal to a tool error; a foreign transaction reads as Not found', async () => {
    const cases: Array<[Parameters<typeof addBankTxAttachment>[1] extends never ? never : string, string]> = [
      ['bank_tx_not_found', 'Not found'],
      ['type_mismatch', 'do not match mime_type'],
      ['too_large', 'exceeds the 750 KB limit'],
      ['empty', 'zero bytes'],
    ];
    for (const [reason, text] of cases) {
      vi.mocked(addBankTxAttachment).mockResolvedValueOnce({ ok: false, reason } as never);
      const res = await attachDocumentTool.handler({ ...base, content: 'AAAA' }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain(text);
    }
  });
});
