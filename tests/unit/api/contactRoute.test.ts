import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/emailService', () => ({ sendEmail: m.sendEmail }));
vi.mock('@/lib/rateLimit', () => ({
  checkRateLimit: (...args: unknown[]) => m.checkRateLimit(...args),
  getClientIp: () => '127.0.0.1',
  withRateLimit: (handler: unknown) => handler,
}));

import contactHandler from '@/../pages/api/contact';

function request(): NextApiRequest {
  return {
    method: 'POST',
    body: {
      name: 'Jo',
      email: 'jo@example.co.za',
      phone: '+27 82 555 0101',
      message: 'Please call me back.',
    },
    headers: {},
    socket: {},
  } as unknown as NextApiRequest;
}

function response() {
  const state: { statusCode: number; body?: unknown } = { statusCode: 0 };
  const res = {
    status(code: number) { state.statusCode = code; return res; },
    json(body: unknown) { state.body = body; return res; },
    setHeader() { return res; },
  } as unknown as NextApiResponse;
  return { res, state };
}

beforeEach(() => {
  m.sendEmail.mockReset().mockResolvedValue({ success: true });
  m.checkRateLimit.mockReset().mockResolvedValue(true);
});

describe('contact API', () => {
  it('sets Reply-To to the validated submitter email', async () => {
    const { res, state } = response();
    await contactHandler(request(), res);

    expect(state.statusCode).toBe(200);
    expect(m.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      replyTo: 'jo@example.co.za',
    }));
  });

  it('returns 429 with a user-visible message when the email limit is spent', async () => {
    m.checkRateLimit.mockResolvedValue(false);
    const { res, state } = response();
    await contactHandler(request(), res);

    expect(state.statusCode).toBe(429);
    expect(state.body).toMatchObject({
      success: false,
      error: { message: 'Too many enquiries from this email address. Please try again later.' },
    });
    expect(m.sendEmail).not.toHaveBeenCalled();
  });
});
