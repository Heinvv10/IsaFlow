/**
 * A share link's token is a bearer credential that travels in the URL. This
 * file asserts withErrorHandler never writes the raw token to the request
 * logger, in any of the log calls it makes (request, response, error, and
 * headers-already-sent), and redacts a `token` key found in req.query too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { apiLoggerInfo, apiLoggerError, apiLoggerWarn } = vi.hoisted(() => ({
  apiLoggerInfo: vi.fn(),
  apiLoggerError: vi.fn(),
  apiLoggerWarn: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  withIsolationScope: vi.fn((cb: () => unknown) => cb()),
  setTag: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  apiLogger: { info: apiLoggerInfo, error: apiLoggerError, warn: apiLoggerWarn },
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/observability/requestContext', () => ({
  runWithRequestContext: vi.fn((_id: string, fn: () => unknown) => fn()),
  generateRequestId: vi.fn(() => 'req-1'),
}));
vi.mock('@/lib/observability/requestLogger', () => ({ logRequestCompleted: vi.fn() }));
vi.mock('@/lib/sentry/tags', () => ({ setTenantTags: vi.fn(), sanitizeRoute: vi.fn((r: string) => r) }));
vi.mock('@/lib/cors', () => ({ safeCorsOrigin: vi.fn(() => null) }));

import { withErrorHandler } from '@/lib/api-error-handler';

const TOKEN = 'A'.repeat(43);

function makeReqRes(url: string, query: Record<string, unknown> = {}) {
  const req = { method: 'GET', url, query, headers: {} } as unknown as NextApiRequest;
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
    end: vi.fn(),
  } as unknown as NextApiResponse;
  return { req, res };
}

describe('withErrorHandler — share token redaction', () => {
  beforeEach(() => {
    apiLoggerInfo.mockReset();
    apiLoggerError.mockReset();
    apiLoggerWarn.mockReset();
  });

  it('redacts the token out of the request and response log lines', async () => {
    const { req, res } = makeReqRes(`/share/${TOKEN}?x=1`);
    const handler = withErrorHandler(async () => {});
    await handler(req, res);

    expect(apiLoggerInfo).toHaveBeenCalledTimes(2);
    for (const call of apiLoggerInfo.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).toContain('[token]');
    }
  });

  it('redacts a token key carried in req.query', async () => {
    const { req, res } = makeReqRes('/api/share', { token: TOKEN });
    const handler = withErrorHandler(async () => {});
    await handler(req, res);

    const requestCall = apiLoggerInfo.mock.calls.find((c) => c[0]?.type === 'request');
    expect(requestCall?.[0].query).toEqual({ token: '[token]' });
    expect(JSON.stringify(requestCall)).not.toContain(TOKEN);
  });

  it('redacts a share_token key too — the name only has to CONTAIN token', async () => {
    // The regression: the URL redactor matched any parameter name containing
    // `token` while this site matched a key named exactly `token`, so
    // `?share_token=<token>` was stripped from the URL string and written out
    // in full from req.query on the same log line.
    const { req, res } = makeReqRes(`/api/share?share_token=${TOKEN}`, { share_token: TOKEN });
    const handler = withErrorHandler(async () => {});
    await handler(req, res);

    const requestCall = apiLoggerInfo.mock.calls.find((c) => c[0]?.type === 'request');
    expect(requestCall?.[0].query).toEqual({ share_token: '[token]' });
    expect(JSON.stringify(requestCall)).not.toContain(TOKEN);
  });

  it('leaves a query with no token-named key untouched', async () => {
    const { req, res } = makeReqRes('/api/accounting/share/links', { type: 'board', from: '2026-08-01' });
    const handler = withErrorHandler(async () => {});
    await handler(req, res);

    const requestCall = apiLoggerInfo.mock.calls.find((c) => c[0]?.type === 'request');
    expect(requestCall?.[0].query).toEqual({ type: 'board', from: '2026-08-01' });
  });

  it('redacts the token out of the error log line', async () => {
    const { req, res } = makeReqRes(`/share/${TOKEN}`);
    const handler = withErrorHandler(async () => {
      throw new Error('boom');
    });
    await handler(req, res);

    expect(apiLoggerError).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(apiLoggerError.mock.calls[0]);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain('[token]');
  });

  it('redacts the token out of the "headers already sent" warning', async () => {
    const { req, res } = makeReqRes(`/share/${TOKEN}`);
    (res as unknown as { headersSent: boolean }).headersSent = true;
    const handler = withErrorHandler(async () => {
      throw new Error('boom');
    });
    await handler(req, res);

    expect(apiLoggerWarn).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(apiLoggerWarn.mock.calls[0]);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain('[token]');
  });
});
