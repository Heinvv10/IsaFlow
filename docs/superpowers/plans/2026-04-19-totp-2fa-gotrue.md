# TOTP 2FA via GoTrue Native MFA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace IsaFlow's custom 673-LOC TOTP implementation (currently with zero enrolled users) with GoTrue's native MFA `/factors/*` API. Drop trusted-devices, backup codes, and SMS method. Keep every-login TOTP prompt. Drop the `user_2fa` + `user_trusted_devices` tables.

**Architecture:** IsaFlow becomes a thin proxy to GoTrue's MFA endpoints. Login endpoint checks `listFactors` after password grant and, if any verified factor exists, returns `{requires_2fa: true, factor_id, pending_token}` instead of setting the `sb-access-token` cookie. Client completes challenge via `/api/auth/2fa-challenge`. Super admin can reset factors via a new admin endpoint using the service-role key.

**Tech Stack:** Next.js 14 Pages Router, TypeScript, GoTrue v2.186.0, Vitest (unit + integration), bun. Keep `otpauth` as devDependency for integration-test code generation. Remove `otpauth` and `qrcode` from runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-19-totp-2fa-gotrue-design.md`

---

## File Structure

**New:**

| Path | Purpose |
|---|---|
| `src/lib/auth/gotrue-mfa.ts` | HTTP client for GoTrue `/factors/*` + `/admin/factors/*` |
| `tests/unit/auth/gotrue-mfa.test.ts` | Mocked-fetch unit tests for the client |
| `pages/api/auth/2fa-enroll.ts` | `POST` — returns `{factor_id, qr_code, secret}` |
| `pages/api/auth/2fa-confirm.ts` | `POST {factor_id, code}` — verifies the new factor |
| `pages/api/auth/2fa-challenge.ts` | `POST {factor_id, code, pending_token}` — login-gate |
| `pages/api/admin/users/[id]/reset-2fa.ts` | Super-admin unenroll |
| `tests/integration/2fa-enroll-flow.int.test.ts` | End-to-end enroll against dev GoTrue |
| `tests/integration/2fa-login-gate.int.test.ts` | Confirms `requires_2fa: true` path |
| `tests/integration/2fa-disable-flow.int.test.ts` | Enroll → disable → single-step login |
| `tests/integration/admin-reset-2fa.int.test.ts` | Super-admin reset |
| `scripts/migrations/sql/354_drop_custom_2fa.sql` | Drop `user_2fa` + `user_trusted_devices` |

**Modified:**

| Path | Change |
|---|---|
| `pages/api/auth/login.ts` | Add MFA gate after `signIn` |
| `pages/api/auth/2fa-disable.ts` | Rewrite to call GoTrue challenge + verify + DELETE |
| `pages/api/auth/2fa-status.ts` | Trim to 15 LOC — calls `listFactors` |
| `src/components/accounting/my-account/TwoFactorSection.tsx` | Rewrite — strip trusted-devices, backup codes, SMS; keep enroll + confirm + disable |
| `pages/login.tsx` | Handle `requires_2fa` response path |
| `package.json` | Move `otpauth` to devDependencies, remove `qrcode` |

**Deleted:**

| Path | Reason |
|---|---|
| `src/modules/auth/services/twoFactorService.ts` | All TOTP logic now in GoTrue |
| `pages/api/auth/2fa-setup.ts` | Replaced by `2fa-enroll.ts` |
| `pages/api/auth/2fa-verify-setup.ts` | Replaced by `2fa-confirm.ts` |
| `pages/api/auth/2fa-verify.ts` | Replaced by `2fa-challenge.ts` |
| `pages/api/auth/2fa-trusted-devices.ts` | Feature dropped |

---

## Task 1: Verify GoTrue MFA is enabled on velo

**Prerequisite** — no code change. Blocks everything else.

**Files:** None.

- [ ] **Step 1: Check current GoTrue env on velo**

Run:
```bash
ssh velo@100.96.203.105 'grep -iE "^GOTRUE_MFA_|^MFA_TOTP_" /home/velo/supabase/.env 2>/dev/null'
```

Expected: either no output (defaults — MFA enabled by default in v2.186.0) OR explicit `=false`/`=true` values.

- [ ] **Step 2: Smoke-test `/factors` endpoint**

Run (using the dev GoTrue service-role):
```bash
set -a; source /home/hein/Workspace/IsaFlow/.env.local 2>/dev/null; set +a
TOK=$(curl -s -X POST "$GOTRUE_URL/token?grant_type=password" \
  -H "Content-Type: application/json" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -d '{"email":"admin@isaflow.co.za","password":"<known-dev-pw>"}' | grep -oE '"access_token":"[^"]+' | cut -d'"' -f4)
curl -s -X GET "$GOTRUE_URL/factors" -H "Authorization: Bearer $TOK" -H "apikey: $SUPABASE_ANON_KEY"
```

Expected: JSON response `{"totp":[],"phone":[]}` (may be empty). If response is 404 `{"error":"not found"}`, MFA is disabled — STOP and set `GOTRUE_MFA_ENABLED=true` in `/home/velo/supabase/.env`, then `cd /home/velo/supabase && docker compose restart auth` and retry.

- [ ] **Step 3: No commit**

Verification only.

---

## Task 2: `gotrue-mfa.ts` HTTP client (TDD)

**Files:**
- Create: `src/lib/auth/gotrue-mfa.ts`
- Create: `tests/unit/auth/gotrue-mfa.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/auth/gotrue-mfa.test.ts`:

```ts
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
    fetchMock.mockReturnValueOnce(okJson({ id: 'user-uid', email: 'alice@test.co' })); // no factors key
    const { listFactors } = await import('@/lib/auth/gotrue-mfa');
    const res = await listFactors('user-tok');
    expect(res.totp).toEqual([]);
  });

  it('enrollTotp POSTs /factors with factor_type:totp', async () => {
    fetchMock.mockReturnValueOnce(okJson({ id: 'new-f', totp: { qr_code: 'data:img/...', secret: 'ABC', uri: 'otpauth://...' } }));
    const { enrollTotp } = await import('@/lib/auth/gotrue-mfa');
    const res = await enrollTotp('user-tok', 'alice@test.co');
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('http://gotrue.test/auth/v1/factors');
    expect(JSON.parse(call[1].body)).toEqual({
      factor_type: 'totp',
      issuer: 'IsaFlow',
      friendly_name: 'alice@test.co',
    });
    expect(res).toEqual({ factor_id: 'new-f', qr_code: 'data:img/...', secret: 'ABC' });
  });

  it('challengeFactor POSTs /factors/:id/challenge and returns challenge_id', async () => {
    fetchMock.mockReturnValueOnce(okJson({ id: 'chal-1', expires_at: 123 }));
    const { challengeFactor } = await import('@/lib/auth/gotrue-mfa');
    const id = await challengeFactor('f1', 'user-tok');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://gotrue.test/auth/v1/factors/f1/challenge');
    expect(id).toBe('chal-1');
  });

  it('verifyFactor POSTs /factors/:id/verify and returns the new access token pair', async () => {
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
    const { listFactors, GotrueMfaError } = await import('@/lib/auth/gotrue-mfa');
    await expect(listFactors('tok')).rejects.toBeInstanceOf(GotrueMfaError);
    await expect(listFactors('tok')).rejects.toMatchObject({ status: 403 });
  });
});
```

- [ ] **Step 2: Run tests — expect fail**

Run: `bun run test:unit -- tests/unit/auth/gotrue-mfa.test.ts`

Expected: `Cannot find module '@/lib/auth/gotrue-mfa'`.

- [ ] **Step 3: Implement the client**

Create `src/lib/auth/gotrue-mfa.ts`:

```ts
// src/lib/auth/gotrue-mfa.ts
// Thin HTTP client for GoTrue's MFA endpoints. IsaFlow does not persist any
// factor material — GoTrue's auth.mfa_factors owns TOTP.

function gotrueUrl(path: string): string {
  const base = (process.env.GOTRUE_URL ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('GOTRUE_URL is not set');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function anonKey(): string {
  const v = process.env.SUPABASE_ANON_KEY;
  if (!v) throw new Error('SUPABASE_ANON_KEY is not set');
  return v;
}

function serviceKey(): string {
  const v = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!v) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return v;
}

export class GotrueMfaError extends Error {
  constructor(public readonly status: number, message: string, public readonly body: unknown) {
    super(message);
    this.name = 'GotrueMfaError';
  }
}

async function mfaFetch<T>(
  path: string,
  init: RequestInit,
  headers: Record<string, string>
): Promise<T> {
  const res = await fetch(gotrueUrl(path), {
    ...init,
    headers: { 'content-type': 'application/json', apikey: anonKey(), ...headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new GotrueMfaError(res.status, `gotrue ${path} failed: ${res.status}`, body);
  }
  return res.json() as Promise<T>;
}

export interface Factor {
  id: string;
  status: 'verified' | 'unverified';
  factor_type: 'totp' | 'phone';
  friendly_name?: string;
  created_at?: string;
}

export interface ListFactorsResponse {
  totp: Factor[];
}

// GoTrue v2 has no GET /factors — the authoritative source for a user's
// enrolled factors is GET /user, which returns { ..., factors: [...] }.
export async function listFactors(userAccessToken: string): Promise<ListFactorsResponse> {
  const user = await mfaFetch<{ factors?: Factor[] }>(
    '/user',
    { method: 'GET' },
    { Authorization: `Bearer ${userAccessToken}` }
  );
  const all = user.factors ?? [];
  return { totp: all.filter((f) => f.factor_type === 'totp') };
}

export interface EnrollTotpResult {
  factor_id: string;
  qr_code: string; // SVG XML string (raw <svg>…</svg>) — NOT a data: URL
  secret: string; // base32 shared secret (32 chars)
}

export async function enrollTotp(userAccessToken: string, friendlyName: string): Promise<EnrollTotpResult> {
  const res = await mfaFetch<{ id: string; totp: { qr_code: string; secret: string; uri: string } }>(
    '/factors',
    {
      method: 'POST',
      body: JSON.stringify({ factor_type: 'totp', issuer: 'IsaFlow', friendly_name: friendlyName }),
    },
    { Authorization: `Bearer ${userAccessToken}` }
  );
  return { factor_id: res.id, qr_code: res.totp.qr_code, secret: res.totp.secret };
}

export async function challengeFactor(factorId: string, userAccessToken: string): Promise<string> {
  const res = await mfaFetch<{ id: string; expires_at: number }>(
    `/factors/${encodeURIComponent(factorId)}/challenge`,
    { method: 'POST' },
    { Authorization: `Bearer ${userAccessToken}` }
  );
  return res.id;
}

export interface VerifyFactorResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function verifyFactor(
  factorId: string,
  challengeId: string,
  code: string,
  userAccessToken: string
): Promise<VerifyFactorResult> {
  return mfaFetch<VerifyFactorResult>(
    `/factors/${encodeURIComponent(factorId)}/verify`,
    { method: 'POST', body: JSON.stringify({ challenge_id: challengeId, code }) },
    { Authorization: `Bearer ${userAccessToken}` }
  );
}

export async function unenrollFactor(factorId: string, userAccessToken: string): Promise<void> {
  await mfaFetch<unknown>(
    `/factors/${encodeURIComponent(factorId)}`,
    { method: 'DELETE' },
    { Authorization: `Bearer ${userAccessToken}` }
  );
}

export async function adminUnenrollFactor(userId: string, factorId: string): Promise<void> {
  const key = serviceKey();
  await mfaFetch<unknown>(
    `/admin/users/${encodeURIComponent(userId)}/factors/${encodeURIComponent(factorId)}`,
    { method: 'DELETE' },
    { Authorization: `Bearer ${key}`, apikey: key }
  );
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun run test:unit -- tests/unit/auth/gotrue-mfa.test.ts`
Expected: 7/7 PASS.

- [ ] **Step 5: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/gotrue-mfa.ts tests/unit/auth/gotrue-mfa.test.ts
git commit -m "feat(auth): gotrue-mfa HTTP client for /factors/* endpoints"
```

---

## Task 3: `2fa-enroll.ts` endpoint

**Files:**
- Create: `pages/api/auth/2fa-enroll.ts`

- [ ] **Step 1: Create the endpoint**

```ts
// pages/api/auth/2fa-enroll.ts
import type { NextApiHandler } from 'next';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { enrollTotp, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { verifyToken } from '@/lib/auth/gotrue';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  let email: string;
  try {
    const claims = await verifyToken(token);
    email = typeof claims.email === 'string' ? claims.email : '';
  } catch {
    return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
  }
  try {
    const result = await enrollTotp(token, email);
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      log.warn('2fa-enroll gotrue error', { status: err.status }, 'Auth');
      return res.status(err.status).json({ success: false, error: { code: 'ENROLL_FAILED', message: err.message } });
    }
    throw err;
  }
};

export default handler;
```

- [ ] **Step 2: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add pages/api/auth/2fa-enroll.ts
git commit -m "feat(auth): /api/auth/2fa-enroll returns GoTrue TOTP factor + QR"
```

---

## Task 4: `2fa-confirm.ts` endpoint

**Files:**
- Create: `pages/api/auth/2fa-confirm.ts`

- [ ] **Step 1: Create the endpoint**

```ts
// pages/api/auth/2fa-confirm.ts
import type { NextApiHandler } from 'next';
import { parseCookies, setAuthCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { challengeFactor, verifyFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  const { factor_id, code } = req.body ?? {};
  if (typeof factor_id !== 'string' || typeof code !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'factor_id and code required' } });
  }
  try {
    const challengeId = await challengeFactor(factor_id, token);
    const aal2 = await verifyFactor(factor_id, challengeId, code, token);
    setAuthCookies(res, { accessToken: aal2.access_token, refreshToken: aal2.refresh_token, expiresIn: aal2.expires_in });
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      log.info('2fa-confirm failed', { status: err.status }, 'Auth');
      const code = err.status === 422 ? 'INVALID_CODE' : 'CONFIRM_FAILED';
      return res.status(err.status === 422 ? 400 : err.status).json({
        success: false,
        error: { code, message: 'Invalid verification code' },
      });
    }
    throw err;
  }
};

export default handler;
```

- [ ] **Step 2: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add pages/api/auth/2fa-confirm.ts
git commit -m "feat(auth): /api/auth/2fa-confirm verifies newly enrolled TOTP factor"
```

---

## Task 5: `2fa-challenge.ts` — login-gate endpoint

**Files:**
- Create: `pages/api/auth/2fa-challenge.ts`

- [ ] **Step 1: Create the endpoint**

```ts
// pages/api/auth/2fa-challenge.ts
// Called by the client after /api/auth/login returns {requires_2fa: true, ...}.
// Completes the GoTrue challenge using the short-lived pending_token, then
// sets the real sb-access-token / sb-refresh-token cookies.
import type { NextApiHandler } from 'next';
import { setAuthCookies, setActiveCompanyCookie } from '@/lib/auth/cookies';
import { challengeFactor, verifyFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { verifyToken } from '@/lib/auth/gotrue';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { factor_id, code, pending_token } = req.body ?? {};
  if (typeof factor_id !== 'string' || typeof code !== 'string' || typeof pending_token !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'factor_id, code, pending_token required' } });
  }

  // Validate pending_token so a stolen or expired pending_token can't pass as a login.
  let userId: string;
  let email: string;
  try {
    const claims = await verifyToken(pending_token);
    userId = claims.sub;
    email = typeof claims.email === 'string' ? claims.email : '';
  } catch {
    return res.status(401).json({ success: false, error: { code: 'INVALID_PENDING_TOKEN', message: 'Pending session expired' } });
  }

  try {
    const challengeId = await challengeFactor(factor_id, pending_token);
    const aal2 = await verifyFactor(factor_id, challengeId, code, pending_token);

    // Pick active company exactly the way login.ts does
    const memberships = await sql<{ company_id: string }>`
      SELECT company_id
      FROM company_users
      WHERE user_id = ${userId}
      ORDER BY is_default DESC, created_at ASC
      LIMIT 1
    `;

    setAuthCookies(res, {
      accessToken: aal2.access_token,
      refreshToken: aal2.refresh_token,
      expiresIn: aal2.expires_in,
    });
    if (memberships.length > 0) setActiveCompanyCookie(res, memberships[0]!.company_id);

    return res.status(200).json({
      success: true,
      data: {
        user: { id: userId, email },
        activeCompanyId: memberships[0]?.company_id ?? null,
      },
    });
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      log.info('2fa-challenge failed', { status: err.status }, 'Auth');
      return res.status(err.status === 422 ? 400 : err.status).json({
        success: false,
        error: { code: err.status === 422 ? 'INVALID_CODE' : 'CHALLENGE_FAILED', message: 'Invalid verification code' },
      });
    }
    throw err;
  }
};

export default handler;
```

- [ ] **Step 2: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add pages/api/auth/2fa-challenge.ts
git commit -m "feat(auth): /api/auth/2fa-challenge completes login-time TOTP challenge"
```

---

## Task 6: `login.ts` MFA gate

**Files:**
- Modify: `pages/api/auth/login.ts`

- [ ] **Step 1: Replace the file contents**

```ts
// pages/api/auth/login.ts
import type { NextApiHandler } from 'next';
import { signIn } from '@/lib/auth/gotrue';
import { listFactors, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { setAuthCookies, setActiveCompanyCookie } from '@/lib/auth/cookies';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'email and password required' } });
  }

  let token;
  try {
    token = await signIn(email.toLowerCase().trim(), password);
  } catch (err) {
    log.info('login failed', { email, message: err instanceof Error ? err.message : 'unknown' }, 'Auth');
    return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
  }

  // MFA gate: if the user has any verified factor, withhold cookies and ask for a code.
  // Fail-closed on GoTrue error per spec — do not silently log in.
  let verified;
  try {
    const factors = await listFactors(token.access_token);
    verified = factors.totp.filter((f) => f.status === 'verified');
  } catch (err) {
    log.error('login: listFactors failed — failing closed', { message: err instanceof Error ? err.message : 'unknown' }, 'Auth');
    if (err instanceof GotrueMfaError) {
      return res.status(503).json({ success: false, error: { code: 'MFA_CHECK_UNAVAILABLE', message: 'Sign-in temporarily unavailable. Please try again.' } });
    }
    return res.status(503).json({ success: false, error: { code: 'MFA_CHECK_UNAVAILABLE', message: 'Sign-in temporarily unavailable. Please try again.' } });
  }

  if (verified.length > 0) {
    return res.status(200).json({
      success: true,
      data: {
        requires_2fa: true,
        factor_id: verified[0]!.id,
        pending_token: token.access_token,
      },
    });
  }

  // No MFA — set cookies and sign in directly.
  const memberships = await sql<{ company_id: string; is_default: boolean; created_at: Date }>`
    SELECT company_id, is_default, created_at
    FROM company_users
    WHERE user_id = ${token.user.id}
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `;

  setAuthCookies(res, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
  });
  if (memberships.length > 0) setActiveCompanyCookie(res, memberships[0]!.company_id);

  return res.status(200).json({
    success: true,
    data: {
      user: { id: token.user.id, email: token.user.email },
      activeCompanyId: memberships[0]?.company_id ?? null,
    },
  });
};

export default handler;
```

- [ ] **Step 2: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add pages/api/auth/login.ts
git commit -m "feat(auth): login gates sb-access-token behind TOTP when factor exists"
```

---

## Task 7: Rewrite `2fa-disable.ts`

**Files:**
- Modify: `pages/api/auth/2fa-disable.ts`

- [ ] **Step 1: Replace the file contents**

```ts
// pages/api/auth/2fa-disable.ts
// Disable 2FA: verify a current TOTP code (proves possession), then unenroll.
import type { NextApiHandler } from 'next';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { challengeFactor, verifyFactor, unenrollFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  const { factor_id, code } = req.body ?? {};
  if (typeof factor_id !== 'string' || typeof code !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'factor_id and code required' } });
  }
  try {
    const challengeId = await challengeFactor(factor_id, token);
    await verifyFactor(factor_id, challengeId, code, token);
    await unenrollFactor(factor_id, token);
    return res.status(200).json({ success: true });
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      log.info('2fa-disable failed', { status: err.status }, 'Auth');
      return res.status(err.status === 422 ? 400 : err.status).json({
        success: false,
        error: { code: err.status === 422 ? 'INVALID_CODE' : 'DISABLE_FAILED', message: 'Invalid verification code' },
      });
    }
    throw err;
  }
};

export default handler;
```

- [ ] **Step 2: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add pages/api/auth/2fa-disable.ts
git commit -m "feat(auth): 2fa-disable rewritten on GoTrue challenge+verify+unenroll"
```

---

## Task 8: Trim `2fa-status.ts`

**Files:**
- Modify: `pages/api/auth/2fa-status.ts`

- [ ] **Step 1: Replace the file contents**

```ts
// pages/api/auth/2fa-status.ts
// Tiny wrapper over GoTrue listFactors — gives the my-account UI a single
// GET to check whether TOTP is enabled.
import type { NextApiHandler } from 'next';
import { parseCookies, ACCESS_COOKIE } from '@/lib/auth/cookies';
import { listFactors, GotrueMfaError } from '@/lib/auth/gotrue-mfa';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'GET required' } });
  }
  const token = parseCookies(req)[ACCESS_COOKIE];
  if (!token) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  }
  try {
    const factors = await listFactors(token);
    const verified = factors.totp.find((f) => f.status === 'verified');
    return res.status(200).json({
      success: true,
      data: { enabled: !!verified, factor_id: verified?.id ?? null },
    });
  } catch (err) {
    if (err instanceof GotrueMfaError) {
      return res.status(err.status).json({ success: false, error: { code: 'STATUS_FAILED', message: err.message } });
    }
    throw err;
  }
};

export default handler;
```

- [ ] **Step 2: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add pages/api/auth/2fa-status.ts
git commit -m "feat(auth): 2fa-status trimmed to listFactors wrapper"
```

---

## Task 9: Super-admin reset-2fa endpoint

**Files:**
- Create: `pages/api/admin/users/[id]/reset-2fa.ts`

- [ ] **Step 1: Create the endpoint**

```ts
// pages/api/admin/users/[id]/reset-2fa.ts
// Super-admin operation: wipe all of the target user's MFA factors so they
// can log in without 2FA and re-enroll. Used when a user loses their device.
import type { NextApiResponse } from 'next';
import { withAdmin, type PlatformAdminRequest } from '@/modules/admin/middleware/withAdmin';
import { adminUnenrollFactor, GotrueMfaError } from '@/lib/auth/gotrue-mfa';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

interface AuthFactorRow {
  id: string;
  user_id: string;
}

async function handler(req: PlatformAdminRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
    return;
  }
  const targetUserId = req.query.id;
  if (typeof targetUserId !== 'string') {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'User id required' } });
    return;
  }

  // Read the factors directly from auth.mfa_factors (platform_admin has BYPASSRLS on public,
  // but auth schema is separate — use a SECURITY DEFINER view or service-role API.
  // Simpler: query auth.mfa_factors directly via the platform_admin pool connection).
  const factors = await sql<AuthFactorRow>`
    SELECT id::text, user_id::text
    FROM auth.mfa_factors
    WHERE user_id = ${targetUserId}::uuid
  `;

  let removed = 0;
  for (const f of factors) {
    try {
      await adminUnenrollFactor(f.user_id, f.id);
      removed++;
    } catch (err) {
      if (err instanceof GotrueMfaError && err.status === 404) continue; // already gone
      log.warn('admin reset-2fa: factor unenroll failed', { factor_id: f.id, status: err instanceof GotrueMfaError ? err.status : 'unknown' }, 'Auth');
    }
  }

  res.status(200).json({ success: true, data: { factors_removed: removed } });
}

export default withAdmin(handler);
```

- [ ] **Step 2: Grant `platform_admin` SELECT on `auth.mfa_factors`**

The migration 352 grants don't cover the `auth` schema's tables (only `public`). Run once as superuser to grant SELECT on this table to `platform_admin`:

```bash
psql 'postgresql://supabase_admin:a23f6104debd1d3e88e8f00c0067f22f@100.96.203.105:5437/isaflow_dev?sslmode=disable' \
  -c "GRANT SELECT ON TABLE auth.mfa_factors TO platform_admin"
```

Formalise in a migration — add this to Task 14's migration 354 so prod gets the grant when it's applied.

- [ ] **Step 3: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add pages/api/admin/users/\[id\]/reset-2fa.ts
git commit -m "feat(admin): reset-2fa wipes user MFA factors via GoTrue admin API"
```

---

## Task 10: Rewrite `TwoFactorSection.tsx` UI

**Files:**
- Modify: `src/components/accounting/my-account/TwoFactorSection.tsx`

- [ ] **Step 1: Replace file contents**

Replace the entire 420-LOC file with the following (strip trusted-devices + backup-codes + SMS UI). Approximate new size: ~170 LOC.

```tsx
// src/components/accounting/my-account/TwoFactorSection.tsx
// GoTrue-backed TOTP 2FA panel. Enroll → confirm → disable. No backup codes,
// no trusted devices, no SMS.
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/apiFetch';
import { log } from '@/lib/logger';

type View = 'loading' | 'disabled' | 'enrolling' | 'enabled';

interface StatusData { enabled: boolean; factor_id: string | null }
interface EnrollData { factor_id: string; qr_code: string; secret: string }

export function TwoFactorSection() {
  const [view, setView] = useState<View>('loading');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<EnrollData | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/api/auth/2fa-status');
      const json = await res.json() as { success: boolean; data?: StatusData };
      if (json.success && json.data) {
        setFactorId(json.data.factor_id);
        setView(json.data.enabled ? 'enabled' : 'disabled');
      } else {
        setView('disabled');
      }
    } catch (e) {
      log.warn('2fa-status load failed', { error: e }, 'auth');
      setView('disabled');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function startEnroll() {
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/auth/2fa-enroll', { method: 'POST' });
      const json = await res.json() as { success: boolean; data?: EnrollData; error?: { message: string } };
      if (!json.success || !json.data) throw new Error(json.error?.message ?? 'Enroll failed');
      setEnroll(json.data);
      setView('enrolling');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start enrollment');
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll() {
    if (!enroll) return;
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/auth/2fa-confirm', {
        method: 'POST',
        body: JSON.stringify({ factor_id: enroll.factor_id, code }),
      });
      const json = await res.json() as { success: boolean; error?: { message: string } };
      if (!json.success) throw new Error(json.error?.message ?? 'Invalid code');
      setEnroll(null); setCode('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid code');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!factorId) return;
    setBusy(true); setError(null);
    try {
      const res = await apiFetch('/api/auth/2fa-disable', {
        method: 'POST',
        body: JSON.stringify({ factor_id: factorId, code }),
      });
      const json = await res.json() as { success: boolean; error?: { message: string } };
      if (!json.success) throw new Error(json.error?.message ?? 'Invalid code');
      setCode('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disable failed');
    } finally {
      setBusy(false);
    }
  }

  if (view === 'loading') {
    return <div className="text-sm text-gray-500">Loading 2FA status…</div>;
  }

  if (view === 'enrolling' && enroll) {
    return (
      <div className="space-y-4">
        <h3 className="text-base font-semibold">Set up two-factor authentication</h3>
        <p className="text-sm text-gray-600">Scan this QR code with your authenticator app (Google Authenticator, 1Password, Authy).</p>
        {/* enroll.qr_code is raw SVG XML from GoTrue. Wrap as a data: URL
            and render via <img> so we avoid dangerouslySetInnerHTML. */}
        <img
          src={`data:image/svg+xml;base64,${btoa(enroll.qr_code)}`}
          alt="TOTP QR code"
          className="border border-gray-200 rounded-md bg-white"
          style={{ width: 200, height: 200 }}
        />
        <p className="text-xs text-gray-500 font-mono break-all">Or enter manually: <span className="font-semibold">{enroll.secret}</span></p>
        <label className="block text-sm">
          <span>Enter the 6-digit code from your app</span>
          <input
            className="mt-1 block w-40 border rounded-md px-2 py-1"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            aria-label="TOTP code"
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button
            className="px-3 py-1.5 bg-teal-600 text-white rounded-md disabled:opacity-50"
            onClick={confirmEnroll}
            disabled={busy || code.length !== 6}
          >
            Enable 2FA
          </button>
          <button
            className="px-3 py-1.5 border rounded-md"
            onClick={() => { setEnroll(null); setCode(''); setError(null); setView('disabled'); }}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (view === 'enabled') {
    return (
      <div className="space-y-3">
        <h3 className="text-base font-semibold">Two-factor authentication is enabled</h3>
        <p className="text-sm text-gray-600">To disable, enter a current code from your authenticator app.</p>
        <input
          className="block w-40 border rounded-md px-2 py-1"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          aria-label="TOTP code"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          className="px-3 py-1.5 border border-red-600 text-red-600 rounded-md disabled:opacity-50"
          onClick={disable}
          disabled={busy || code.length !== 6}
        >
          Disable 2FA
        </button>
      </div>
    );
  }

  // view === 'disabled'
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold">Two-factor authentication</h3>
      <p className="text-sm text-gray-600">Adds a second step to every login. You'll need an authenticator app.</p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        className="px-3 py-1.5 bg-teal-600 text-white rounded-md disabled:opacity-50"
        onClick={startEnroll}
        disabled={busy}
      >
        Enable 2FA
      </button>
    </div>
  );
}
```

- [ ] **Step 2: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/components/accounting/my-account/TwoFactorSection.tsx
git commit -m "feat(ui): TwoFactorSection rewrite — enroll/confirm/disable only"
```

---

## Task 11: Client-side login form handles `requires_2fa`

**Files:**
- Modify: `pages/login.tsx`

- [ ] **Step 1: Audit the existing login form**

Run: `grep -n "requires_2fa\|2fa\|mfa" pages/login.tsx`

If no matches exist, the form posts to `/api/auth/login` and navigates on success. Proceed to Step 2.

- [ ] **Step 2: Add a code-entry step**

The precise patch depends on the existing form shape. The minimum change: when the login POST response has `data.requires_2fa === true`, store `{factor_id, pending_token}` in component state, render a code input, and POST to `/api/auth/2fa-challenge` on submit.

Pattern (add inside the existing login page's submit handler):

```ts
// After the successful login POST:
const json = await res.json() as {
  success: boolean;
  data?: {
    requires_2fa?: true;
    factor_id?: string;
    pending_token?: string;
    user?: { id: string; email: string };
    activeCompanyId?: string | null;
  };
  error?: { message: string };
};

if (!json.success) {
  setError(json.error?.message ?? 'Login failed');
  return;
}

if (json.data?.requires_2fa) {
  setPendingFactor({ factor_id: json.data.factor_id!, pending_token: json.data.pending_token! });
  setStep('totp');
  return;
}

// Fall through to existing redirect-to-dashboard behaviour.
```

And the TOTP-step submit handler:

```ts
const handleTotpSubmit = async () => {
  const res = await fetch('/api/auth/2fa-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      factor_id: pendingFactor!.factor_id,
      code: totpCode,
      pending_token: pendingFactor!.pending_token,
    }),
  });
  const json = await res.json() as { success: boolean; error?: { message: string } };
  if (!json.success) {
    setTotpError(json.error?.message ?? 'Invalid code');
    return;
  }
  router.push(adminHost ? '/' : '/accounting');
};
```

Wire these into the existing component state. The exact edit depends on what's there — implementers should:
1. Read `pages/login.tsx`.
2. Add a `step: 'credentials' | 'totp'` state (default `'credentials'`).
3. On `requires_2fa`, flip to `'totp'` and render a 6-digit input bound to `totpCode`.
4. On TOTP submit, call `/api/auth/2fa-challenge` as shown.

- [ ] **Step 3: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add pages/login.tsx
git commit -m "feat(login): 2-step login when user has a verified TOTP factor"
```

---

## Task 12: Delete legacy 2FA files + service

**Files:**
- Delete: `src/modules/auth/services/twoFactorService.ts`
- Delete: `pages/api/auth/2fa-setup.ts`
- Delete: `pages/api/auth/2fa-verify-setup.ts`
- Delete: `pages/api/auth/2fa-verify.ts`
- Delete: `pages/api/auth/2fa-trusted-devices.ts`

- [ ] **Step 1: Verify no imports reference the files to be deleted**

Run:
```bash
grep -rn "twoFactorService\|2fa-setup\|2fa-verify-setup\|2fa-verify\b\|2fa-trusted-devices" src/ pages/ tests/ | grep -v "2fa-verify-setup.ts\|2fa-trusted-devices.ts\|2fa-setup.ts\|2fa-verify.ts\|twoFactorService.ts"
```

Expected: no matches. If matches exist, STOP — audit and fix first (probably a stale import in TwoFactorSection.tsx before Task 10 landed).

- [ ] **Step 2: Remove the files**

```bash
git rm src/modules/auth/services/twoFactorService.ts
git rm pages/api/auth/2fa-setup.ts
git rm pages/api/auth/2fa-verify-setup.ts
git rm pages/api/auth/2fa-verify.ts
git rm pages/api/auth/2fa-trusted-devices.ts
```

- [ ] **Step 3: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(auth): remove custom 2FA service + legacy endpoints"
```

---

## Task 13: Integration tests against dev GoTrue

**Files:**
- Create: `tests/integration/2fa-enroll-flow.int.test.ts`
- Create: `tests/integration/2fa-login-gate.int.test.ts`
- Create: `tests/integration/2fa-disable-flow.int.test.ts`
- Create: `tests/integration/admin-reset-2fa.int.test.ts`

- [ ] **Step 1: Create `2fa-enroll-flow.int.test.ts`**

```ts
// tests/integration/2fa-enroll-flow.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TOTP, Secret } from 'otpauth';
import { signIn, adminCreateUser, adminDeleteUser } from '@/lib/auth/gotrue';
import { enrollTotp, listFactors, challengeFactor, verifyFactor, unenrollFactor } from '@/lib/auth/gotrue-mfa';

if (!process.env.JWT_SECRET || !process.env.GOTRUE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('JWT_SECRET + GOTRUE_URL + SUPABASE_SERVICE_ROLE_KEY required');
}

const TEST_EMAIL = `2fa-enroll-${Date.now()}@test.local`;
const TEST_PW = 'E2EMfaSecret!123';

describe('2FA enroll flow (against dev GoTrue)', () => {
  let userId: string;
  let accessToken: string;

  beforeAll(async () => {
    const user = await adminCreateUser({ email: TEST_EMAIL, password: TEST_PW, email_confirm: true });
    userId = user.id;
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    accessToken = tok.access_token;
  });
  afterAll(async () => {
    try { await adminDeleteUser(userId); } catch { /* best-effort cleanup */ }
  });

  it('enroll → challenge → verify → listFactors shows verified', async () => {
    const enroll = await enrollTotp(accessToken, TEST_EMAIL);
    expect(enroll.factor_id).toBeTruthy();
    expect(enroll.secret).toMatch(/^[A-Z2-7]+$/); // base32

    const totp = new TOTP({ secret: Secret.fromBase32(enroll.secret), digits: 6, period: 30 });
    const code = totp.generate();

    const challengeId = await challengeFactor(enroll.factor_id, accessToken);
    const aal2 = await verifyFactor(enroll.factor_id, challengeId, code, accessToken);
    expect(aal2.access_token).toBeTruthy();

    const factors = await listFactors(aal2.access_token);
    const verified = factors.totp.filter((f) => f.status === 'verified');
    expect(verified.length).toBeGreaterThanOrEqual(1);

    // Cleanup — unenroll so user can be deleted cleanly
    await unenrollFactor(enroll.factor_id, aal2.access_token);
  });
});
```

- [ ] **Step 2: Create `2fa-login-gate.int.test.ts`**

```ts
// tests/integration/2fa-login-gate.int.test.ts
// Drives /api/auth/login through the actual handler to confirm the MFA gate.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NextApiResponse } from 'next';
import { TOTP, Secret } from 'otpauth';
import { signIn, adminCreateUser, adminDeleteUser } from '@/lib/auth/gotrue';
import { enrollTotp, challengeFactor, verifyFactor, unenrollFactor } from '@/lib/auth/gotrue-mfa';
import loginHandler from '../../pages/api/auth/login';
import challengeHandler from '../../pages/api/auth/2fa-challenge';

if (!process.env.JWT_SECRET || !process.env.GOTRUE_URL || !process.env.DATABASE_URL) {
  throw new Error('JWT_SECRET + GOTRUE_URL + DATABASE_URL required');
}

const TEST_EMAIL = `2fa-gate-${Date.now()}@test.local`;
const TEST_PW = 'E2EMfaGate!123';

function mkReq(body: unknown) {
  return { method: 'POST', body, headers: {}, url: '/api/auth/login' } as never;
}
function mkRes() {
  let status = 200; let body: unknown; const setCookies: string[] = [];
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body = v; return this; },
    setHeader(k: string, v: string | string[]) {
      if (k.toLowerCase() === 'set-cookie') setCookies.push(...(Array.isArray(v) ? v : [v]));
    },
    getHeader(k: string) { return k.toLowerCase() === 'set-cookie' ? setCookies : undefined; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body; }, get cookies() { return setCookies; } };
}

describe('login MFA gate', () => {
  let userId: string;
  let secret: string;
  let factorId: string;

  beforeAll(async () => {
    const user = await adminCreateUser({ email: TEST_EMAIL, password: TEST_PW, email_confirm: true });
    userId = user.id;
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    const enroll = await enrollTotp(tok.access_token, TEST_EMAIL);
    factorId = enroll.factor_id;
    secret = enroll.secret;
    const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
    const challengeId = await challengeFactor(factorId, tok.access_token);
    await verifyFactor(factorId, challengeId, totp.generate(), tok.access_token);
  });
  afterAll(async () => {
    try {
      const tok = await signIn(TEST_EMAIL, TEST_PW);
      await unenrollFactor(factorId, tok.access_token);
    } catch { /* best-effort */ }
    try { await adminDeleteUser(userId); } catch { /* best-effort */ }
  });

  it('login with TOTP factor returns requires_2fa: true and NO cookie', async () => {
    const r = mkRes();
    await loginHandler(mkReq({ email: TEST_EMAIL, password: TEST_PW }), r.res);
    expect(r.status).toBe(200);
    expect((r.body as { data: { requires_2fa?: true; factor_id?: string; pending_token?: string } }).data.requires_2fa).toBe(true);
    expect((r.body as { data: { factor_id?: string } }).data.factor_id).toBe(factorId);
    expect(r.cookies.some((c: string) => c.startsWith('sb-access-token='))).toBe(false);
  });

  it('challenge endpoint sets sb-access-token cookie when code valid', async () => {
    const loginRes = mkRes();
    await loginHandler(mkReq({ email: TEST_EMAIL, password: TEST_PW }), loginRes.res);
    const { factor_id, pending_token } = (loginRes.body as { data: { factor_id: string; pending_token: string } }).data;

    const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
    const r2 = mkRes();
    await challengeHandler(mkReq({ factor_id, code: totp.generate(), pending_token }), r2.res);
    expect(r2.status).toBe(200);
    expect(r2.cookies.some((c: string) => c.startsWith('sb-access-token='))).toBe(true);
  });
});
```

- [ ] **Step 3: Create `2fa-disable-flow.int.test.ts`**

```ts
// tests/integration/2fa-disable-flow.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TOTP, Secret } from 'otpauth';
import { signIn, adminCreateUser, adminDeleteUser } from '@/lib/auth/gotrue';
import { enrollTotp, challengeFactor, verifyFactor, listFactors } from '@/lib/auth/gotrue-mfa';

const TEST_EMAIL = `2fa-disable-${Date.now()}@test.local`;
const TEST_PW = 'E2EMfaDisable!123';

describe('2fa disable flow', () => {
  let userId: string;
  let factorId: string;
  let secret: string;

  beforeAll(async () => {
    const user = await adminCreateUser({ email: TEST_EMAIL, password: TEST_PW, email_confirm: true });
    userId = user.id;
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    const enroll = await enrollTotp(tok.access_token, TEST_EMAIL);
    factorId = enroll.factor_id;
    secret = enroll.secret;
    const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
    const cid = await challengeFactor(factorId, tok.access_token);
    await verifyFactor(factorId, cid, totp.generate(), tok.access_token);
  });
  afterAll(async () => {
    try { await adminDeleteUser(userId); } catch { /* best-effort */ }
  });

  it('disabling removes the factor so listFactors returns zero verified', async () => {
    const { default: disableHandler } = await import('../../pages/api/auth/2fa-disable');
    // Re-login to get a fresh access token. Because user still has a verified factor,
    // signIn returns an AAL1 token; we use it for the challenge+verify inside disable.
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });

    const res = {
      status(_c: number) { return this; },
      json(_v: unknown) { return this; },
      setHeader() { /* noop */ },
      getHeader() { return undefined; },
    } as never;
    const req = {
      method: 'POST',
      headers: { cookie: `sb-access-token=${tok.access_token}` },
      body: { factor_id: factorId, code: totp.generate() },
      url: '/api/auth/2fa-disable',
    } as never;
    await disableHandler(req, res);

    const factors = await listFactors(tok.access_token);
    expect(factors.totp.filter((f) => f.status === 'verified')).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Create `admin-reset-2fa.int.test.ts`**

```ts
// tests/integration/admin-reset-2fa.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TOTP, Secret } from 'otpauth';
import { Pool } from 'pg';
import { signIn, adminCreateUser, adminDeleteUser } from '@/lib/auth/gotrue';
import { enrollTotp, challengeFactor, verifyFactor, listFactors, adminUnenrollFactor } from '@/lib/auth/gotrue-mfa';

const TEST_EMAIL = `admin-reset-${Date.now()}@test.local`;
const TEST_PW = 'E2EMfaReset!123';

describe('admin reset-2fa', () => {
  let userId: string;
  let factorId: string;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const user = await adminCreateUser({ email: TEST_EMAIL, password: TEST_PW, email_confirm: true });
    userId = user.id;
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    const enroll = await enrollTotp(tok.access_token, TEST_EMAIL);
    factorId = enroll.factor_id;
    const totp = new TOTP({ secret: Secret.fromBase32(enroll.secret), digits: 6, period: 30 });
    const cid = await challengeFactor(factorId, tok.access_token);
    await verifyFactor(factorId, cid, totp.generate(), tok.access_token);
  });
  afterAll(async () => {
    try { await adminDeleteUser(userId); } catch { /* best-effort */ }
    await pool.end();
  });

  it('adminUnenrollFactor wipes the factor; listFactors returns none', async () => {
    await adminUnenrollFactor(userId, factorId);
    const tok = await signIn(TEST_EMAIL, TEST_PW);
    const factors = await listFactors(tok.access_token);
    expect(factors.totp.filter((f) => f.status === 'verified')).toHaveLength(0);
  });
});
```

Note: the full endpoint-level test for `POST /api/admin/users/:id/reset-2fa` requires driving `withAdmin` through a real HTTP request with CSRF + rate-limit + super-admin check; that is heavier plumbing than the value added. The test above exercises the service-role call that the endpoint delegates to — sufficient coverage for Phase 3b.

- [ ] **Step 5: Run all four integration tests**

Run:
```bash
set -a; source .env.local 2>/dev/null; set +a
bunx vitest run --config vitest.integration.config.ts tests/integration/2fa-*.int.test.ts tests/integration/admin-reset-2fa.int.test.ts
```

Expected: 4/4 test files PASS, 4 tests PASS total.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/2fa-enroll-flow.int.test.ts \
        tests/integration/2fa-login-gate.int.test.ts \
        tests/integration/2fa-disable-flow.int.test.ts \
        tests/integration/admin-reset-2fa.int.test.ts
git commit -m "test(integration): GoTrue MFA enroll/gate/disable/admin-reset flows"
```

---

## Task 14: Migration 354 — drop custom 2FA tables

**Files:**
- Create: `scripts/migrations/sql/354_drop_custom_2fa.sql`

- [ ] **Step 1: Write the migration**

```sql
-- scripts/migrations/sql/354_drop_custom_2fa.sql
-- Phase 3b: Remove custom 2FA tables. GoTrue's auth.mfa_factors now owns TOTP.
-- Pre-cut verification: both tables had zero rows on prod and dev.
DROP INDEX IF EXISTS idx_trusted_devices_expiry;
DROP INDEX IF EXISTS idx_trusted_devices_user;
DROP INDEX IF EXISTS idx_user_2fa_user;
DROP TABLE IF EXISTS user_trusted_devices;
DROP TABLE IF EXISTS user_2fa;

-- platform_admin needs to read auth.mfa_factors for the admin reset flow.
GRANT SELECT ON TABLE auth.mfa_factors TO platform_admin;
```

- [ ] **Step 2: Apply on dev as supabase_admin**

```bash
psql 'postgresql://supabase_admin:a23f6104debd1d3e88e8f00c0067f22f@100.96.203.105:5437/isaflow_dev?sslmode=disable' \
  -f scripts/migrations/sql/354_drop_custom_2fa.sql
```

Expected: `DROP INDEX` (×3), `DROP TABLE` (×2), `GRANT`.

- [ ] **Step 3: Record in dev tracking**

```bash
CHECKSUM=$(sha256sum scripts/migrations/sql/354_drop_custom_2fa.sql | awk '{print $1}')
psql 'postgresql://migration_admin:398ae138816873a688e534b28ba9116b@100.96.203.105:5437/isaflow_dev?sslmode=disable' \
  -c "INSERT INTO schema_migrations (version, name, checksum) VALUES ('354', '354_drop_custom_2fa.sql', '$CHECKSUM') ON CONFLICT DO NOTHING"
```

- [ ] **Step 4: Confirm dev tables are gone**

```bash
psql 'postgresql://migration_admin:398ae138816873a688e534b28ba9116b@100.96.203.105:5437/isaflow_dev?sslmode=disable' \
  -c "SELECT to_regclass('public.user_2fa'), to_regclass('public.user_trusted_devices')"
```

Expected: both NULL.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrations/sql/354_drop_custom_2fa.sql
git commit -m "feat(db): migration 354 — drop custom 2FA tables, grant auth.mfa_factors to platform_admin"
```

---

## Task 15: Trim runtime dependencies

**Files:**
- Modify: `package.json`
- Modify: `bun.lockb`

- [ ] **Step 1: Confirm no runtime code imports `qrcode` or `otpauth`**

Run:
```bash
grep -rn "from ['\"]otpauth['\"]\|from ['\"]qrcode['\"]\|require('otpauth')\|require('qrcode')" src/ pages/ | grep -v tests/
```

Expected: no matches (legacy imports were in `twoFactorService.ts` deleted in Task 12, and tests keep their own import which is allowed).

- [ ] **Step 2: Move `otpauth` to devDependencies, remove `qrcode`**

```bash
bun remove qrcode @types/qrcode
bun remove otpauth
bun add -D otpauth
```

- [ ] **Step 3: Run full unit suite to confirm no breakage**

Run: `bun run test:unit 2>&1 | tail -10`
Expected: all green (integration tests need env and are not in the default `test:unit` run).

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore(deps): drop qrcode, move otpauth to devDependencies"
```

---

## Task 16: Dev smoke test (manual)

- [ ] **Step 1: Restart dev server so it picks up the new endpoints**

```bash
# If a dev server is already running on port 3200 or 3101, stop it first
# (Ctrl-C in its terminal). Then from /home/hein/Workspace/IsaFlow:
bun run dev
```

- [ ] **Step 2: Browser smoke — enroll**

1. Log into dev as your usual account.
2. Go to `/accounting/my-account`.
3. Click "Enable 2FA".
4. Scan the QR code with Google Authenticator / 1Password / Authy.
5. Enter the 6-digit code. Click "Enable".
6. Expect: "Two-factor authentication is enabled".

- [ ] **Step 3: Browser smoke — login gate**

1. Click logout.
2. Log in again with the same credentials.
3. Expect: email/password accepted, then a TOTP prompt appears.
4. Enter an incorrect code → error message, no redirect.
5. Enter a correct code → redirected to dashboard.

- [ ] **Step 4: Browser smoke — disable**

1. Back at `/accounting/my-account`.
2. Enter a current TOTP code.
3. Click "Disable 2FA".
4. Expect: UI flips back to "Enable 2FA" button.
5. Log out, log back in → no TOTP prompt, straight to dashboard.

- [ ] **Step 5: No commit**

Manual verification.

---

## Task 17: Production deploy (gated)

> **Production time gate:** per project policy, production deploys require Hein's explicit approval and must occur outside business hours (08:00–17:00 SAST). This task assumes approval has been granted and the deploy window is open.

- [ ] **Step 1: Confirm GoTrue MFA is enabled on prod**

```bash
ssh velo@100.96.203.105 'grep -iE "^GOTRUE_MFA_|^MFA_TOTP_" /home/velo/supabase/.env 2>/dev/null'
```

If nothing is set, GoTrue v2.186.0 defaults to MFA enabled — proceed. If any line reads `=false`, edit `/home/velo/supabase/.env` on velo and flip to `true`, then `cd /home/velo/supabase && docker compose restart auth`.

- [ ] **Step 2: Apply migration 354 on prod as supabase_admin**

```bash
psql 'postgresql://supabase_admin:a23f6104debd1d3e88e8f00c0067f22f@100.96.203.105:5437/isaflow?sslmode=disable' \
  -f scripts/migrations/sql/354_drop_custom_2fa.sql
CHECKSUM=$(sha256sum scripts/migrations/sql/354_drop_custom_2fa.sql | awk '{print $1}')
psql 'postgresql://migration_admin:398ae138816873a688e534b28ba9116b@100.96.203.105:5437/isaflow?sslmode=disable' \
  -c "INSERT INTO schema_migrations (version, name, checksum) VALUES ('354', '354_drop_custom_2fa.sql', '$CHECKSUM') ON CONFLICT DO NOTHING"
```

- [ ] **Step 3: Deploy app code to prod**

```bash
bash scripts/deploy.sh
```

Watch for green health check. Expected: `isaflow.service` restarts cleanly, `/api/health` returns 200.

- [ ] **Step 4: Prod smoke test (Hein only)**

1. Visit `https://app.isaflow.co.za/accounting/my-account`.
2. Log in as super-admin.
3. Enroll TOTP, scan QR, confirm with code.
4. Log out. Log back in → TOTP prompt → valid code logs in.
5. Disable. Log out. Log back in → no prompt.

- [ ] **Step 5: Tag rollback anchor**

```bash
git tag -a v-pre-phase3b-2fa -m "Pre-Phase3b TOTP-on-GoTrue rollback anchor"
git push origin v-pre-phase3b-2fa
```

- [ ] **Step 6: Update project memory**

Append to `~/.claude/projects/-home-hein-Workspace-IsaFlow/memory/project_supabase_cutover.md` under the Phase 3 section:

```markdown
## Phase 3b — TOTP 2FA on GoTrue (shipped <YYYY-MM-DD>)

- Migration 354 on prod: dropped user_2fa + user_trusted_devices (0 rows pre-cut), granted SELECT on auth.mfa_factors to platform_admin.
- New middleware: src/lib/auth/gotrue-mfa.ts thin client for /factors/* + /admin/users/:uid/factors/:fid.
- login.ts now calls listFactors after signIn; returns {requires_2fa:true, factor_id, pending_token} when a verified TOTP factor exists.
- Four new/rewritten endpoints: 2fa-enroll, 2fa-confirm, 2fa-challenge, 2fa-disable. Trimmed 2fa-status. New admin reset-2fa.
- Deleted: twoFactorService.ts, 2fa-setup.ts, 2fa-verify-setup.ts, 2fa-verify.ts, 2fa-trusted-devices.ts. Net change: ~-400 LOC.
- Runtime dep `qrcode` removed; `otpauth` moved to devDependencies (integration-test code generation only).
- Rollback anchor: tag v-pre-phase3b-2fa.
```

---

## Self-Review

**1. Spec coverage:**
- Architecture → gotrue-mfa proxy: Task 2. ✓
- Architecture → login-flow gate: Task 6. ✓
- Architecture → admin reset: Task 9. ✓
- Changes by file → all new/modified/deleted files mapped to tasks. ✓
- Data flow → enroll: Task 3 + Task 10 (UI). ✓
- Data flow → login with 2FA: Task 6 + Task 5 + Task 11 (UI). ✓
- Data flow → disable: Task 7. ✓
- Data flow → admin reset: Task 9. ✓
- Migration 354: Task 14. ✓
- GoTrue config pre-check: Task 1 (dev) + Task 17 Step 1 (prod). ✓
- Fail-closed on listFactors error: Task 6 Step 1 (503 response). ✓
- Integration tests (4): Task 13. ✓
- Manual smoke: Task 16 (dev) + Task 17 (prod). ✓
- Rollback anchor + memory update: Task 17 Steps 5-6. ✓

**2. Placeholder scan:** No TBD / TODO / vague phrases. Every code block is complete. One area of inherent vagueness: Task 11 Step 2 says "the exact edit depends on what's there" for `pages/login.tsx`. Given the existing file is unknown from the plan, this is the most prescriptive instruction that can be written without reading the file. Acceptable — implementer reads the file and applies the pattern shown.

**3. Type consistency:**
- `EnrollTotpResult = {factor_id, qr_code, secret}` defined in Task 2, used identically in Tasks 3 and 10. ✓
- `VerifyFactorResult = {access_token, refresh_token, expires_in}` defined in Task 2, used in Tasks 4 / 5 / 7. ✓
- Login response shape `{requires_2fa, factor_id, pending_token}` defined in Task 6, consumed identically in Task 11. ✓
- `GotrueMfaError` thrown in Task 2, caught in Tasks 3 / 4 / 5 / 7 / 8 / 9. ✓

No gaps identified. Plan ready for execution.
