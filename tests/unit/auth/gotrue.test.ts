// tests/unit/auth/gotrue.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';

const TEST_SECRET = 'a'.repeat(40);
const ENC = new TextEncoder().encode(TEST_SECRET);

async function makeToken(claims: Record<string, unknown>, expSeconds = 3600) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${expSeconds}s`)
    .sign(ENC);
}

describe('gotrue client', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
    process.env.SUPABASE_ANON_KEY = 'anon-key-dummy';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-dummy';
  });

  it('verifyToken accepts a valid completed AAL2 session and returns claims', async () => {
    const { verifyToken } = await import('@/lib/auth/gotrue');
    const token = await makeToken({ sub: 'user-uuid', email: 'a@b.c', role: 'authenticated', aal: 'aal2' });
    const claims = await verifyToken(token);
    expect(claims.sub).toBe('user-uuid');
    expect(claims.email).toBe('a@b.c');
  });

  it('verifyToken rejects an expired token', async () => {
    const { verifyToken } = await import('@/lib/auth/gotrue');
    const token = await makeToken({ sub: 'u' }, -60);
    await expect(verifyToken(token)).rejects.toThrow();
  });

  it('verifyToken rejects a token signed by a different secret', async () => {
    const { verifyToken } = await import('@/lib/auth/gotrue');
    const otherEnc = new TextEncoder().encode('b'.repeat(40));
    const token = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(otherEnc);
    await expect(verifyToken(token)).rejects.toThrow();
  });

  it('signIn POSTs grant_type=password to /token and returns tokens', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: 'u', email: 'x@y.z' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const { signIn } = await import('@/lib/auth/gotrue');
    const r = await signIn('x@y.z', 'pw');
    expect(r.access_token).toBe('a');
    expect(r.refresh_token).toBe('r');
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toMatch(/\/token\?grant_type=password/);
    expect(JSON.parse(init.body)).toEqual({ email: 'x@y.z', password: 'pw' });
  });

  it('adminCreateUser uses service-role key and returns the created user', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'new-uuid', email: 'e@x.y' }), { status: 200 })
    );
    const { adminCreateUser } = await import('@/lib/auth/gotrue');
    const u = await adminCreateUser({ email: 'e@x.y', password: 'pw', email_confirm: true });
    expect(u.id).toBe('new-uuid');
    const [, init] = (global.fetch as any).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer service-role-dummy');
    expect(init.headers.apikey).toBe('service-role-dummy');
  });
});
