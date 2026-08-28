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

describe('GET /api/health/deep', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@/lib/neon', () => ({
      sql: Object.assign(
        async () => [{ ok: 1 }],
        { transaction: async () => [] }
      ),
    }));
  });

  it('returns 200 ok when all deps are healthy', async () => {
    vi.doMock('@/lib/observability/deepChecks', () => ({
      checkDb: async () => ({ name: 'db', status: 'ok' as const, durationMs: 3 }),
      checkSmtp: async () => ({ name: 'smtp', status: 'ok' as const, durationMs: 12 }),
      checkPaystack: async () => ({ name: 'paystack', status: 'ok' as const, durationMs: 40 }),
    }));
    const handler = (await import('../../../pages/api/health/deep')).default;
    const { res, status, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(status()).toBe(200);
    const b = body() as any;
    expect(b.status).toBe('ok');
    expect(b.checks.db.status).toBe('ok');
    expect(b.checks.smtp.status).toBe('ok');
    expect(b.checks.paystack.status).toBe('ok');
  });

  it('returns 200 degraded when a non-DB dep fails', async () => {
    vi.doMock('@/lib/observability/deepChecks', () => ({
      checkDb: async () => ({ name: 'db', status: 'ok' as const, durationMs: 3 }),
      checkSmtp: async () => ({ name: 'smtp', status: 'down' as const, durationMs: 2000, error: 'timeout' }),
      checkPaystack: async () => ({ name: 'paystack', status: 'ok' as const, durationMs: 40 }),
    }));
    const handler = (await import('../../../pages/api/health/deep')).default;
    const { res, status, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(status()).toBe(200);
    const b = body() as any;
    expect(b.status).toBe('degraded');
    expect(b.checks.smtp.status).toBe('down');
  });

  it('returns 503 when DB itself is down', async () => {
    vi.doMock('@/lib/observability/deepChecks', () => ({
      checkDb: async () => ({ name: 'db', status: 'down' as const, durationMs: 2000, error: 'timeout' }),
      checkSmtp: async () => ({ name: 'smtp', status: 'ok' as const, durationMs: 12 }),
      checkPaystack: async () => ({ name: 'paystack', status: 'ok' as const, durationMs: 40 }),
    }));
    const handler = (await import('../../../pages/api/health/deep')).default;
    const { res, status, body } = makeRes();
    await handler(makeReq('GET'), res);
    expect(status()).toBe(503);
    const b = body() as any;
    expect(b.status).toBe('down');
    expect(b.checks.db.status).toBe('down');
  });
});
