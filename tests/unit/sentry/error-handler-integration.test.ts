import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...a: unknown[]) => captureException(...a),
  setTag: vi.fn(),
  setUser: vi.fn(),
  withIsolationScope: (fn: () => unknown) => fn(),
}));

import { withErrorHandler } from '@/lib/api-error-handler';

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    headersSent: false,
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status(code: number) { this.statusCode = code; return this; },
    json: vi.fn(),
    end: vi.fn(),
  } as unknown as NextApiResponse & { headers: Record<string, string> };
}

describe('withErrorHandler + Sentry', () => {
  it('sets X-Request-Id header on every request', async () => {
    const res = makeRes() as NextApiResponse & { headers: Record<string, string> };
    const handler = withErrorHandler(async () => {});
    await handler({ method: 'GET', url: '/api/x', headers: {} } as unknown as NextApiRequest, res);
    // generateRequestId() returns a ULID (26 uppercase alphanumeric chars), not a UUID.
    expect(res.headers['X-Request-Id']).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('calls Sentry.captureException when SENTRY_ENABLED=true and handler throws', async () => {
    process.env.SENTRY_ENABLED = 'true';
    captureException.mockReset();
    const res = makeRes();
    const handler = withErrorHandler(async () => { throw new Error('boom'); });
    await handler({ method: 'GET', url: '/api/x', headers: {} } as unknown as NextApiRequest, res);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]![0]).toBeInstanceOf(Error);
    process.env.SENTRY_ENABLED = 'false';
  });

  it('does NOT call Sentry.captureException when SENTRY_ENABLED=false', async () => {
    process.env.SENTRY_ENABLED = 'false';
    captureException.mockReset();
    const res = makeRes();
    const handler = withErrorHandler(async () => { throw new Error('boom'); });
    await handler({ method: 'GET', url: '/api/x', headers: {} } as unknown as NextApiRequest, res);
    expect(captureException).not.toHaveBeenCalled();
  });
});
