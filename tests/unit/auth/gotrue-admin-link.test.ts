// tests/unit/auth/gotrue-admin-link.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('gotrue-admin-link client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    process.env.GOTRUE_URL = 'http://gotrue.test/auth/v1';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  function okJson(body: unknown) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }
  function failJson(status: number, body: unknown = {}) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  it('generateLink magiclink POSTs /admin/generate_link and extracts ?token= from action_link', async () => {
    fetchMock.mockReturnValueOnce(okJson({
      id: 'u1',
      email: 'a@t.co',
      action_link: 'http://gotrue.test/auth/v1/verify?token=ABCDEF1234&type=magiclink&redirect_to=https://app.isaflow.co.za',
      hashed_token: 'ABCDEF1234',
      verification_type: 'magiclink',
    }));
    const { generateLink } = await import('@/lib/auth/gotrue-admin-link');
    const res = await generateLink('magiclink', 'a@t.co');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://gotrue.test/auth/v1/admin/generate_link');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ type: 'magiclink', email: 'a@t.co' });
    const hdrs = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(hdrs.Authorization).toBe('Bearer service-key');
    expect(hdrs.apikey).toBe('service-key');
    expect(res.action_link).toContain('token=ABCDEF1234');
    expect(res.token).toBe('ABCDEF1234');
  });

  it('generateLink recovery uses type=recovery in body', async () => {
    fetchMock.mockReturnValueOnce(okJson({
      id: 'u1',
      action_link: 'http://gotrue.test/auth/v1/verify?token=REC123&type=recovery',
      hashed_token: 'REC123',
      verification_type: 'recovery',
    }));
    const { generateLink } = await import('@/lib/auth/gotrue-admin-link');
    const res = await generateLink('recovery', 'b@t.co');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ type: 'recovery', email: 'b@t.co' });
    expect(res.token).toBe('REC123');
  });

  it('verifyMagicLink POSTs /verify with type=magiclink and token_hash only, returns token pair', async () => {
    fetchMock.mockReturnValueOnce(okJson({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      token_type: 'bearer',
    }));
    const { verifyMagicLink } = await import('@/lib/auth/gotrue-admin-link');
    const res = await verifyMagicLink('HASH123', 'c@t.co');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://gotrue.test/auth/v1/verify');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      type: 'magiclink',
      token_hash: 'HASH123',
    });
    const hdrs = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(hdrs.apikey).toBe('anon-key');
    expect(res).toEqual({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  });

  it('surfaces GoTrue 4xx as GotrueAdminLinkError with status', async () => {
    fetchMock.mockReturnValueOnce(failJson(403, { msg: 'bad' }));
    const { generateLink, GotrueAdminLinkError } = await import('@/lib/auth/gotrue-admin-link');
    await expect(generateLink('magiclink', 'x@t.co')).rejects.toBeInstanceOf(GotrueAdminLinkError);
    fetchMock.mockReturnValueOnce(failJson(403, { msg: 'bad' }));
    await expect(generateLink('magiclink', 'x@t.co')).rejects.toMatchObject({ status: 403 });
  });

  it('missing GOTRUE_URL throws at call time', async () => {
    delete process.env.GOTRUE_URL;
    const { generateLink } = await import('@/lib/auth/gotrue-admin-link');
    await expect(generateLink('magiclink', 'x@t.co')).rejects.toThrow(/GOTRUE_URL/);
  });
});
