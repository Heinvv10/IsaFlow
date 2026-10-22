/**
 * An upload that is still being read has no extraction yet. Every route that acts on a locked captured document
 * refuses it with 409 "This document is still being read." while a job is reading it, and proceeds once the read
 * went stale (no sign of life for 5 minutes: shown as interrupted) or finished. Reject stays allowed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({
  lockDoc: vi.fn(),
  lockEvents: vi.fn(),
  releaseClaim: vi.fn(),
  attachBank: vi.fn(),
  claim: vi.fn(),
  sql: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: m.rateLimit }));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/capture/captureRowLock', async (orig) => ({
  ...(await orig<object>()), lockCapturedDocumentForUpdate: m.lockDoc, lockPostableCaptureEventIds: m.lockEvents,
}));
vi.mock('@/modules/accounting/services/capture/captureLifecycleGate', () => ({ releaseClaimForLifecycleAction: m.releaseClaim }));
vi.mock('@/modules/accounting/services/capture/captureBankTxAttachService', () => ({ attachCapturedDocToBankTx: m.attachBank }));

import pipeline from '../../../pages/api/accounting/ai-invoice-pipeline';
import receipt from '../../../pages/api/accounting/receipt-to-journal';
import action from '../../../pages/api/accounting/document-capture-action';
import { STILL_BEING_READ } from '@/modules/accounting/services/capture/captureReadState';

const ID = '66666666-6666-4666-8666-666666666666';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;
function call(handler: Handler, body: unknown) {
  const req = { method: 'POST', query: {}, body, headers: {}, socket: {}, companyId: 'c', user: { id: 'u' } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown,
    setHeader() { return this; },
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, send(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
const reading = (over: Record<string, unknown> = {}) => ({
  status: 'pending', posted_at: null, extracted_data: {}, read_state: 'reading', read_heartbeat_at: null, created_at: minutesAgo(1), ...over,
});
const stale = () => reading({ created_at: minutesAgo(30) });
const is409 = (r: { statusCode: number; sent: unknown }) => {
  expect(r.statusCode, JSON.stringify(r.sent)).toBe(409);
  expect(JSON.stringify(r.sent)).toContain(STILL_BEING_READ);
};

beforeEach(() => {
  vi.resetAllMocks();
  m.rateLimit.mockResolvedValue(true);
  m.lockEvents.mockResolvedValue([]);
  m.sql.mockResolvedValue([]);
});

describe('ai-invoice-pipeline', () => {
  it('409s a document being read', async () => {
    m.lockDoc.mockResolvedValue(reading());
    is409(await call(pipeline, { documentId: ID }));
  });
  it('goes on past a stale read (here to the "no extracted data" check it reaches next)', async () => {
    m.lockDoc.mockResolvedValue({ ...stale(), extracted_data: null });
    const r = await call(pipeline, { documentId: ID });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.sent)).toContain('no extracted data');
  });
});

describe('receipt-to-journal', () => {
  it('409s a document being read', async () => {
    m.lockDoc.mockResolvedValue(reading());
    is409(await call(receipt, { documentId: ID }));
  });
  it('goes on past a stale read', async () => {
    m.lockDoc.mockResolvedValue({ ...stale(), extracted_data: null });
    const r = await call(receipt, { documentId: ID });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.sent)).toContain('no extracted data');
  });
});

describe('document-capture-action', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: ID, file_name: 'a.pdf', file_type: 'pdf', status: 'pending', created_at: minutesAgo(1).toISOString(),
    read_state: 'reading', read_heartbeat_at: null, read_error: null, extracted_data: '{}', ...over,
  });
  beforeEach(() => { m.sql.mockResolvedValue([row()]); });

  it('confirm: 409 when the gate says the document is being read, and writes nothing', async () => {
    m.releaseClaim.mockResolvedValue('reading');
    is409(await call(action, { id: ID, action: 'confirm' }));
    expect(m.releaseClaim).toHaveBeenCalledWith('c', ID, 'confirm');
    expect(m.sql.mock.calls.some((c) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE'))).toBe(false);
  });
  it('confirm: proceeds when the gate lets it through (read finished or stale)', async () => {
    m.releaseClaim.mockResolvedValue('ok');
    const r = await call(action, { id: ID, action: 'confirm' });
    expect(r.statusCode).toBe(200);
  });

  it('match_bank_tx: 409 while the document is being read, nothing attached', async () => {
    is409(await call(action, { id: ID, action: 'match_bank_tx', data: { bankTxId: ID } }));
    expect(m.attachBank).not.toHaveBeenCalled();
  });
  it('match_bank_tx: proceeds when the read is stale or done', async () => {
    m.attachBank.mockResolvedValue({ ok: true, mirrored: false });
    m.sql.mockResolvedValue([row({ created_at: minutesAgo(30).toISOString() })]);
    expect((await call(action, { id: ID, action: 'match_bank_tx', data: { bankTxId: ID } })).statusCode).toBe(200);
    m.sql.mockResolvedValue([row({ read_state: 'done' })]);
    expect((await call(action, { id: ID, action: 'match_bank_tx', data: { bankTxId: ID } })).statusCode).toBe(200);
    expect(m.attachBank).toHaveBeenCalledTimes(2);
  });

  it('reject: allowed while the document is being read (the gate is asked for the reject action)', async () => {
    m.releaseClaim.mockResolvedValue('ok');
    const r = await call(action, { id: ID, action: 'reject' });
    expect(r.statusCode).toBe(200);
    expect(m.releaseClaim).toHaveBeenCalledWith('c', ID, 'reject');
  });
});
