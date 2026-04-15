import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Mock the sql export so the test doesn't need a real DB.
vi.mock('@/lib/neon', () => {
  return {
    sql: Object.assign(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) => [{ ok: 1 }],
      { transaction: async () => [] }
    ),
  };
});

function makeReq(method = 'GET'): NextApiRequest {
  return { method, url: '/api/health', headers: {}, query: {} } as unknown as NextApiRequest;
}

function makeRes(): { res: NextApiResponse; status: () => number; body: () => unknown } {
  let statusCode = 200;
  let payload: unknown;
  const res = {
    statusCode,
    status(code: number) {
      statusCode = code;
      (res as any).statusCode = code;
      return res;
    },
    json(data: unknown) {
      payload = data;
      return res;
    },
    setHeader() { return res; },
    end() { return res; },
  } as unknown as NextApiResponse;
  return { res, status: () => statusCode, body: () => payload };
}

describe('GET /api/health (shallow)', () => {
  it('returns 200 { status: "ok", db: "ok" } when DB is reachable', async () => {
    const handler = (await import('../../../pages/api/health')).default;
    const { res, status, body } = makeRes();
    await handler(makeReq(), res);
    expect(status()).toBe(200);
    const b = body() as any;
    expect(b.status).toBe('ok');
    expect(b.db).toBe('ok');
    expect(typeof b.uptimeSeconds).toBe('number');
  });

  it('returns 503 when DB query throws', async () => {
    vi.resetModules();
    vi.doMock('@/lib/neon', () => ({
      sql: Object.assign(
        async () => { throw new Error('connection refused'); },
        { transaction: async () => [] }
      ),
    }));
    const handler = (await import('../../../pages/api/health')).default;
    const { res, status, body } = makeRes();
    await handler(makeReq(), res);
    expect(status()).toBe(503);
    const b = body() as any;
    expect(b.status).toBe('down');
    expect(b.db).toBe('down');
  });

  afterEach(() => {
    vi.resetModules();
  });
});
