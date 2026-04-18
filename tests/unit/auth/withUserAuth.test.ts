// tests/unit/auth/withUserAuth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);

async function makeToken(sub: string) {
  return new SignJWT({ sub, email: 'x@y.z', aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET));
}

function mkReq(token?: string): NextApiRequest {
  return {
    headers: { cookie: token ? `sb-access-token=${token}` : '' },
  } as unknown as NextApiRequest;
}

function mkRes() {
  const headers: Record<string, unknown> = {};
  let status = 200;
  const body: { value?: unknown } = {};
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body.value = v; return this; },
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body.value; } };
}

describe('withUserAuth', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
  });

  it('401s when no cookie', async () => {
    const { withUserAuth } = await import('@/lib/auth/withUserAuth');
    const r = mkRes();
    await withUserAuth(async () => { throw new Error('should not run'); })(mkReq(), r.res);
    expect(r.status).toBe(401);
  });

  it('401s on invalid token and clears cookies', async () => {
    const { withUserAuth } = await import('@/lib/auth/withUserAuth');
    const r = mkRes();
    await withUserAuth(async () => { throw new Error('should not run'); })(mkReq('bogus'), r.res);
    expect(r.status).toBe(401);
    const sc = r.res.getHeader('set-cookie') as string[];
    expect(sc.some((c) => c.includes('sb-access-token=;'))).toBe(true);
  });

  it('attaches req.user and calls handler on valid token', async () => {
    const { withUserAuth } = await import('@/lib/auth/withUserAuth');
    const tok = await makeToken('user-uuid-1');
    const r = mkRes();
    let seenId = '';
    await withUserAuth(async (req: any) => {
      seenId = req.user.id;
      (req as any).res_ok = true;
      r.res.status(200).json({ ok: true });
    })(mkReq(tok), r.res);
    expect(seenId).toBe('user-uuid-1');
    expect(r.status).toBe(200);
  });
});
