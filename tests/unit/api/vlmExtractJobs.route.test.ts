/**
 * POST /api/accounting/vlm-extract registers a job, queues the read after COMMIT and answers 202 { jobId };
 * GET ?job= returns the outcome only to the company AND user that started it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest } from 'next';

const m = vi.hoisted(() => ({
  runAfterCommit: vi.fn(),
  rateLimit: vi.fn(),
  parse: vi.fn(),
  bufferOf: vi.fn(),
  readDoc: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: m.runAfterCommit }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: m.rateLimit }));
vi.mock('@/modules/accounting/services/capture/captureUploadForm', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/capture/captureUploadForm')>()),
  parseUploadForm: m.parse,
  uploadedBuffer: m.bufferOf,
  readUploadedDocument: m.readDoc,
}));

import handler from '../../../pages/api/accounting/vlm-extract';
import { VLM_JOBS_KEY } from '@/modules/accounting/services/bank/vlmExtractJobs';

const CO = 'aaaaaaaa-0000-4000-8000-000000000001';
const CO2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const PDF = Buffer.from('%PDF-1.4\n%test');
const extracted = { vendorName: 'Acme', totalAmount: 115 };

function respond() {
  return {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; },
  };
}
async function call(method: string, who: { companyId: string; userId: string }, query: Record<string, string> = {}) {
  const req = { method, query, headers: {}, companyId: who.companyId, user: { id: who.userId } } as unknown as NextApiRequest;
  const res = respond();
  await (handler as unknown as (a: NextApiRequest, b: unknown) => Promise<void>)(req, res);
  return res;
}
const data = (res: { sent: unknown }) => (res.sent as { data: Record<string, unknown> }).data;
const A = { companyId: CO, userId: 'user-a' };

beforeEach(() => {
  vi.resetAllMocks();
  delete (globalThis as Record<string, unknown>)[VLM_JOBS_KEY];
  m.rateLimit.mockResolvedValue(true);
  m.parse.mockResolvedValue({ files: { file: { originalFilename: 'x.pdf', mimetype: 'application/pdf', size: PDF.length } } });
  m.bufferOf.mockReturnValue(PDF);
  m.readDoc.mockResolvedValue(extracted);
});

describe('POST /api/accounting/vlm-extract', () => {
  it('answers 202 { jobId } and queues the read after COMMIT instead of running it inline', async () => {
    const res = await call('POST', A);
    expect(res.statusCode).toBe(202);
    expect(data(res)).toEqual({ jobId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(m.runAfterCommit).toHaveBeenCalledTimes(1);
    expect(m.runAfterCommit.mock.calls[0]![0]).toBe('vlm-extract');
    expect(m.readDoc).not.toHaveBeenCalled();
  });

  it('charges the AI rate limit without a refund and answers 429 when used up', async () => {
    const ok = await call('POST', A);
    expect(ok.statusCode).toBe(202);
    expect(m.rateLimit.mock.calls[0]![3]).toEqual({ companyMax: 30, dailyMax: 300 });
    m.rateLimit.mockResolvedValue(false);
    expect((await call('POST', A)).statusCode).toBe(429);
  });

  it('answers 429 for a 4th unfinished scan of the same company', async () => {
    for (let i = 0; i < 3; i++) expect((await call('POST', A)).statusCode).toBe(202);
    expect((await call('POST', A)).statusCode).toBe(429);
    expect((await call('POST', { companyId: CO2, userId: 'user-b' })).statusCode).toBe(202);
  });

  it('runs the queued read, and the poll then returns it', async () => {
    const { jobId } = data(await call('POST', A)) as { jobId: string };
    expect(data(await call('GET', A, { job: jobId }))).toEqual({ state: 'reading' });
    await (m.runAfterCommit.mock.calls[0]![1] as () => Promise<void>)();
    expect(m.readDoc).toHaveBeenCalledWith(PDF, 'application/pdf');
    expect(data(await call('GET', A, { job: jobId }))).toEqual({ state: 'done', extracted });
  });

  it('reports a failed read to the poll with a generic error', async () => {
    m.readDoc.mockRejectedValue(new Error('vllm down at 127.0.0.1'));
    const { jobId } = data(await call('POST', A)) as { jobId: string };
    await (m.runAfterCommit.mock.calls[0]![1] as () => Promise<void>)();
    const res = await call('GET', A, { job: jobId });
    expect(data(res)).toEqual({ state: 'failed', error: 'The scan failed — try again.' });
    expect(JSON.stringify(res.sent)).not.toContain('127.0.0.1');
  });

  it('does not charge the rate limit for a request that fails validation', async () => {
    m.parse.mockResolvedValue({ files: {} });
    expect((await call('POST', A)).statusCode).toBe(400);
    m.parse.mockResolvedValue({ files: { file: { originalFilename: 'x.txt', mimetype: 'text/plain', size: 3 } } });
    expect((await call('POST', A)).statusCode).toBe(400);
    m.parse.mockResolvedValue({ files: { file: { originalFilename: 'x.pdf', mimetype: 'application/pdf', size: 3 } } });
    m.bufferOf.mockReturnValue(Buffer.from('PK\u0003\u0004 not a pdf'));
    expect((await call('POST', A)).statusCode).toBe(400);
    expect(m.rateLimit).not.toHaveBeenCalled();
  });

  it('registers no job for a file that fails validation', async () => {
    m.bufferOf.mockReturnValue(Buffer.from('PK\u0003\u0004 not a pdf'));
    expect((await call('POST', A)).statusCode).toBe(400);
    expect(m.runAfterCommit).not.toHaveBeenCalled();
    m.parse.mockResolvedValue({ files: {} });
    expect((await call('POST', A)).statusCode).toBe(400);
  });
});

describe('GET /api/accounting/vlm-extract?job=', () => {
  it("404s another company's job and another user's job in the same company", async () => {
    const { jobId } = data(await call('POST', A)) as { jobId: string };
    expect((await call('GET', { companyId: CO2, userId: 'user-a' }, { job: jobId })).statusCode).toBe(404);
    expect((await call('GET', { companyId: CO, userId: 'user-other' }, { job: jobId })).statusCode).toBe(404);
    expect((await call('GET', A, { job: jobId })).statusCode).toBe(200);
  });

  it('404s an unknown job and 400s a job that is not a UUID or is missing', async () => {
    expect((await call('GET', A, { job: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    expect((await call('GET', A, { job: 'nope' })).statusCode).toBe(400);
    expect((await call('GET', A)).statusCode).toBe(400);
  });

  it('405s other methods', async () => {
    expect((await call('DELETE', A)).statusCode).toBe(405);
  });
});
