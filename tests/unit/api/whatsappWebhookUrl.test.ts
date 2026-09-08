/**
 * Audit P2 carry-over: Twilio signature verification rebuilt the webhook URL
 * from NEXT_PUBLIC_APP_URL ?? ''. With the env var unset, every legitimate
 * webhook 403'd as "invalid signature" (terminal for Twilio — message lost)
 * instead of failing closed as a configuration error. A missing base URL must
 * 503 like the missing-token branch (Twilio retries 5xx).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
const validateRequest = vi.fn(() => false);
vi.mock('twilio', () => ({ validateRequest: (...a: unknown[]) => validateRequest(...a) }));
const ingestTwilioPayload = vi.fn(async () => ({ rejected: 'unknown_sender' }));
vi.mock('@/modules/accounting/services/capture/whatsAppInboundService', () => ({
  ingestTwilioPayload: (...a: unknown[]) => ingestTwilioPayload(...a),
}));
vi.mock('@/modules/accounting/services/capture/whatsAppReplyService', () => ({
  sendWhatsAppMessage: vi.fn(async () => undefined),
}));

vi.mock('@/modules/accounting/services/capture/whatsAppVerificationService', () => ({
  verifyWhatsAppDestination: vi.fn(async () => ({companyId: 'company-1', inboxId: 'inbox-1', tokenHash: 'fixture-proof'})),
}));

import handler from '../../../pages/api/accounting/capture/inbound/whatsapp';

function mockReqRes() {
  const req = {
    method: 'POST',
    headers: { 'x-twilio-signature': 'sig' },
    body: { From: 'whatsapp:+27820000000', To: 'whatsapp:+27820000001', Body: '', NumMedia: '0', WaId: '27820000000' },
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return { req, res: res as unknown as NextApiResponse & { statusCode: number; body: { error?: string } } };
}

const ENV_KEYS = ['TWILIO_AUTH_TOKEN', 'APP_URL', 'NEXT_PUBLIC_APP_URL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('whatsapp inbound webhook URL configuration', () => {
  it('503s (fail closed, Twilio retries) when no app URL is configured', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);
    expect(res.statusCode).toBe(503);
    expect(validateRequest).not.toHaveBeenCalled();
  });

  it('verifies against NEXT_PUBLIC_APP_URL when configured and 403s a bad signature', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.isaflow.co.za';
    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);
    expect(res.statusCode).toBe(403);
    expect(validateRequest).toHaveBeenCalledWith(
      'tok', 'sig', 'https://app.isaflow.co.za/api/accounting/capture/inbound/whatsapp', expect.anything(),
    );
  });

  it('prefers the server-side APP_URL over the build-time public var', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.APP_URL = 'https://internal.isaflow.co.za';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.isaflow.co.za';
    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);
    expect(validateRequest).toHaveBeenCalledWith(
      'tok', 'sig', 'https://internal.isaflow.co.za/api/accounting/capture/inbound/whatsapp', expect.anything(),
    );
  });

  it('still 200s a valid signature end-to-end', async () => {
    validateRequest.mockReturnValueOnce(true);
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.isaflow.co.za';
    const { req, res } = mockReqRes();
    await (handler as (rq: NextApiRequest, rs: NextApiResponse) => Promise<unknown>)(req, res);
    expect(res.statusCode).toBe(200);
  });
});
