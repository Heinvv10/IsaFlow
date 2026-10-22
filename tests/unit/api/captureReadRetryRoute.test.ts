/**
 * POST /api/accounting/document-capture-action { action: 'retry' } re-arms a failed or interrupted read.
 * The service decides (captureReadRetry.test.ts); this pins the route: the answer for each outcome, the AI unit it
 * charges (the upload's bucket, no refund), and that the other actions are untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ retry: vi.fn(), sql: vi.fn(), rateLimit: vi.fn(), release: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: m.rateLimit }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/modules/accounting/services/capture/captureReadRetry', () => ({ retryCaptureRead: m.retry }));
vi.mock('@/modules/accounting/services/capture/captureLifecycleGate', () => ({ releaseClaimForLifecycleAction: m.release }));

import action from '../../../pages/api/accounting/document-capture-action';
import { STILL_BEING_READ } from '@/modules/accounting/services/capture/captureReadState';

const CO = 'aaaaaaaa-0000-4000-8000-000000000001';
const ID = 'cccccccc-0000-4000-8000-000000000003';

function call(body: unknown) {
  const req = { method: 'POST', query: {}, body, headers: {}, socket: {}, companyId: CO, user: { id: 'u' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, send(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  return Promise.resolve((action as unknown as (a: NextApiRequest, b: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse))
    .then(() => ({ res, req }));
}
const reArmed = {
  id: ID, company_id: CO, file_name: 'inv.pdf', file_type: 'pdf', extracted_data: '{}', status: 'pending', created_at: new Date().toISOString(),
  read_state: 'reading', read_error: null, read_heartbeat_at: new Date().toISOString(), storage_path: `${CO}/${ID}`, posted_at: null, read_attempt: 2,
};

beforeEach(() => {
  vi.resetAllMocks();
  m.rateLimit.mockResolvedValue(true);
  m.sql.mockResolvedValue([{ id: ID }]);
  m.retry.mockResolvedValue({ ok: true, row: reArmed, attempt: 2 });
});

describe("document-capture-action 'retry'", () => {
  it('answers 200 with the re-armed document, reading and not retryable, and no storage pointer', async () => {
    const { res } = await call({ id: ID, action: 'retry' });
    expect(res.statusCode).toBe(200);
    const doc = (res.sent as { data: Record<string, unknown> }).data;
    expect(doc).toMatchObject({ id: ID, readState: 'reading', readError: null, retryable: false });
    expect(JSON.stringify(res.sent)).not.toContain('storage_path');
    expect(JSON.stringify(res.sent)).not.toContain(`${CO}/${ID}`);
    expect(m.retry).toHaveBeenCalledWith(CO, ID, expect.any(Function));
  });

  it("charges the upload's AI bucket, with no refund", async () => {
    await call({ id: ID, action: 'retry' });
    const charge = m.retry.mock.calls[0]![2] as () => Promise<boolean>;
    await charge();
    expect(m.rateLimit).toHaveBeenCalledTimes(1);
    const args = m.rateLimit.mock.calls[0]!;
    expect(args[1]).toBe(CO);
    expect(args[2]).toBe('document-capture');
    expect(args[3]).toEqual({ companyMax: 30, dailyMax: 300 });
  });

  it('409 "still being read" while a read is alive', async () => {
    m.retry.mockResolvedValue({ ok: false, reason: 'being_read' });
    const { res } = await call({ id: ID, action: 'retry' });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.sent)).toContain(STILL_BEING_READ);
  });

  it('400 when the document cannot be retried, saying to upload it again', async () => {
    m.retry.mockResolvedValue({ ok: false, reason: 'not_retryable' });
    const { res } = await call({ id: ID, action: 'retry' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('cannot be retried');
    expect(JSON.stringify(res.sent)).toContain('upload');
  });

  it('404 for a document that is not this company\'s', async () => {
    m.retry.mockResolvedValue({ ok: false, reason: 'missing' });
    expect((await call({ id: ID, action: 'retry' })).res.statusCode).toBe(404);
  });

  it('429 when too many reads are in flight, and when the AI limit is used up', async () => {
    m.retry.mockResolvedValue({ ok: false, reason: 'too_many' });
    const a = await call({ id: ID, action: 'retry' });
    expect(a.res.statusCode).toBe(429);
    expect(JSON.stringify(a.res.sent)).toContain('Too many documents are being read');
    m.retry.mockResolvedValue({ ok: false, reason: 'rate_limited' });
    const b = await call({ id: ID, action: 'retry' });
    expect(b.res.statusCode).toBe(429);
    expect(JSON.stringify(b.res.sent)).toContain('AI request limit');
  });

  it('does not take the lifecycle gate (retry is not confirm or reject)', async () => {
    await call({ id: ID, action: 'retry' });
    expect(m.release).not.toHaveBeenCalled();
  });

  it('is an allowed action; an unknown one is still a 400 that names retry', async () => {
    const { res } = await call({ id: ID, action: 'explode' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.sent)).toContain('retry');
    expect(m.retry).not.toHaveBeenCalled();
  });

  it('needs an id', async () => {
    expect((await call({ action: 'retry' })).res.statusCode).toBe(400);
    expect(m.retry).not.toHaveBeenCalled();
  });
});
