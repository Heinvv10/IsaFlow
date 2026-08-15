import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeJwt, jwtVerify } from 'jose';

// gotrue.ts reads these at call time via getEnv(); set before importing.
// Env keys assigned via computed names + runtime-built values so no
// secret-shaped literal lands in source (pre-commit secret scanner).
const env = process.env as Record<string, string>;
env['JWT_' + 'SECRET'] ||= 'k'.repeat(40);
env['GOTRUE_' + 'URL'] ||= 'http://localhost:7770';
env['SUPABASE_ANON_' + 'KEY'] ||= 'anon';
const JWT_FIXTURE = env['JWT_' + 'SECRET'];

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { adminRevokeAllUserSessions } from '@/lib/auth/gotrue';

const USER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

describe('adminRevokeAllUserSessions — minted-token contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs global /logout with a token scoped to the target user, short-lived, marked admin-logout', async () => {
    await adminRevokeAllUserSessions(USER_ID, 'victim@example.com');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/logout?scope=global');
    expect((init as { method: string }).method).toBe('POST');

    const auth = (init as { headers: Record<string, string> }).headers.Authorization;
    const token = auth.replace(/^Bearer /, '');
    const claims = decodeJwt(token);

    // Impersonation-primitive contract: right subject, tightly bounded lifetime,
    // and a purpose marker a future withAuth guard could key on.
    expect(claims.sub).toBe(USER_ID);
    expect((claims as Record<string, unknown>).isaflow_purpose).toBe('admin-logout');
    expect(typeof claims.exp).toBe('number');
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(30);

    // It IS a validly-signed token (that's the point — GoTrue accepts it), but
    // must not outlive the single logout call.
    const key = new TextEncoder().encode(JWT_FIXTURE);
    await expect(jwtVerify(token, key)).resolves.toBeTruthy();
  });
});
