/**
 * PUT /api/mcp/uploads/<token>: the token is the only credential and works once. Load-bearing: an unknown token is 404,
 * a used or expired one is 409 and stages nothing; a body over the declared size is 413 without buffering past it; a
 * body whose size, sha256 or magic bytes differ from the declaration is 400 and stages nothing; a good body is staged
 * against the intent's id AND company. The store, the transaction wrapper and the limiter are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { createHash } from 'crypto';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: logs, apiLogger: logs, default: logs }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/publicRouteTx', () => ({ withPublicRouteTransaction: async (_l: string, fn: () => Promise<unknown>) => fn() }));
const limiter = vi.hoisted(() => ({ allow: true }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => limiter.allow), getClientIp: () => '1.2.3.4' }));
vi.mock('@/modules/accounting/services/core/mcpUploadIntentSweep', () => ({ sweepExpiredUploadsQuietly: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/modules/accounting/services/core/mcpUploadIntentStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/accounting/services/core/mcpUploadIntentStore')>();
  return { ...real, findIntentByToken: vi.fn(), stageUploadBytes: vi.fn() };
});

import {
  findIntentByToken, hashUploadToken, stageUploadBytes, type UploadIntent,
} from '@/modules/accounting/services/core/mcpUploadIntentStore';
import { checkRateLimit } from '@/lib/rateLimit';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { sweepExpiredUploadsQuietly } from '@/modules/accounting/services/core/mcpUploadIntentSweep';
import { uploadReadLimits } from '@/lib/mcp/uploadBody';
import route from '../../../pages/api/mcp/uploads/[token]';

const TOKEN = 'a'.repeat(43);
const PDF = Buffer.from('%PDF-1.4\n%upload body\n%%EOF\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const COMPANY = '22222222-2222-2222-2222-222222222222';
const intent = (over: Partial<UploadIntent> = {}): UploadIntent => ({
  id: 'up-1', companyId: COMPANY, targetKind: 'bank_transaction', targetId: 't', documentType: null,
  createdBy: 'u', createdTokenJti: 'j',
  fileName: 'slip.pdf', mimeType: 'application/pdf', declaredSize: PDF.length, sha256: sha(PDF), status: 'pending',
  resultDocumentId: null, resultDuplicate: null, refusal: null, expiresAt: 'x', expired: false, ...over,
});

function res() {
  const r = { statusCode: 200, body: undefined as unknown, headersSent: false,
    status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; },
    setHeader() { return r; }, getHeader() { return undefined; }, on() { return r; }, end() { return r; } };
  return r;
}
async function put(bytes: Buffer, over: Record<string, unknown> = {}, stream?: Readable) {
  const req = Object.assign(stream ?? Readable.from([bytes]), {
    method: 'PUT', headers: {}, socket: {}, url: `/api/mcp/uploads/${TOKEN}`, query: { token: TOKEN }, ...over,
  });
  const out = res();
  await (route as (q: unknown, s: unknown) => Promise<unknown>)(req, out);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  limiter.allow = true;
  vi.mocked(findIntentByToken).mockResolvedValue(intent());
  vi.mocked(stageUploadBytes).mockResolvedValue(true);
});

describe('PUT /api/mcp/uploads/<token>', () => {
  it('stages a body that matches the declaration, against the intent id and company', async () => {
    const r = await put(PDF);
    expect(r.statusCode).toBe(200);
    expect(stageUploadBytes).toHaveBeenCalledWith(COMPANY, 'up-1', PDF);
    expect(r.body).toMatchObject({ data: { upload_id: 'up-1', status: 'uploaded' } });
    expect(vi.mocked(logAuditOrThrow).mock.calls[0]![0]).toMatchObject({
      companyId: COMPANY, userId: 'u', action: 'update', entityType: 'mcp_upload_intent', entityId: 'up-1' });
    expect(sweepExpiredUploadsQuietly).toHaveBeenCalledTimes(1);
  });

  it('refuses a polyglot body: right magic bytes, but not a complete file of the declared type', async () => {
    const poly = Buffer.from('%PDF-1.4\n<html><script>alert(1)</script></html>\n');
    vi.mocked(findIntentByToken).mockResolvedValueOnce(intent({ declaredSize: poly.length, sha256: sha(poly) }));
    const r = await put(poly);
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.body)).toContain('complete');
    expect(stageUploadBytes).not.toHaveBeenCalled();
  });

  it('stops reading a stalled body (400) and an aborted one (400), staging nothing', async () => {
    const saved = { ...uploadReadLimits };
    uploadReadLimits.idleMs = 20;
    try {
      const stalled = new Readable({ read() { /* never ends */ } });
      stalled.push(PDF.subarray(0, 4));
      const r = await put(PDF, {}, stalled);
      expect(r.statusCode).toBe(400);
      expect(JSON.stringify(r.body)).toContain('stalled');
      const aborted = new Readable({ read() { /* the client goes away */ } });
      aborted.push(PDF.subarray(0, 4));
      setTimeout(() => aborted.destroy(), 5);
      expect((await put(PDF, {}, aborted)).statusCode).toBe(400);
    } finally {
      Object.assign(uploadReadLimits, saved);
    }
    expect(stageUploadBytes).not.toHaveBeenCalled();
  });

  it('refuses a malformed or unknown token as 404 and a used or expired one as 409, staging nothing', async () => {
    expect((await put(PDF, { query: { token: 'short' } })).statusCode).toBe(404);
    expect(findIntentByToken).not.toHaveBeenCalled();
    vi.mocked(findIntentByToken).mockResolvedValueOnce(null);
    expect((await put(PDF)).statusCode).toBe(404);
    vi.mocked(findIntentByToken).mockResolvedValueOnce(intent({ status: 'uploaded' }));
    expect((await put(PDF)).statusCode).toBe(409);
    vi.mocked(findIntentByToken).mockResolvedValueOnce(intent({ expired: true }));
    expect((await put(PDF)).statusCode).toBe(409);
    expect(stageUploadBytes).not.toHaveBeenCalled();
  });

  it('refuses a body larger than declared as 413 (header or streamed)', async () => {
    const big = Buffer.concat([PDF, Buffer.from('extra')]);
    expect((await put(big, { headers: { 'content-length': String(big.length) } })).statusCode).toBe(413);
    expect((await put(big)).statusCode).toBe(413);
    expect(stageUploadBytes).not.toHaveBeenCalled();
  });

  it('refuses a short body, a sha mismatch and a mime mismatch as 400', async () => {
    expect((await put(PDF.subarray(0, 5))).statusCode).toBe(400);
    vi.mocked(findIntentByToken).mockResolvedValueOnce(intent({ sha256: 'f'.repeat(64) }));
    const shaBad = await put(PDF);
    expect(shaBad.statusCode).toBe(400);
    expect(JSON.stringify(shaBad.body)).toContain('sha256');
    vi.mocked(findIntentByToken).mockResolvedValueOnce(intent({ mimeType: 'image/png' }));
    const mimeBad = await put(PDF);
    expect(mimeBad.statusCode).toBe(400);
    expect(JSON.stringify(mimeBad.body)).toContain('mime_type');
    expect(stageUploadBytes).not.toHaveBeenCalled();
  });

  it('answers 409 when another PUT staged first (the compare-and-set lost)', async () => {
    vi.mocked(stageUploadBytes).mockResolvedValueOnce(false);
    expect((await put(PDF)).statusCode).toBe(409);
  });

  it('is PUT only and rate-limited per token and per company (the client IP is the proxy\'s), under a global ceiling', async () => {
    expect((await put(PDF, { method: 'POST' })).statusCode).toBe(405);
    await put(PDF);
    const keys = vi.mocked(checkRateLimit).mock.calls.map((c) => c[0]);
    expect(keys).toEqual([
      'mcp-upload:all', `mcp-upload-token:${hashUploadToken(TOKEN).slice(0, 32)}`, `mcp-upload-company:${COMPANY}`]);
    expect(keys.some((k) => k.includes('1.2.3.4'))).toBe(false);
    limiter.allow = false;
    expect((await put(PDF)).statusCode).toBe(429);
    expect(findIntentByToken).toHaveBeenCalledTimes(1);
  });
});
