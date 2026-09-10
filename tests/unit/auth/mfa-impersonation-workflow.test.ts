import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SignJWT, decodeJwt } from 'jose';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { PlatformAdminRequest } from '@/lib/auth';

const fixture = vi.hoisted(() => ({
  sql: vi.fn(), query: vi.fn(), release: vi.fn(), generateLink: vi.fn(), verifyMagicLink: vi.fn(),
  stashAdminTokens: vi.fn(), loadStash: vi.fn(), deleteStash: vi.fn(), validateImpersonationTarget: vi.fn(),
}));
vi.mock('@/lib/neon', () => ({ sql: fixture.sql }));
vi.mock('@/lib/auth/authPool', () => ({ getAuthPool: () => ({
  connect: async () => ({ query: fixture.query, release: fixture.release }),
}) }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: async () => true, withRateLimit: (handler: unknown) => handler }));
vi.mock('@/modules/admin/middleware/withAdmin', () => ({ withAdmin: (handler: unknown) => handler }));
vi.mock('@/modules/admin/services/userImpersonationService', () => ({
  stashAdminTokens: fixture.stashAdminTokens, loadStash: fixture.loadStash,
  deleteStash: fixture.deleteStash, validateImpersonationTarget: fixture.validateImpersonationTarget,
}));
vi.mock('@/lib/auth/gotrue-admin-link', () => ({
  generateLink: fixture.generateLink, verifyMagicLink: fixture.verifyMagicLink,
  GotrueAdminLinkError: class extends Error {},
}));
import start from '../../../pages/api/admin/users/[id]/impersonate';
import end from '../../../pages/api/auth/end-impersonation';
import refreshHandler from '../../../pages/api/auth/refresh';
import { withAuth } from '@/lib/auth/withAuth';

const adminId = '00000000-0000-0000-0000-000000000ad1';
const targetId = '00000000-0000-0000-0000-000000000ab1';
const companyId = '00000000-0000-0000-0000-000000000cc1';
const csrf = 'synthetic-csrf-token-at-least-thirty-two-characters';
let adminToken: string;
let targetToken: string;

function response() {
  const headers = new Map<string, unknown>();
  const state = {
    statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    json(body: unknown) { this.body = body; return this.end(); },
    end() { return this; },
  };
  return { res: state as unknown as NextApiResponse, state, headers };
}
function request(jar: Record<string, string>, method = 'POST'): NextApiRequest {
  return { method, url: '/api/accounting/impersonation-workflow', query: { id: targetId },
    headers: { cookie: Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; '),
      'x-csrf-token': csrf, 'x-admin-request': 'true' }, cookies: { ...jar, isaflow_csrf: csrf },
    user: { id: adminId, claims: decodeJwt(adminToken) },
  } as unknown as PlatformAdminRequest;
}
function applyCookies(jar: Record<string, string>, result: ReturnType<typeof response>) {
  for (const cookie of (result.headers.get('set-cookie') as string[] | undefined) ?? []) {
    const pair = cookie.split(';')[0]!;
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    if (/Max-Age=0(?:;|$)/i.test(cookie)) delete jar[name];
    else jar[name] = pair.slice(index + 1);
  }
}
async function token(sub: string, aal: string, session: string) {
  return new SignJWT({ sub, aal, session_id: session, email: `${sub}@test.local` })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

beforeEach(async () => {
  vi.stubEnv('JWT_SECRET', 'synthetic-impersonation-workflow-signing-secret-forty-characters');
  vi.stubEnv('GOTRUE_URL', 'http://gotrue.test.local');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-anon');
  vi.stubEnv('SENTRY_ENABLED', 'false');
  adminToken = await token(adminId, 'aal2', 'admin-session');
  targetToken = await token(targetId, 'aal1', 'target-magiclink-session');
  fixture.validateImpersonationTarget.mockResolvedValue({ userId: targetId, email: 'target@test.local' });
  fixture.generateLink.mockResolvedValue({ token: 'synthetic-link' });
  fixture.verifyMagicLink.mockResolvedValue({ access_token: targetToken, refresh_token: 'target-refresh', expires_in: 3600 });
  fixture.stashAdminTokens.mockResolvedValue('33333333-3333-4333-8333-333333333333');
  fixture.deleteStash.mockResolvedValue(undefined);
  fixture.loadStash.mockResolvedValue({ stash_id: '33333333-3333-4333-8333-333333333333', admin_user_id: adminId,
    target_user_id: targetId, admin_access_token: adminToken, admin_refresh_token: 'admin-refresh',
    expires_at: new Date(Date.now() + 3_600_000) });
  fixture.sql.mockImplementation(async (parts: TemplateStringsArray) =>
    parts.join('').includes('admin_impersonation_stash') ? [{ live: true, ended: false }]
      : parts.join('').includes('SELECT company_id') ? [{ company_id: companyId }]
      : parts.join('').includes('FROM users') ? [{ is_active: true, status: 'active', suspended_at: null }] : []);
  fixture.query.mockImplementation(async (sql: string) => ({ command: sql.trim().split(/\s+/)[0]!.toUpperCase(), rows: sql.includes('FROM company_users')
    ? [{ role: 'admin', account_user_id: targetId, is_active: true, status: 'active', suspended_at: null }] : [] }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: targetId,
    factors: [{ status: 'verified', factor_type: 'totp' }] })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); });

it('starts an authorized MFA-target impersonation, uses the emitted cookies on withAuth, and restores the admin', async () => {
  const jar: Record<string, string> = { 'sb-access-token': adminToken, 'sb-refresh-token': 'admin-refresh' };
  const started = response();
  await start(request(jar), started.res);
  expect(started.state.statusCode).toBe(200);
  applyCookies(jar, started);
  expect(jar['sb-access-token']).toBe(targetToken);
  const protectedHandler = vi.fn(async (req: PlatformAdminRequest, res: NextApiResponse) => {
    expect(req.user.id).toBe(targetId);
    res.status(200).json({ private: true });
  });
  const protectedResponse = response();
  await withAuth(protectedHandler)(request(jar, 'GET'), protectedResponse.res);
  expect(protectedResponse.state.statusCode).toBe(200);
  expect(protectedHandler).toHaveBeenCalledOnce();
  expect(jar['sb-impersonation-proof']).toBeTruthy();
  const proof = jar['sb-impersonation-proof']!;
  expect(decodeJwt(proof).exp).toBeLessThanOrEqual(decodeJwt(adminToken).exp!);
  const stash = await fixture.loadStash.mock.results[0]!.value;
  expect(decodeJwt(proof).exp).toBeLessThanOrEqual(Math.floor(stash.expires_at.getTime() / 1000));
  const rotatedToken = await new SignJWT({ ...decodeJwt(targetToken), rotation: 1 })
    .setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(process.env.JWT_SECRET));
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).includes('/logout')) return new Response(null, { status: 204 });
    expect(String(url)).toContain('/token?grant_type=refresh_token');
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: 'target-refresh' });
    return Response.json({ access_token: rotatedToken, refresh_token: 'rotated-refresh',
      expires_in: 3600, user: { id: targetId } });
  }));
  const refreshed = response();
  await refreshHandler(request(jar), refreshed.res);
  expect(refreshed.state.statusCode).toBe(200);
  applyCookies(jar, refreshed);
  expect(jar['sb-access-token']).toBe(rotatedToken);
  expect(jar['sb-impersonation-proof']).toBe(proof);
  const afterRefresh = response();
  await withAuth(protectedHandler)(request(jar, 'GET'), afterRefresh.res);
  expect(afterRefresh.state.statusCode).toBe(200);
  expect(protectedHandler).toHaveBeenCalledTimes(2);
  const ended = response();
  await end(request(jar), ended.res);
  expect(ended.state.statusCode).toBe(200);
  applyCookies(jar, ended);
  expect(jar['sb-access-token']).toBe(adminToken);
  expect(jar['sb-impersonation-proof']).toBeUndefined();
  expect(fixture.deleteStash).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333');
  // The impersonated GoTrue session must not outlive the impersonation: its refresh
  // token would otherwise keep working, unflagged, for as long as the member is enrolled.
  expect(calls.some(url => url.includes('/logout?scope=local'))).toBe(true);
  const restored = response();
  await withAuth(async (req: PlatformAdminRequest, res: NextApiResponse) => {
    expect(req.user.id).toBe(adminId);
    res.status(200).json({ restored: true });
  })(request(jar, 'GET'), restored.res);
  expect(restored.state.statusCode).toBe(200);
});

it('records the impersonated target session and carries the actor into the control principal', async () => {
  const jar: Record<string, string> = { 'sb-access-token': adminToken, 'sb-refresh-token': 'admin-refresh' };
  const started = response();
  await start(request(jar), started.res);
  expect(started.state.statusCode).toBe(200);
  const audit = fixture.sql.mock.calls.find(call => String((call[0] as string[]).join('')).includes('admin_audit_log'));
  const details = (audit ?? []).slice(1).find(value => typeof value === 'string' && value.startsWith('{'));
  expect(JSON.parse(String(details))).toMatchObject({ target_session_id: 'target-magiclink-session' });
  applyCookies(jar, started);
  const { als } = await import('@/lib/als');
  const seen = response();
  await withAuth(async (_req: PlatformAdminRequest, res: NextApiResponse) => {
    expect(als.getStore()?.controlPrincipal?.impersonatorPersonId).toBe(adminId);
    res.status(200).json({ ok: true });
  })(request(jar, 'GET'), seen.res);
  expect(seen.state.statusCode).toBe(200);
});

it('denies a pending MFA token copied into the access cookie without delegation proof', async () => {
  const handler = vi.fn();
  const result = response();
  await withAuth(handler)(request({ 'sb-access-token': targetToken, active_company_id: companyId }, 'GET'), result.res);
  expect(result.state.statusCode).toBe(401);
  expect(handler).not.toHaveBeenCalled();
  expect(fixture.query).not.toHaveBeenCalled();
});

it.each(['stash', 'audit'])('does not emit delegation or target cookies when %s persistence fails', async (failure) => {
  if (failure === 'stash') fixture.stashAdminTokens.mockRejectedValue(new Error('stash unavailable'));
  else fixture.sql.mockRejectedValue(new Error('audit unavailable'));
  const result = response();
  await expect(start(request({ 'sb-access-token': adminToken, 'sb-refresh-token': 'admin-refresh' }), result.res))
    .rejects.toThrow(`${failure} unavailable`);
  expect(result.headers.get('set-cookie')).toBeUndefined();
  if (failure === 'audit') expect(fixture.deleteStash).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333');
});


it.each(['session', 'user'])('rejects emitted delegation replayed with a different %s', async (mismatch) => {
  const jar: Record<string, string> = { 'sb-access-token': adminToken, 'sb-refresh-token': 'admin-refresh' };
  const started = response();
  await start(request(jar), started.res);
  expect(started.state.statusCode).toBe(200);
  applyCookies(jar, started);
  const replayUser = mismatch === 'user' ? '00000000-0000-0000-0000-000000000ab2' : targetId;
  jar['sb-access-token'] = await token(replayUser, 'aal1', mismatch === 'session' ? 'other-session' : 'target-magiclink-session');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: replayUser,
    factors: [{ status: 'verified', factor_type: 'totp' }] })));
  const handler = vi.fn();
  const result = response();
  await withAuth(handler)(request(jar, 'GET'), result.res);
  expect(result.state.statusCode).toBe(401);
  expect(handler).not.toHaveBeenCalled();
  expect(fixture.query).not.toHaveBeenCalled();
});

it('refuses issuance when the provider target token has no session_id', async () => {
  const invalidToken = await new SignJWT({ sub: targetId, aal: 'aal1' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  fixture.verifyMagicLink.mockResolvedValue({ access_token: invalidToken, refresh_token: 'target-refresh', expires_in: 3600 });
  const result = response();
  await expect(start(request({ 'sb-access-token': adminToken, 'sb-refresh-token': 'admin-refresh' }), result.res))
    .rejects.toThrow();
  expect(result.headers.get('set-cookie')).toBeUndefined();
  expect(fixture.deleteStash).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333');
});
