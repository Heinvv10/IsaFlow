/**
 * withScope gate coverage — PRD-10 (MCP Phase 0, Task 0.4).
 *
 * Contract under test (see src/lib/auth/withScope.ts):
 *  - cookie session (req.scopes undefined) → gate is a no-op, handler runs
 *  - Bearer token WITH a required scope → handler runs
 *  - Bearer token WITHOUT the required scope → 403 INSUFFICIENT_SCOPE
 *  - array form passes when ANY of the required scopes is present
 *  - an EMPTY scopes array is still a Bearer request → strictly enforced
 */
import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withScope } from '@/lib/auth/withScope';

interface FakeRes {
  statusCode: number;
  body?: { success: boolean; error?: { code: string; message: string } };
}

function makeRes(): NextApiResponse & FakeRes {
  const res = {
    statusCode: 200,
    body: undefined as FakeRes['body'],
    setHeader() { return res; },
    status(c: number) { res.statusCode = c; return res; },
    json(b: FakeRes['body']) { res.body = b; return res; },
  };
  return res as unknown as NextApiResponse & FakeRes;
}

function makeReq(scopes?: string[]): NextApiRequest {
  return { scopes, headers: {}, url: '/api/test' } as unknown as NextApiRequest;
}

function makeHandler() {
  return vi.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
    res.status(200).json({ success: true } as never);
  });
}

describe('withScope', () => {
  it('cookie session (req.scopes undefined) → no-op pass-through', async () => {
    const handler = makeHandler();
    const res = makeRes();
    await withScope('write:journals')(handler)(makeReq(undefined), res);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('Bearer with the required scope → handler runs', async () => {
    const handler = makeHandler();
    const res = makeRes();
    await withScope('read:reports')(handler)(makeReq(['read:reports', 'read:invoices']), res);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('Bearer missing the required scope → 403 INSUFFICIENT_SCOPE, handler never runs', async () => {
    const handler = makeHandler();
    const res = makeRes();
    await withScope('write:journals')(handler)(makeReq(['read:reports']), res);
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.success).toBe(false);
    expect(res.body?.error?.code).toBe('INSUFFICIENT_SCOPE');
    expect(res.body?.error?.message).toContain('write:journals');
  });

  it('array form passes when ANY required scope is present', async () => {
    const handler = makeHandler();
    const res = makeRes();
    await withScope(['write:invoices', 'write:journals'])(handler)(
      makeReq(['write:journals']),
      res,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('array form rejects when NONE of the required scopes is present', async () => {
    const handler = makeHandler();
    const res = makeRes();
    await withScope(['write:invoices', 'write:journals'])(handler)(
      makeReq(['read:reports']),
      res,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.error?.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('empty scopes array is a Bearer request — strictly enforced, not a cookie no-op', async () => {
    const handler = makeHandler();
    const res = makeRes();
    await withScope('read:reports')(handler)(makeReq([]), res);
    expect(handler).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
