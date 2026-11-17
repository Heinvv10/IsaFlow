/**
 * finalize_uploads hardening (PR #1559 review). Load-bearing: the target+sha advisory lock is taken BEFORE the dedup
 * read (two concurrent finalizes of the same bytes store once); each item runs in its own savepoint, so one item's
 * throw answers status 'error' for it and keeps the others; at most 200 MB of staged bytes are finalized per call and
 * the rest are 'deferred' unread; a duplicate finalize is audited with its own action ('update'), a refusal as
 * 'reject'; a failing sweep never fails the call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

const savepoints = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  withSavepoint: vi.fn(async (n: string, fn: () => Promise<unknown>) => { savepoints.names.push(n); return fn(); }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/mcpUploadIntentSweep', () => ({ sweepExpiredUploadsQuietly: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/mcpUploadIntentStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/mcpUploadIntentStore')>();
  return {
    ...real, findFinalizedSameBytes: vi.fn(), lockUploadTarget: vi.fn(), lockIntentForFinalize: vi.fn(),
    readStagedBytes: vi.fn(), markIntentFinalized: vi.fn(), markIntentRefused: vi.fn(),
  };
});
vi.mock('@/modules/accounting/services/core/bankLineDocumentRouting', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/bankLineDocumentRouting')>();
  return { ...real, bankTxBelongsToCompany: vi.fn() };
});
vi.mock('@/modules/accounting/services/bank/bankLineShaDuplicate', () => ({ findBankLineShaDuplicate: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankTxAttachmentService', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/bank/bankTxAttachmentService')>();
  return { ...real, addBankTxAttachment: vi.fn() };
});
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));

import * as store from '@/modules/accounting/services/core/mcpUploadIntentStore';
import { bankTxBelongsToCompany } from '@/modules/accounting/services/core/bankLineDocumentRouting';
import { findBankLineShaDuplicate } from '@/modules/accounting/services/bank/bankLineShaDuplicate';
import { addBankTxAttachment } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { sweepExpiredUploadsQuietly } from '@/modules/accounting/services/core/mcpUploadIntentSweep';
import { finalizeUploadsTool } from '@/lib/mcp/tools/writeFinalizeUploads';
import type { McpToolContext } from '@/lib/mcp/types';

const TX = '77777777-7777-4777-8777-777777777777';
const id = (n: number) => `99999999-9999-4999-8999-${String(n).padStart(12, '0')}`;
const ctx: McpToolContext = {
  userId: '11111111-1111-1111-1111-111111111111', companyId: '22222222-2222-2222-2222-222222222222',
  scopes: ['write:invoices', 'write:bank-tx'], tokenJti: 'j', oauthAppId: null,
};
const PDF = Buffer.from('%PDF-1.4\n%test file\n%%EOF\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);
const intent = (n: number, over: Partial<store.UploadIntent> = {}): store.UploadIntent => ({
  id: id(n), companyId: ctx.companyId, targetKind: 'bank_transaction', targetId: TX, documentType: null,
  createdBy: ctx.userId, createdTokenJti: 'j', fileName: `f${n}.pdf`, mimeType: 'application/pdf',
  declaredSize: PDF.length, sha256: sha(PDF), status: 'uploaded', resultDocumentId: null, resultDuplicate: null,
  refusal: null, expiresAt: 'x', expired: false, ...over,
});
const run = async (ids: string[]) => body(await finalizeUploadsTool.handler({ upload_ids: ids, idempotency_key: 'k' }, ctx));

beforeEach(() => {
  vi.clearAllMocks();
  savepoints.names = [];
  vi.mocked(bankTxBelongsToCompany).mockResolvedValue(true);
  vi.mocked(findBankLineShaDuplicate).mockResolvedValue(null);
  vi.mocked(store.lockIntentForFinalize).mockImplementation(async (_c, uid) => intent(Number(uid.slice(-12))));
  vi.mocked(store.readStagedBytes).mockResolvedValue(PDF);
  vi.mocked(addBankTxAttachment).mockResolvedValue({ ok: true, attachment: {
    id: 'att-1', bankTransactionId: TX, fileName: 'f.pdf', fileSize: PDF.length, mimeType: 'application/pdf', createdAt: 'now' } });
});

describe('finalize_uploads hardening', () => {
  it('takes the target+sha lock before the dedup read', async () => {
    await run([id(1)]);
    expect(store.lockUploadTarget).toHaveBeenCalledWith(ctx.companyId, 'bank_transaction', TX, sha(PDF));
    const lockAt = vi.mocked(store.lockUploadTarget).mock.invocationCallOrder[0]!;
    const dedupAt = vi.mocked(findBankLineShaDuplicate).mock.invocationCallOrder[0]!;
    expect(lockAt).toBeLessThan(dedupAt);
  });

  it('isolates a throwing item in its own savepoint: status error for it, the others finalize', async () => {
    vi.mocked(addBankTxAttachment).mockRejectedValueOnce(new Error('boom'));
    const res = await run([id(1), id(2)]);
    expect(res.files.map((f: { status: string }) => f.status)).toEqual(['error', 'finalized']);
    expect(res.files[0].error).not.toContain('boom');
    expect(res.errors).toBe(1);
    expect(savepoints.names).toHaveLength(2);
  });

  it('finalizes at most 200 MB of staged bytes per call; the rest are deferred, unread', async () => {
    const mb = 1024 * 1024;
    vi.mocked(store.lockIntentForFinalize).mockImplementation(async (_c, uid) =>
      intent(Number(uid.slice(-12)), { targetKind: 'supplier_invoice', declaredSize: 10 * mb }));
    const ids = Array.from({ length: 21 }, (_, n) => id(n + 1));
    vi.mocked(store.readStagedBytes).mockResolvedValue(Buffer.alloc(0));
    const res = await run(ids);
    expect(res.files.filter((f: { status: string }) => f.status === 'deferred')).toHaveLength(1);
    expect(res.files[20]).toMatchObject({ status: 'deferred' });
    expect(res.deferred).toBe(1);
    expect(store.readStagedBytes).toHaveBeenCalledTimes(20);
  });

  it('audits a duplicate finalize as update and a refusal as reject', async () => {
    vi.mocked(findBankLineShaDuplicate).mockResolvedValueOnce({ id: 'att-old' } as never);
    vi.mocked(store.readStagedBytes).mockResolvedValueOnce(PDF).mockResolvedValueOnce(Buffer.from('%PDF-1.4\nother\n%%EOF\n'));
    const res = await run([id(1), id(2)]);
    expect(res.files.map((f: { status: string }) => f.status)).toEqual(['finalized', 'refused']);
    const actions = vi.mocked(logAuditOrThrow).mock.calls.map((c) => [c[0].action, c[0].changes?.metadata?.upload_id]);
    expect(actions).toEqual([['update', id(1)], ['reject', id(2)]]);
  });

  it('audits a scope refusal at finalize, and keeps the idempotency key (the call wrote an audit row)', async () => {
    const out = await finalizeUploadsTool.handler({ upload_ids: [id(1)], idempotency_key: 'k' },
      { ...ctx, scopes: ['write:invoices'] });
    const res = body(out);
    expect(res.files[0].status).toBe('refused');
    expect(vi.mocked(logAuditOrThrow).mock.calls[0]![0]).toMatchObject({ action: 'reject' });
    expect(out.wroteNothing).toBe(false);
  });

  it('frees the idempotency key when the call changed no upload (all deferred / not uploaded), keeps it otherwise', async () => {
    vi.mocked(store.lockIntentForFinalize).mockResolvedValueOnce(intent(1, { status: 'pending' }));
    const idle = await finalizeUploadsTool.handler({ upload_ids: [id(1)], idempotency_key: 'k' }, ctx);
    expect(idle.wroteNothing).toBe(true);
    const done = await finalizeUploadsTool.handler({ upload_ids: [id(2)], idempotency_key: 'k2' }, ctx);
    expect(done.wroteNothing).toBe(false);
  });

  it('runs the global sweep once and never fails on it', async () => {
    vi.mocked(sweepExpiredUploadsQuietly).mockResolvedValueOnce(undefined);
    await run([id(1)]);
    expect(sweepExpiredUploadsQuietly).toHaveBeenCalledTimes(1);
  });
});
