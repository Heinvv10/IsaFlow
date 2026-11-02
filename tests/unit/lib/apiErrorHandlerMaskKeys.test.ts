/**
 * withErrorHandler's per-route options, through the request log line it writes: maskBodyKeys masks a route's own
 * common key however the client spells it, and still masks inside logBodyFields' allow-list when both are given.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const { apiLoggerInfo } = vi.hoisted(() => ({ apiLoggerInfo: vi.fn() }));

vi.mock('@sentry/nextjs', () => ({ withIsolationScope: vi.fn((cb: () => unknown) => cb()), setTag: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  apiLogger: { info: apiLoggerInfo, error: vi.fn(), warn: vi.fn() },
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/observability/requestContext', () => ({
  runWithRequestContext: vi.fn((_id: string, fn: () => unknown) => fn()),
  generateRequestId: vi.fn(() => 'req-1'),
}));
vi.mock('@/lib/observability/requestLogger', () => ({ logRequestCompleted: vi.fn() }));
vi.mock('@/lib/sentry/tags', () => ({ setTenantTags: vi.fn(), sanitizeRoute: vi.fn((r: string) => r) }));
vi.mock('@/lib/cors', () => ({ safeCorsOrigin: vi.fn(() => null) }));

import { withErrorHandler, type WithErrorHandlerOptions } from '@/lib/api-error-handler';

interface RequestLine { type?: string; body?: unknown; query?: unknown; url?: string }

async function loggedLine(options: WithErrorHandlerOptions, body: Record<string, unknown> | undefined, type = 'application/json',
  url = '/api/x', query: Record<string, string> = {}): Promise<RequestLine | undefined> {
  const req = { method: body ? 'POST' : 'GET', url, query, headers: { 'content-type': type }, body } as unknown as NextApiRequest;
  const res = { statusCode: 200, headersSent: false, setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn() };
  await withErrorHandler(async () => {}, options)(req, res as unknown as NextApiResponse);
  return apiLoggerInfo.mock.calls.map(([entry]) => entry as RequestLine).find((e) => e.type === 'request');
}
const loggedBody = async (options: WithErrorHandlerOptions, body: Record<string, unknown>, type?: string) =>
  (await loggedLine(options, body, type))?.body;

beforeEach(() => apiLoggerInfo.mockReset());

describe('maskBodyKeys', () => {
  it.each(['amount', 'Amount', 'AMOUNT', 'amount_', '-amount', 'a.mount', 'a mount'])('masks %s, at any depth, as the route named it', async (key) => {
    const out = await loggedBody({ maskBodyKeys: ['amount'] }, { [key]: 45000, note: 'n', rows: [{ [key]: 45000 }] });
    expect(out).toEqual({ [key]: '[omitted]', note: 'n', rows: [{ [key]: '[omitted]' }] });
  });

  it.each([['principal_amount'], ['Principal Amount'], ['principalAmount']])('a key the route spelt one way matches %s', async (key) => {
    expect(await loggedBody({ maskBodyKeys: ['principal-amount'] }, { [key]: 9000 })).toEqual({ [key]: '[omitted]' });
  });

  it('leaves the key on a route that did not name it', async () => {
    expect(await loggedBody({}, { amount: 45000 })).toEqual({ amount: 45000 });
  });
});

describe('maskBodyKeys with logBodyFields', () => {
  const options = { logBodyFields: ['client_id', 'amount'], maskBodyKeys: ['Amount'] };

  it.each(['application/json', 'application/x-www-form-urlencoded'])('%s: the allow-list, with the masked key masked inside it', async (type) => {
    expect(await loggedBody(options, { client_id: 'c1', amount: 45000, code: 'oac_LOGGED' }, type)).toEqual({ client_id: 'c1', amount: '[omitted]' });
  });

  it('logBodyFields alone: a key the allow-list leaves out stays out, masked or not', async () => {
    const out = await loggedBody({ logBodyFields: ['client_id'], maskBodyKeys: ['amount'] }, { client_id: 'c1', amount: 45000 });
    expect(out).toEqual({ client_id: 'c1' });
  });
});

describe('maskBodyKeys in the query string', () => {
  it.each(['amount', 'Amount', 'a_mount'])('masks %s in the logged query and url, as the route named it', async (key) => {
    const line = await loggedLine({ maskBodyKeys: ['amount'] }, undefined, 'application/json',
      `/api/x?${key}=45000&page=2`, { [key]: '45000', page: '2' });
    expect(line?.query).toEqual({ [key]: '[omitted: 5 chars]', page: '2' });
    expect(line?.url).toBe(`/api/x?${key}=[REDACTED]&page=2`);
    expect(JSON.stringify(line)).not.toContain('45000');
  });

  it('leaves them on a route that did not name the key', async () => {
    const line = await loggedLine({}, undefined, 'application/json', '/api/x?amount=45000', { amount: '45000' });
    expect([line?.query, line?.url]).toEqual([{ amount: '45000' }, '/api/x?amount=45000']);
  });
});
