// tests/unit/auth/gotrue-mfa.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

describe('gotrue-mfa client', () => {
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
  function fail(status: number, body: unknown = {}) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }

  it('listFactors GETs /user and extracts totp factors', async () => {
    fetchMock.mockReturnValueOnce(okJson({
      id: 'user-uid', email: 'alice@test.co',
      factors: [
        { id: 'f1', status: 'verified', factor_type: 'totp', friendly_name: 'Phone' },
        { id: 'f2', status: 'unverified', factor_type: 'totp', friendly_name: 'iPad' },
      ],
    }));
    const { listFactors } = await import('@/lib/auth/gotrue-mfa');
    const res = await listFactors('user-tok');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gotrue.test/auth/v1/user',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer user-tok',
          apikey: 'anon-key',
        }),
      })
    );
    expect(res.totp).toHaveLength(2);
    expect(res.totp[0]!.id).toBe('f1');
    expect(res.totp[0]!.status).toBe('verified');
  });

  it('listFactors returns empty array when user has no factors', async () => {
    fetchMock.mockReturnValueOnce(okJson({ id: 'user-uid', email: 'alice@test.co' }));
    const { listFactors } = await import('@/lib/auth/gotrue-mfa');
    const res = await listFactors('user-tok');
    expect(res.totp).toEqual([]);
  });

  it('enrollTotp POSTs /factors with factor_type:totp', async () => {
    fetchMock.mockReturnValueOnce(okJson({
      id: 'new-f',
      type: 'totp',
      friendly_name: 'alice@test.co',
      totp: { qr_code: '<svg>…</svg>', secret: 'ABCDEFGH23456789ABCDEFGH23456789', uri: 'otpauth://…' },
    }));
    const { enrollTotp } = await import('@/lib/auth/gotrue-mfa');
    const res = await enrollTotp('user-tok', 'alice@test.co');
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('http://gotrue.test/auth/v1/factors');
    expect(JSON.parse(call[1].body)).toEqual({
      factor_type: 'totp',
      issuer: 'IsaFlow',
      friendly_name: 'alice@test.co',
    });
    expect(res).toEqual({ factor_id: 'new-f', qr_code: '<svg>…</svg>', secret: 'ABCDEFGH23456789ABCDEFGH23456789' });
  });

  it('challengeFactor POSTs /factors/:id/challenge and returns challenge_id', async () => {
    fetchMock.mockReturnValueOnce(okJson({ id: 'chal-1', expires_at: 123 }));
    const { challengeFactor } = await import('@/lib/auth/gotrue-mfa');
    const id = await challengeFactor('f1', 'user-tok');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://gotrue.test/auth/v1/factors/f1/challenge');
    expect(id).toBe('chal-1');
  });

  it('verifyFactor POSTs /factors/:id/verify and returns new token pair', async () => {
    fetchMock.mockReturnValueOnce(okJson({
      access_token: 'aal2-tok',
      refresh_token: 'refresh-tok',
      expires_in: 3600,
    }));
    const { verifyFactor } = await import('@/lib/auth/gotrue-mfa');
    const tok = await verifyFactor('f1', 'chal-1', '123456', 'user-tok');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://gotrue.test/auth/v1/factors/f1/verify');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ challenge_id: 'chal-1', code: '123456' });
    expect(tok.access_token).toBe('aal2-tok');
    expect(tok.refresh_token).toBe('refresh-tok');
  });

  it('unenrollFactor sends DELETE /factors/:id with user bearer', async () => {
    fetchMock.mockReturnValueOnce(okJson({ id: 'f1' }));
    const { unenrollFactor } = await import('@/lib/auth/gotrue-mfa');
    await unenrollFactor('f1', 'user-tok');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://gotrue.test/auth/v1/factors/f1');
    expect(fetchMock.mock.calls[0]![1].method).toBe('DELETE');
    expect((fetchMock.mock.calls[0]![1].headers as Record<string, string>).Authorization).toBe('Bearer user-tok');
  });

  it('adminUnenrollFactor uses service-role bearer on /admin/users/:uid/factors/:fid', async () => {
    fetchMock.mockReturnValueOnce(okJson({}));
    const { adminUnenrollFactor } = await import('@/lib/auth/gotrue-mfa');
    await adminUnenrollFactor('user-uid', 'f1');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://gotrue.test/auth/v1/admin/users/user-uid/factors/f1');
    const hdrs = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(hdrs.Authorization).toBe('Bearer service-key');
    expect(hdrs.apikey).toBe('service-key');
  });

  it('surfaces GoTrue 4xx as a typed GotrueMfaError', async () => {
    fetchMock.mockReturnValueOnce(fail(403, { msg: 'forbidden' }));
    fetchMock.mockReturnValueOnce(fail(403, { msg: 'forbidden' }));
    const { listFactors, GotrueMfaError } = await import('@/lib/auth/gotrue-mfa');
    await expect(listFactors('tok')).rejects.toBeInstanceOf(GotrueMfaError);
    await expect(listFactors('tok')).rejects.toMatchObject({ status: 403 });
  });
});
