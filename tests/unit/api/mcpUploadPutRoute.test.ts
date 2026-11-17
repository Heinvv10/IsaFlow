/**
 * PUT /api/mcp/uploads/<token>: the token is the only credential and works once. Load-bearing: an unknown token is 404,
 * a used or expired one is 409 and stages nothing; a body over the declared size is 413 without buffering past it; a
 * body whose size, sha256 or magic bytes differ from the declaration is 400 and stages nothing; a good body is staged
 * against the intent's id AND company. A token whose MAC does not verify (forged, tampered, or no server key) is 404
 * before any limiter or query. The store, the transaction wrapper and the limiter are mocked; the token MAC is real,
 * keyed by a test-only JWT_SECRET.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { createHash, randomBytes } from 'crypto';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: logs, apiLogger: logs, default: logs }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/publicRouteTx', () => ({ withPublicRouteTransaction: async (_l: string, fn: () => Promise<unknown>) => fn() }));
// A counting limiter: each key admits `max` calls (the real bucket's shape within one window).
const limiter = vi.hoisted(() => ({ allow: true, deny: new Set<string>(), counts: new Map<string, number>() }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: vi.fn(async (key: string, opts: { max: number }) => {
    if (!limiter.allow || limiter.deny.has(key)) return false;
    const n = (limiter.counts.get(key) ?? 0) + 1;
    limiter.counts.set(key, n);
    return n <= opts.max;
  }),
  getClientIp: () => '1.2.3.4',
}));
vi.mock('@/modules/accounting/services/core/mcpUploadIntentSweep', () => ({ sweepExpiredUploadsThrottled: vi.fn(async () => true) }));
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
import { sweepExpiredUploadsThrottled } from '@/modules/accounting/services/core/mcpUploadIntentSweep';
import { uploadReadLimits } from '@/lib/mcp/uploadBody';
import { newUploadToken } from '@/lib/mcp/uploadToken';
import route from '../../../pages/api/mcp/uploads/[token]';

/** A synthetic signing key: the upload-token MAC is real in these tests. */
const SIGNING_KEY = 'synthetic-upload-key-'.repeat(3);
/** Tokens the server minted (valid MAC), minted once the key is in place. */
let TOKEN = '';
let UNKNOWN = '';
beforeAll(() => {
  vi.stubEnv('JWT_SECRET', SIGNING_KEY);
  TOKEN = newUploadToken().token;
  UNKNOWN = newUploadToken().token;
});
/** 43 base64url characters that were never minted: the shape of a token, a MAC that cannot verify. */
const forged = () => randomBytes(32).toString('base64url');
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
  limiter.deny = new Set();
  limiter.counts = new Map();
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
    expect(sweepExpiredUploadsThrottled).toHaveBeenCalledTimes(1);
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
    expect((await put(PDF, { query: { token: UNKNOWN } })).statusCode).toBe(404);
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

  it('is PUT only and rate-limited per token, globally and per company (the client IP is the proxy\'s)', async () => {
    expect((await put(PDF, { method: 'POST' })).statusCode).toBe(405);
    await put(PDF);
    const keys = vi.mocked(checkRateLimit).mock.calls.map((c) => c[0]);
    expect(keys).toEqual([`mcp-upload-token:${hashUploadToken(TOKEN).slice(0, 32)}`,
      `mcp-upload-company:${COMPANY}`, 'mcp-upload:all']);
    expect(keys.some((k) => k.includes('1.2.3.4'))).toBe(false);
    limiter.allow = false;
    expect((await put(PDF)).statusCode).toBe(429);
    expect(stageUploadBytes).toHaveBeenCalledTimes(1);
  });

  it('answers a forged flood of any size 404 with no lookup and no bucket charged; a real token then succeeds', async () => {
    for (let n = 0; n < 5000; n += 1) expect((await put(PDF, { query: { token: forged() } })).statusCode).toBe(404);
    expect((await put(PDF, { query: { token: 'short' } })).statusCode).toBe(404);
    expect(findIntentByToken).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(sweepExpiredUploadsThrottled).not.toHaveBeenCalled();
    expect((await put(PDF)).statusCode).toBe(200);
    expect(stageUploadBytes).toHaveBeenCalledTimes(1);
  });

  it('answers a tampered token (one character flipped) 404 with no lookup', async () => {
    const i = 10;
    const tampered = TOKEN.slice(0, i) + (TOKEN[i] === 'A' ? 'B' : 'A') + TOKEN.slice(i + 1);
    expect((await put(PDF, { query: { token: tampered } })).statusCode).toBe(404);
    expect(findIntentByToken).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('charges a minted but unknown token (expired and deleted) to its own bucket and the miss bucket only', async () => {
    vi.mocked(findIntentByToken).mockResolvedValueOnce(null);
    expect((await put(PDF, { query: { token: UNKNOWN } })).statusCode).toBe(404);
    expect(vi.mocked(checkRateLimit).mock.calls.map((c) => c[0]))
      .toEqual([`mcp-upload-token:${hashUploadToken(UNKNOWN).slice(0, 32)}`, 'mcp-upload:miss']);
    expect(sweepExpiredUploadsThrottled).not.toHaveBeenCalled();
    limiter.deny = new Set(['mcp-upload:miss']);
    vi.mocked(findIntentByToken).mockResolvedValueOnce(null);
    expect((await put(PDF, { query: { token: UNKNOWN } })).statusCode).toBe(429);
  });

  it('a valid token still succeeds after unknown minted tokens spend the miss bucket', async () => {
    vi.mocked(findIntentByToken).mockResolvedValue(null);
    for (let n = 0; n < 700; n += 1) await put(PDF, { query: { token: newUploadToken().token } });
    vi.mocked(findIntentByToken).mockResolvedValue(intent());
    expect((await put(PDF)).statusCode).toBe(200);
  });

  it('refuses one token replayed past 20 a minute before the lookup', async () => {
    vi.mocked(findIntentByToken).mockResolvedValue(intent({ status: 'uploaded' }));
    const codes: number[] = [];
    for (let n = 0; n < 25; n += 1) codes.push((await put(PDF)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 409)).toBe(true);
    expect(codes.slice(20).every((c) => c === 429)).toBe(true);
    expect(findIntentByToken).toHaveBeenCalledTimes(20);
  });

  it('answers 404 to every token, minted or not, when the server key is missing', async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect((await put(PDF)).statusCode).toBe(404);
      expect(findIntentByToken).not.toHaveBeenCalled();
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });

  it('stops pulling the body at the first byte past the declared size (nothing drained or buffered past it)', async () => {
    let pulled = 0;
    async function* flood() { for (let n = 0; n < 1000; n += 1) { pulled += 1; yield Buffer.alloc(1024, 0x41); } }
    const r = await put(PDF, {}, Readable.from(flood()));
    expect(r.statusCode).toBe(413);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pulled).toBeLessThan(100);
    expect(stageUploadBytes).not.toHaveBeenCalled();
  });

  it('a used or expired url is 409 before any shared bucket: old tokens cannot spend the company or platform bucket', async () => {
    for (const over of [{ status: 'finalized' as const }, { status: 'uploaded' as const }, { expired: true }]) {
      vi.mocked(checkRateLimit).mockClear();
      vi.mocked(findIntentByToken).mockResolvedValueOnce(intent(over));
      expect((await put(PDF)).statusCode).toBe(409);
      const keys = vi.mocked(checkRateLimit).mock.calls.map((c) => c[0]);
      expect(keys).toEqual([`mcp-upload-token:${hashUploadToken(TOKEN).slice(0, 32)}`]);
    }
    expect(sweepExpiredUploadsThrottled).not.toHaveBeenCalled();
  });

  it('one company at its own limit is refused without spending the platform ceiling another company needs', async () => {
    limiter.deny.add(`mcp-upload-company:${COMPANY}`);
    expect((await put(PDF)).statusCode).toBe(429);
    expect(limiter.counts.get('mcp-upload:all') ?? 0).toBe(0);
    limiter.deny.clear();
    const other = '33333333-3333-3333-3333-333333333333';
    vi.mocked(findIntentByToken).mockResolvedValueOnce(intent({ companyId: other }));
    expect((await put(PDF)).statusCode).toBe(200);
  });

  it('a row a finalize holds (or a busy upload pool) is 503 + Retry-After, nothing audited; the url stays usable', async () => {
    const { UploadStageLockTimeoutError } = await vi.importActual<typeof import('@/modules/accounting/services/core/mcpUploadIntentStore')>(
      '@/modules/accounting/services/core/mcpUploadIntentStore');
    vi.mocked(stageUploadBytes).mockRejectedValueOnce(new UploadStageLockTimeoutError(new Error('55P03')));
    const r = await put(PDF);
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({ error: { details: { code: 'UPLOAD_STAGE_LOCK_TIMEOUT' } } });
    expect(logAuditOrThrow).not.toHaveBeenCalled();
    expect((await put(PDF)).statusCode).toBe(200);
  });

  it('bytes staged but the PUT audit row failed: 200 (the url would now answer 409), and the failure is logged', async () => {
    vi.mocked(logAuditOrThrow).mockRejectedValueOnce(new Error('audit insert failed'));
    const r = await put(PDF);
    expect(r.statusCode).toBe(200);
    expect(stageUploadBytes).toHaveBeenCalledTimes(1);
    expect(logs.error).toHaveBeenCalledWith('MCP upload staged but its PUT audit row failed', expect.anything(), 'mcp-uploads');
  });
});
