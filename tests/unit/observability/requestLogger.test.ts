import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { logRequestCompleted } from '@/lib/observability/requestLogger';
import { runWithRequestContext } from '@/lib/observability/requestContext';

function makeReq(overrides: Partial<NextApiRequest> = {}): NextApiRequest {
  return {
    method: 'POST',
    url: '/api/accounting/foo',
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes(statusCode: number): NextApiResponse {
  return { statusCode } as unknown as NextApiResponse;
}

describe('logRequestCompleted', () => {
  let lines: string[];
  let originalWrite: typeof process.stdout.write;
  let originalErr: typeof process.stderr.write;

  beforeEach(() => {
    lines = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    originalErr = process.stderr.write.bind(process.stderr);
    (process.stdout as any).write = (chunk: any) => {
      lines.push(String(chunk));
      return true;
    };
    (process.stderr as any).write = (chunk: any) => {
      lines.push(String(chunk));
      return true;
    };
  });

  afterEach(() => {
    (process.stdout as any).write = originalWrite;
    (process.stderr as any).write = originalErr;
  });

  it('emits a request_completed line with the standard shape', async () => {
    await runWithRequestContext('rid-A', async () => {
      logRequestCompleted({
        req: makeReq(),
        res: makeRes(200),
        startMs: Date.now() - 47,
        userId: 'u-1',
        companyId: 'c-1',
      });
    });

    const parsed = lines.map((l) => JSON.parse(l.trim()));
    const entry = parsed.find((p) => p.data?.event === 'request_completed');
    expect(entry).toBeDefined();
    expect(entry.requestId).toBe('rid-A');
    expect(entry.data).toMatchObject({
      event: 'request_completed',
      route: '/api/accounting/foo',
      method: 'POST',
      status: 200,
      userId: 'u-1',
      companyId: 'c-1',
      outcome: 'ok',
    });
    expect(typeof entry.data.durationMs).toBe('number');
    expect(entry.data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('maps 4xx to client_error', async () => {
    await runWithRequestContext('rid-B', async () => {
      logRequestCompleted({ req: makeReq(), res: makeRes(404), startMs: Date.now() });
    });
    const entry = lines.map((l) => JSON.parse(l.trim())).find((p) => p.data?.event === 'request_completed');
    expect(entry.data.outcome).toBe('client_error');
  });

  it('maps 5xx to server_error', async () => {
    await runWithRequestContext('rid-C', async () => {
      logRequestCompleted({ req: makeReq(), res: makeRes(500), startMs: Date.now() });
    });
    const entry = lines.map((l) => JSON.parse(l.trim())).find((p) => p.data?.event === 'request_completed');
    expect(entry.data.outcome).toBe('server_error');
  });

  it('strips querystring from the route', async () => {
    await runWithRequestContext('rid-D', async () => {
      logRequestCompleted({
        req: makeReq({ url: '/api/accounting/foo?x=1&y=2' }),
        res: makeRes(200),
        startMs: Date.now(),
      });
    });
    const entry = lines.map((l) => JSON.parse(l.trim())).find((p) => p.data?.event === 'request_completed');
    expect(entry.data.route).toBe('/api/accounting/foo');
  });

  it('handles missing userId / companyId as null', async () => {
    await runWithRequestContext('rid-E', async () => {
      logRequestCompleted({ req: makeReq(), res: makeRes(200), startMs: Date.now() });
    });
    const entry = lines.map((l) => JSON.parse(l.trim())).find((p) => p.data?.event === 'request_completed');
    expect(entry.data.userId).toBeNull();
    expect(entry.data.companyId).toBeNull();
  });

  it('redacts a share token out of the logged route', async () => {
    const token = 'A'.repeat(43);
    await runWithRequestContext('rid-F', async () => {
      logRequestCompleted({
        req: makeReq({ url: `/share/${token}?x=1` }),
        res: makeRes(200),
        startMs: Date.now(),
      });
    });
    const entry = lines.map((l) => JSON.parse(l.trim())).find((p) => p.data?.event === 'request_completed');
    expect(entry.data.route).toBe('/share/[token]');
    expect(JSON.stringify(entry)).not.toContain(token);
  });
});
