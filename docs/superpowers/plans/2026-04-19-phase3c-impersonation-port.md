# Phase 3c: User Impersonation + Password Reset on GoTrue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port user impersonation and admin-initiated password reset from the custom `jwt.ts`/`session.ts`/`password.ts` auth stack to GoTrue primitives. Then delete those three files — closing Phase 3 of the Supabase cutover.

**Architecture:** Super-admin clicks "Login as X" → `POST /api/admin/users/:id/impersonate` stashes admin's GoTrue tokens in a new `admin_impersonation_stash` table, calls GoTrue `POST /admin/generate_link` + `POST /verify` to get a session as the target user, swaps cookies, logs to `admin_audit_log`. Banner renders via an `is_impersonating` cookie; "Return" hits `POST /api/auth/end-impersonation` which restores the stashed admin cookies. Password reset likewise uses `generate_link(type: 'recovery')` and returns the action_link for the admin to copy.

**Tech Stack:** Next.js 14, TypeScript, GoTrue v2.186.0, Supabase self-hosted Postgres, Vitest (unit + integration), bun.

**Spec:** `docs/superpowers/specs/2026-04-19-phase3c-impersonation-port-design.md`

---

## File Structure

**New:**

| Path | Purpose |
|---|---|
| `scripts/migrations/sql/355_admin_impersonation_stash.sql` | Table + index + grant |
| `src/lib/auth/gotrue-admin-link.ts` | `generateLink(type, email)`, `verifyMagicLink(hashedToken, email)`, `GotrueAdminLinkError` |
| `src/lib/auth/impersonation-cookies.ts` | `setImpersonationCookies(res, stashId)`, `clearImpersonationCookies(res)` — dual-scope helpers for `sb-admin-stash` + `is_impersonating` |
| `pages/api/auth/end-impersonation.ts` | Restore cookies + delete stash + audit log |
| `src/components/layout/ImpersonationBanner.tsx` | Orange bar + "Return" button |
| `tests/unit/auth/gotrue-admin-link.test.ts` | 5 cases |
| `tests/unit/auth/impersonation-cookies.test.ts` | 3 cases |
| `tests/integration/impersonation-flow.int.test.ts` | Start → act → end round-trip |
| `tests/integration/admin-password-reset.int.test.ts` | Reset link shape + audit row |

**Modified:**

| Path | Change |
|---|---|
| `pages/api/admin/users/[id]/impersonate.ts` | Rewritten: replaces `userImpersonationService.createUserImpersonationSession` call with the inline GoTrue magic-link + stash flow |
| `src/modules/admin/services/userImpersonationService.ts` | Renamed functionally: `stashAdminTokens`, `loadStash`, `deleteStash` helpers. No more JWT signing. ~100 LOC. |
| `src/modules/admin/services/adminUserActionsService.ts` | `initiateAdminPasswordReset` → `generateLink({type: 'recovery'})`. Drops `generateResetToken` import. |
| `src/lib/auth/index.ts` | Drops the transitional `export { hashPassword, checkPasswordStrength, generateResetToken } from './password'` line |
| `src/components/layout/AppLayout.tsx` | Renders `<ImpersonationBanner />` when `is_impersonating=1` cookie is set |

**Deleted (in a dedicated final task):**

| Path |
|---|
| `src/lib/auth/jwt.ts` |
| `src/lib/auth/session.ts` |
| `src/lib/auth/password.ts` |
| `pages/api/auth/user-impersonate-exchange.ts` |
| `pages/impersonate.tsx` |

---

## Task 1: Migration 355 — `admin_impersonation_stash` table

**Files:**
- Create: `scripts/migrations/sql/355_admin_impersonation_stash.sql`

- [ ] **Step 1: Write the migration**

Create `scripts/migrations/sql/355_admin_impersonation_stash.sql`:

```sql
-- scripts/migrations/sql/355_admin_impersonation_stash.sql
-- Phase 3c: Server-side stash of the admin's tokens during impersonation, so
-- "Return to my session" can restore them without a re-login.
CREATE TABLE IF NOT EXISTS admin_impersonation_stash (
  stash_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id        text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  admin_access_token   text        NOT NULL,
  admin_refresh_token  text        NOT NULL,
  target_user_id       text        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_impersonation_stash_expires
  ON admin_impersonation_stash(expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE admin_impersonation_stash TO platform_admin;
```

- [ ] **Step 2: Apply on dev as `supabase_admin`**

Run:
```bash
psql 'postgresql://supabase_admin:a23f6104debd1d3e88e8f00c0067f22f@100.96.203.105:5437/isaflow_dev?sslmode=disable' \
  -f scripts/migrations/sql/355_admin_impersonation_stash.sql
```

Expected: `CREATE TABLE`, `CREATE INDEX`, `GRANT`.

- [ ] **Step 3: Record in dev schema_migrations**

```bash
CHECKSUM=$(sha256sum scripts/migrations/sql/355_admin_impersonation_stash.sql | awk '{print $1}')
psql 'postgresql://migration_admin:398ae138816873a688e534b28ba9116b@100.96.203.105:5437/isaflow_dev?sslmode=disable' \
  -c "INSERT INTO schema_migrations (version, name, checksum) VALUES ('355', '355_admin_impersonation_stash.sql', '$CHECKSUM') ON CONFLICT DO NOTHING RETURNING name"
```

Expected: row with `355_admin_impersonation_stash.sql`.

- [ ] **Step 4: Verify grant**

```bash
psql 'postgresql://migration_admin:398ae138816873a688e534b28ba9116b@100.96.203.105:5437/isaflow_dev?sslmode=disable' \
  -c "SELECT has_table_privilege('platform_admin', 'admin_impersonation_stash', 'INSERT') AS can_insert, has_table_privilege('platform_admin', 'admin_impersonation_stash', 'DELETE') AS can_delete"
```

Expected: both `t`.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrations/sql/355_admin_impersonation_stash.sql
git commit -m "feat(db): migration 355 — admin_impersonation_stash table"
```

---

## Task 2: `gotrue-admin-link.ts` HTTP client (TDD)

**Files:**
- Create: `src/lib/auth/gotrue-admin-link.ts`
- Create: `tests/unit/auth/gotrue-admin-link.test.ts`

GoTrue v2.186 API shape, verified by live probe:
- `POST /admin/generate_link` with `{type: 'magiclink' | 'recovery', email}` returns `{action_link, hashed_token, verification_type, ...user}`. The raw single-use token is the `?token=` query-string parameter inside `action_link` — it is the same 56-char value as `hashed_token`.
- `POST /verify` server-side takes `{type: 'email', token_hash, email}` (NOT `type: 'magiclink'`) and returns `{access_token, refresh_token, expires_in, ...}`. Verified live: `type: 'magiclink'` on `/verify` returns 403.
- Both endpoints accept Authorization headers: `/admin/generate_link` needs service-role bearer; `/verify` uses the anon key via the `apikey` header.

- [ ] **Step 1: Write failing tests**

Create `tests/unit/auth/gotrue-admin-link.test.ts`:

```ts
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

  it('verifyMagicLink POSTs /verify with type=email and token_hash, returns token pair', async () => {
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
      type: 'email',
      token_hash: 'HASH123',
      email: 'c@t.co',
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
```

- [ ] **Step 2: Run tests, expect fail**

Run: `bun run test:unit -- tests/unit/auth/gotrue-admin-link.test.ts`
Expected: `Cannot find module '@/lib/auth/gotrue-admin-link'`.

- [ ] **Step 3: Implement the client**

Create `src/lib/auth/gotrue-admin-link.ts`:

```ts
// src/lib/auth/gotrue-admin-link.ts
// Thin HTTP client for GoTrue's admin generate_link + verify endpoints.

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

export class GotrueAdminLinkError extends Error {
  constructor(public readonly status: number, message: string, public readonly body: unknown) {
    super(message);
    this.name = 'GotrueAdminLinkError';
  }
}

async function doFetch<T>(path: string, init: RequestInit, headers: Record<string, string>): Promise<T> {
  const res = await fetch(gotrueUrl(path), {
    ...init,
    headers: { 'content-type': 'application/json', ...headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new GotrueAdminLinkError(res.status, `gotrue ${path} failed: ${res.status}`, body);
  }
  return res.json() as Promise<T>;
}

export type LinkType = 'magiclink' | 'recovery';

export interface GenerateLinkResult {
  action_link: string;
  token: string;
  hashed_token: string;
  verification_type: LinkType;
}

export async function generateLink(type: LinkType, email: string): Promise<GenerateLinkResult> {
  const key = serviceKey();
  interface RawResponse { action_link?: string; hashed_token?: string; verification_type?: LinkType }
  const raw = await doFetch<RawResponse>(
    '/admin/generate_link',
    { method: 'POST', body: JSON.stringify({ type, email }) },
    { Authorization: `Bearer ${key}`, apikey: key }
  );
  const actionLink = raw.action_link ?? '';
  const match = /[?&]token=([^&]+)/.exec(actionLink);
  const token = match ? match[1]! : (raw.hashed_token ?? '');
  if (!token) {
    throw new GotrueAdminLinkError(500, 'gotrue generate_link returned no token', raw);
  }
  return {
    action_link: actionLink,
    token,
    hashed_token: raw.hashed_token ?? token,
    verification_type: raw.verification_type ?? type,
  };
}

export interface VerifyMagicLinkResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function verifyMagicLink(tokenHash: string, email: string): Promise<VerifyMagicLinkResult> {
  const res = await doFetch<VerifyMagicLinkResult & { token_type?: string; expires_at?: number }>(
    '/verify',
    { method: 'POST', body: JSON.stringify({ type: 'email', token_hash: tokenHash, email }) },
    { apikey: anonKey() }
  );
  return { access_token: res.access_token, refresh_token: res.refresh_token, expires_in: res.expires_in };
}
```

- [ ] **Step 4: Run tests, all pass**

Run: `bun run test:unit -- tests/unit/auth/gotrue-admin-link.test.ts`
Expected: 5/5 PASS.

- [ ] **Step 5: tsc**

Run: `bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/gotrue-admin-link.ts tests/unit/auth/gotrue-admin-link.test.ts
git commit -m "feat(auth): gotrue-admin-link client (generate_link + verify)"
```

---

## Task 3: `impersonation-cookies.ts` helpers (TDD)

**Files:**
- Create: `src/lib/auth/impersonation-cookies.ts`
- Create: `tests/unit/auth/impersonation-cookies.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/auth/impersonation-cookies.test.ts`:

```ts
// tests/unit/auth/impersonation-cookies.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import type { NextApiResponse } from 'next';

function mkRes(): { res: NextApiResponse; headers: Record<string, string[]> } {
  const headers: Record<string, string[]> = {};
  const res = {
    getHeader: (name: string) => headers[name.toLowerCase()],
    setHeader: (name: string, value: string | string[]) => {
      headers[name.toLowerCase()] = Array.isArray(value) ? value : [value];
    },
  } as unknown as NextApiResponse;
  return { res, headers };
}

describe('impersonation-cookies', () => {
  const origDomain = process.env.COOKIE_DOMAIN;
  afterEach(() => {
    if (origDomain === undefined) delete process.env.COOKIE_DOMAIN;
    else process.env.COOKIE_DOMAIN = origDomain;
  });

  it('setImpersonationCookies writes sb-admin-stash (HttpOnly) and is_impersonating (not HttpOnly)', async () => {
    delete process.env.COOKIE_DOMAIN;
    const { setImpersonationCookies } = await import('@/lib/auth/impersonation-cookies');
    const { res, headers } = mkRes();
    setImpersonationCookies(res, 'stash-uuid-1');
    const cookies = headers['set-cookie'];
    expect(cookies).toHaveLength(2);
    const adminStash = cookies.find((c) => c.startsWith('sb-admin-stash=stash-uuid-1'));
    expect(adminStash).toBeDefined();
    expect(adminStash!).toMatch(/HttpOnly/i);
    const flag = cookies.find((c) => c.startsWith('is_impersonating=1'));
    expect(flag).toBeDefined();
    expect(flag!).not.toMatch(/HttpOnly/i);
  });

  it('clearImpersonationCookies emits dual-scope Max-Age=0 when COOKIE_DOMAIN is set', async () => {
    process.env.COOKIE_DOMAIN = '.isaflow.co.za';
    const { clearImpersonationCookies } = await import('@/lib/auth/impersonation-cookies');
    const { res, headers } = mkRes();
    clearImpersonationCookies(res);
    const cookies = headers['set-cookie'];
    expect(cookies).toHaveLength(4);
    for (const c of cookies) expect(c).toMatch(/Max-Age=0/);
    expect(cookies.filter((c) => /Domain=\.isaflow\.co\.za/.test(c))).toHaveLength(2);
  });

  it('clearImpersonationCookies emits single-scope clears when COOKIE_DOMAIN unset', async () => {
    delete process.env.COOKIE_DOMAIN;
    const { clearImpersonationCookies } = await import('@/lib/auth/impersonation-cookies');
    const { res, headers } = mkRes();
    clearImpersonationCookies(res);
    expect(headers['set-cookie']).toHaveLength(2);
    for (const c of headers['set-cookie']) expect(c).toMatch(/Max-Age=0/);
  });
});
```

- [ ] **Step 2: Run tests, expect fail**

Run: `bun run test:unit -- tests/unit/auth/impersonation-cookies.test.ts`
Expected: `Cannot find module '@/lib/auth/impersonation-cookies'`.

- [ ] **Step 3: Implement**

Create `src/lib/auth/impersonation-cookies.ts`:

```ts
// src/lib/auth/impersonation-cookies.ts
// Cookie helpers for impersonation — mirrors the dual-scope pattern in cookies.ts.
import type { NextApiResponse } from 'next';

export const ADMIN_STASH_COOKIE = 'sb-admin-stash';
export const IS_IMPERSONATING_COOKIE = 'is_impersonating';
const ONE_HOUR_SECS = 3600;

function cookieDomain(): string | undefined {
  const v = process.env.COOKIE_DOMAIN?.trim();
  return v ? v : undefined;
}

function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

function buildFlags(maxAgeSeconds: number, opts: { httpOnly: boolean; domain?: string }): string {
  const parts = [`Path=/`, `Max-Age=${maxAgeSeconds}`, `SameSite=Lax`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (isSecure()) parts.push('Secure');
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  return parts.join('; ');
}

function append(res: NextApiResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookie]);
    return;
  }
  const arr = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  arr.push(cookie);
  res.setHeader('Set-Cookie', arr);
}

export function setImpersonationCookies(res: NextApiResponse, stashId: string): void {
  const domain = cookieDomain();
  append(res, `${ADMIN_STASH_COOKIE}=${stashId}; ${buildFlags(ONE_HOUR_SECS, { httpOnly: true, domain })}`);
  append(res, `${IS_IMPERSONATING_COOKIE}=1; ${buildFlags(ONE_HOUR_SECS, { httpOnly: false, domain })}`);
}

export function clearImpersonationCookies(res: NextApiResponse): void {
  const domain = cookieDomain();
  for (const name of [ADMIN_STASH_COOKIE, IS_IMPERSONATING_COOKIE]) {
    append(res, `${name}=; ${buildFlags(0, { httpOnly: name === ADMIN_STASH_COOKIE })}`);
    if (domain) {
      append(res, `${name}=; ${buildFlags(0, { httpOnly: name === ADMIN_STASH_COOKIE, domain })}`);
    }
  }
}
```

- [ ] **Step 4: Run tests, pass**

Run: `bun run test:unit -- tests/unit/auth/impersonation-cookies.test.ts`
Expected: 3/3 PASS.

- [ ] **Step 5: tsc + commit**

```bash
bunx tsc --noEmit   # exit 0
git add src/lib/auth/impersonation-cookies.ts tests/unit/auth/impersonation-cookies.test.ts
git commit -m "feat(auth): impersonation cookie helpers with dual-scope clears"
```

---

## Task 4: Rewrite `userImpersonationService.ts` (stash-only)

**Files:**
- Modify: `src/modules/admin/services/userImpersonationService.ts`

- [ ] **Step 1: Replace the file**

Overwrite `src/modules/admin/services/userImpersonationService.ts` with:

```ts
/**
 * User Impersonation — stash helpers.
 * Stores the admin's tokens so "Return to my session" can restore them.
 * All session-minting is handled by GoTrue (admin/generate_link + verify).
 */
import { sql } from '@/lib/neon';

const IMPERSONATION_TTL_HOURS = 1;

export interface StashInput {
  adminUserId: string;
  adminAccessToken: string;
  adminRefreshToken: string;
  targetUserId: string;
}

export interface StashRow {
  stash_id: string;
  admin_user_id: string;
  admin_access_token: string;
  admin_refresh_token: string;
  target_user_id: string;
  expires_at: Date;
}

export async function stashAdminTokens(input: StashInput): Promise<string> {
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_HOURS * 60 * 60 * 1000);
  const rows = await sql<{ stash_id: string }>`
    INSERT INTO admin_impersonation_stash (
      admin_user_id, admin_access_token, admin_refresh_token, target_user_id, expires_at
    ) VALUES (
      ${input.adminUserId}, ${input.adminAccessToken}, ${input.adminRefreshToken},
      ${input.targetUserId}, ${expiresAt.toISOString()}
    )
    RETURNING stash_id
  `;
  return String(rows[0]!.stash_id);
}

export async function loadStash(stashId: string): Promise<StashRow | null> {
  const rows = await sql<StashRow>`
    SELECT stash_id, admin_user_id, admin_access_token, admin_refresh_token, target_user_id, expires_at
    FROM admin_impersonation_stash
    WHERE stash_id = ${stashId}::uuid
      AND expires_at > NOW()
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function deleteStash(stashId: string): Promise<void> {
  await sql`DELETE FROM admin_impersonation_stash WHERE stash_id = ${stashId}::uuid`;
}

export interface TargetValidationResult {
  userId: string;
  email: string;
}

export async function validateImpersonationTarget(targetUserId: string): Promise<TargetValidationResult> {
  const rows = await sql<{ id: string; email: string; role: string; is_active: boolean }>`
    SELECT id, email, role, is_active FROM users WHERE id = ${targetUserId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error('TARGET_NOT_FOUND');
  if (!row.is_active) throw new Error('TARGET_INACTIVE');
  if (row.role === 'super_admin') throw new Error('CANNOT_IMPERSONATE_SUPER_ADMIN');
  return { userId: row.id, email: row.email };
}
```

- [ ] **Step 2: tsc — expect errors on old callers**

Run: `bunx tsc --noEmit 2>&1 | head -20`
Expected: compile errors referencing `pages/api/admin/users/[id]/impersonate.ts` and `pages/api/auth/user-impersonate-exchange.ts` — they still import `createUserImpersonationSession` / `signToken` which no longer exist. These will be fixed in Tasks 5 and 9. **Do not fix here.**

- [ ] **Step 3: Commit even though tsc is red**

```bash
git add src/modules/admin/services/userImpersonationService.ts
git commit -m "refactor(auth): userImpersonationService reduced to stash helpers"
```

---

## Task 5: Rewrite `POST /api/admin/users/[id]/impersonate`

**Files:**
- Modify: `pages/api/admin/users/[id]/impersonate.ts`

- [ ] **Step 1: Replace the file**

Overwrite `pages/api/admin/users/[id]/impersonate.ts` with:

```ts
/**
 * POST /api/admin/users/:id/impersonate
 * Super-admin "Login as X" — swaps admin's session for target's via GoTrue
 * magic-link. Admin's tokens are stashed so end-impersonation can restore.
 */
import type { NextApiResponse } from 'next';
import { withAdmin } from '@/modules/admin/middleware/withAdmin';
import type { PlatformAdminRequest } from '@/lib/auth';
import {
  parseCookies,
  setAuthCookies,
  setActiveCompanyCookie,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from '@/lib/auth/cookies';
import { generateLink, verifyMagicLink, GotrueAdminLinkError } from '@/lib/auth/gotrue-admin-link';
import { stashAdminTokens, validateImpersonationTarget } from '@/modules/admin/services/userImpersonationService';
import { setImpersonationCookies } from '@/lib/auth/impersonation-cookies';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

async function handler(req: PlatformAdminRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
    return;
  }
  const targetId = req.query.id;
  if (typeof targetId !== 'string') {
    res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'User id required' } });
    return;
  }

  let target;
  try {
    target = await validateImpersonationTarget(targetId);
  } catch (err) {
    const code = err instanceof Error ? err.message : 'TARGET_INVALID';
    const status = code === 'TARGET_NOT_FOUND' ? 404 : code === 'CANNOT_IMPERSONATE_SUPER_ADMIN' ? 403 : 400;
    res.status(status).json({ success: false, error: { code, message: code } });
    return;
  }

  const cookies = parseCookies(req);
  const adminAccess = cookies[ACCESS_COOKIE];
  const adminRefresh = cookies[REFRESH_COOKIE];
  if (!adminAccess || !adminRefresh) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Admin session cookies required' } });
    return;
  }

  let targetTokens;
  try {
    const link = await generateLink('magiclink', target.email);
    targetTokens = await verifyMagicLink(link.token, target.email);
  } catch (err) {
    log.error(
      'impersonate: gotrue flow failed',
      { message: err instanceof Error ? err.message : String(err), status: err instanceof GotrueAdminLinkError ? err.status : undefined },
      'Admin'
    );
    res.status(502).json({ success: false, error: { code: 'GOTRUE_FAILURE', message: 'Unable to start impersonation session' } });
    return;
  }

  const stashId = await stashAdminTokens({
    adminUserId: req.user.id,
    adminAccessToken: adminAccess,
    adminRefreshToken: adminRefresh,
    targetUserId: target.userId,
  });

  await sql`
    INSERT INTO admin_audit_log (actor_id, action, target_user_id, metadata)
    VALUES (
      ${req.user.id},
      'impersonation_start',
      ${target.userId},
      ${JSON.stringify({ stash_id: stashId, target_email: target.email })}::jsonb
    )
  `;

  setAuthCookies(res, {
    accessToken: targetTokens.access_token,
    refreshToken: targetTokens.refresh_token,
    expiresIn: targetTokens.expires_in,
  });

  const memberships = await sql<{ company_id: string }>`
    SELECT company_id FROM company_users
    WHERE user_id = ${target.userId}
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `;
  if (memberships.length > 0) setActiveCompanyCookie(res, memberships[0]!.company_id);

  setImpersonationCookies(res, stashId);

  res.status(200).json({ success: true, data: { redirect: '/accounting' } });
}

export default withAdmin(handler);
```

- [ ] **Step 2: tsc + commit**

Run: `bunx tsc --noEmit 2>&1 | head -20`
Expected: the error on `impersonate.ts` is now gone. The error on `user-impersonate-exchange.ts` remains — to be deleted in Task 9.

```bash
git add 'pages/api/admin/users/[id]/impersonate.ts'
git commit -m "feat(admin): impersonate endpoint rewritten on GoTrue magic-link + stash"
```

---

## Task 6: `POST /api/auth/end-impersonation`

**Files:**
- Create: `pages/api/auth/end-impersonation.ts`

- [ ] **Step 1: Create the endpoint**

```ts
// pages/api/auth/end-impersonation.ts
// Restores the admin's stashed session cookies; deletes the stash row.
import type { NextApiHandler } from 'next';
import {
  parseCookies,
  setAuthCookies,
  setActiveCompanyCookie,
  clearAuthCookies,
} from '@/lib/auth/cookies';
import { ADMIN_STASH_COOKIE, clearImpersonationCookies } from '@/lib/auth/impersonation-cookies';
import { loadStash, deleteStash } from '@/modules/admin/services/userImpersonationService';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

const handler: NextApiHandler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required' } });
  }

  const stashId = parseCookies(req)[ADMIN_STASH_COOKIE];
  if (!stashId) {
    return res.status(400).json({ success: false, error: { code: 'NOT_IMPERSONATING', message: 'No active impersonation' } });
  }

  const stash = await loadStash(stashId);
  if (!stash) {
    clearAuthCookies(res);
    clearImpersonationCookies(res);
    return res.status(401).json({ success: false, error: { code: 'STASH_EXPIRED', message: 'Impersonation expired — please log in again' } });
  }

  setAuthCookies(res, {
    accessToken: stash.admin_access_token,
    refreshToken: stash.admin_refresh_token,
    expiresIn: 3600,
  });

  const memberships = await sql<{ company_id: string }>`
    SELECT company_id FROM company_users
    WHERE user_id = ${stash.admin_user_id}
    ORDER BY is_default DESC, created_at ASC
    LIMIT 1
  `;
  if (memberships.length > 0) setActiveCompanyCookie(res, memberships[0]!.company_id);

  clearImpersonationCookies(res);

  await sql`
    INSERT INTO admin_audit_log (actor_id, action, target_user_id, metadata)
    VALUES (
      ${stash.admin_user_id},
      'impersonation_end',
      ${stash.target_user_id},
      ${JSON.stringify({ stash_id: stashId })}::jsonb
    )
  `;

  await deleteStash(stashId);

  log.info('impersonation ended', { admin: stash.admin_user_id, target: stash.target_user_id }, 'Admin');

  return res.status(200).json({ success: true, data: { redirect: '/admin' } });
};

export default handler;
```

- [ ] **Step 2: tsc + commit**

Run: `bunx tsc --noEmit 2>&1 | head -10`
Expected: no new errors. User-impersonate-exchange.ts error remains.

```bash
git add pages/api/auth/end-impersonation.ts
git commit -m "feat(auth): POST /api/auth/end-impersonation restores admin session"
```

---

## Task 7: `ImpersonationBanner.tsx` UI + wire into `AppLayout`

**Files:**
- Create: `src/components/layout/ImpersonationBanner.tsx`
- Modify: `src/components/layout/AppLayout.tsx`

- [ ] **Step 1: Create the banner component**

Create `src/components/layout/ImpersonationBanner.tsx`:

```tsx
// src/components/layout/ImpersonationBanner.tsx
// Orange bar shown when an admin is impersonating another user.
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[1]!) : null;
}

export function ImpersonationBanner() {
  const router = useRouter();
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setActive(readCookie('is_impersonating') === '1');
  }, [router.asPath]);

  const handleReturn = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/auth/end-impersonation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const json = await res.json() as { success: boolean; data?: { redirect: string }; error?: { message: string } };
      if (json.success && json.data?.redirect) {
        window.location.href = json.data.redirect;
      } else {
        alert(json.error?.message ?? 'Failed to end impersonation');
        setBusy(false);
      }
    } catch {
      alert('Network error. Please try again.');
      setBusy(false);
    }
  }, []);

  if (!active) return null;

  return (
    <div
      role="status"
      className="w-full bg-orange-500 text-white px-4 py-2 flex items-center justify-between text-sm font-medium shadow"
    >
      <span>Impersonating another user. Actions are audit-logged.</span>
      <button
        className="ml-4 px-3 py-1 rounded-md bg-white text-orange-700 font-semibold hover:bg-orange-50 disabled:opacity-50"
        onClick={handleReturn}
        disabled={busy}
      >
        {busy ? 'Returning…' : 'Return to my session'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Wire into AppLayout**

Read `src/components/layout/AppLayout.tsx`. Find the JSX return — add the banner as the first child before the header. Minimal pattern:

```tsx
import { ImpersonationBanner } from './ImpersonationBanner';
// …inside the return:
return (
  <>
    <ImpersonationBanner />
    {/* existing header and content */}
  </>
);
```

- [ ] **Step 3: tsc + commit**

Run: `bunx tsc --noEmit 2>&1 | head -10`
Expected: no new errors on these files.

```bash
git add src/components/layout/ImpersonationBanner.tsx src/components/layout/AppLayout.tsx
git commit -m "feat(ui): ImpersonationBanner renders on is_impersonating cookie"
```

---

## Task 8: Rewrite admin password reset on GoTrue recovery

**Files:**
- Modify: `src/modules/admin/services/adminUserActionsService.ts`

- [ ] **Step 1: Read the existing `initiateAdminPasswordReset`**

Run: `grep -n "initiateAdminPasswordReset\|generateResetToken\|password_reset_tokens" src/modules/admin/services/adminUserActionsService.ts`

Identify the function's signature, the INSERT into `password_reset_tokens` (to be removed), and the audit-log entry (to be preserved).

- [ ] **Step 2: Replace the function body**

Replace the `generateResetToken` import at the top:
```ts
import { generateLink } from '@/lib/auth/gotrue-admin-link';
// Remove: import { generateResetToken } from '@/lib/auth';
```

Replace the function body to:

```ts
export async function initiateAdminPasswordReset(actorId: string, userId: string): Promise<{ reset_link: string }> {
  type UserRow = { id: string; email: string; role: string };
  const rows = await sql<UserRow>`
    SELECT id, email, role FROM users WHERE id = ${userId} LIMIT 1
  `;
  const target = rows[0];
  if (!target) throw new Error('USER_NOT_FOUND');
  if (target.role === 'super_admin') throw new Error('CANNOT_RESET_SUPER_ADMIN');

  const { action_link } = await generateLink('recovery', target.email);

  await sql`
    INSERT INTO admin_audit_log (actor_id, action, target_user_id, metadata)
    VALUES (
      ${actorId},
      'password_reset_initiated',
      ${userId},
      ${JSON.stringify({ target_email: target.email })}::jsonb
    )
  `;

  return { reset_link: action_link };
}
```

If the existing signature or return shape differs (extra fields required by callers), adapt: keep existing argument order + add any extra returned fields. The core change is `generateResetToken()` → `generateLink('recovery', target.email)`, and removing the INSERT into `password_reset_tokens`.

- [ ] **Step 3: Check callers**

Run: `grep -rn "initiateAdminPasswordReset" src/ pages/ | head -5`

If any caller reads `.token`, `.reset_url`, or similar, update to `.reset_link`.

- [ ] **Step 4: tsc + commit**

Run: `bunx tsc --noEmit 2>&1 | head -20`
Expected: only the `user-impersonate-exchange.ts` error from Task 4 remains. Nothing new.

```bash
git add src/modules/admin/services/adminUserActionsService.ts
git commit -m "feat(admin): password reset uses GoTrue generate_link(recovery)"
```

---

## Task 9: Delete dead files

**Files:**
- Delete: `src/lib/auth/jwt.ts`
- Delete: `src/lib/auth/session.ts`
- Delete: `src/lib/auth/password.ts`
- Delete: `pages/api/auth/user-impersonate-exchange.ts`
- Delete: `pages/impersonate.tsx`
- Modify: `src/lib/auth/index.ts`

- [ ] **Step 1: Verify no imports remain**

```bash
grep -rn "from ['\"]@/lib/auth/jwt['\"]\|from ['\"]@/lib/auth/session['\"]\|from ['\"]@/lib/auth/password['\"]\|@/lib/auth.*hashPassword\|@/lib/auth.*checkPasswordStrength\|@/lib/auth.*generateResetToken" src/ pages/ tests/ 2>/dev/null
```

Expected: empty. If any match, STOP and trace the reference.

- [ ] **Step 2: Remove the transitional re-exports from `src/lib/auth/index.ts`**

Open and remove the block:
```ts
// ── Transitional exports (remove when Stage 3 rewrites register.ts) ──────────
export { hashPassword, checkPasswordStrength, generateResetToken } from './password';
```

- [ ] **Step 3: Delete the files**

```bash
git rm src/lib/auth/jwt.ts
git rm src/lib/auth/session.ts
git rm src/lib/auth/password.ts
git rm pages/api/auth/user-impersonate-exchange.ts
git rm pages/impersonate.tsx
```

- [ ] **Step 4: tsc — must finally be clean**

Run: `bunx tsc --noEmit`
Expected: exit 0. **If not, STOP and report** — every error from Tasks 4–8 should be resolved here.

- [ ] **Step 5: Run unit test suite**

Run: `bun run test:unit 2>&1 | tail -10`
Expected: all pass except the pre-existing `slowQuery.test.ts` failure.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(auth): delete jwt.ts / session.ts / password.ts and impersonation token exchange"
```

---

## Task 10: Integration test — impersonation flow

**Files:**
- Create: `tests/integration/impersonation-flow.int.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/integration/impersonation-flow.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import { adminCreateUser, adminDeleteUser, signIn } from '@/lib/auth/gotrue';
import { verifyToken } from '@/lib/auth/gotrue';

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_ADMIN_DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL;
if (!JWT_SECRET || !DATABASE_URL || !MIGRATION_ADMIN_DATABASE_URL) {
  throw new Error('JWT_SECRET + DATABASE_URL + MIGRATION_ADMIN_DATABASE_URL required');
}

const seedPool = new Pool({ connectionString: MIGRATION_ADMIN_DATABASE_URL, max: 2 });
const ADMIN_EMAIL = `imp-admin-${Date.now()}@test.local`;
const TARGET_EMAIL = `imp-target-${Date.now()}@test.local`;
const PW = 'ImpTest!Secret123';

function mkReq(opts: { method: string; cookies: Record<string, string>; query?: Record<string, string>; body?: unknown }) {
  const cookieHeader = Object.entries(opts.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    method: opts.method,
    headers: { cookie: cookieHeader, 'x-admin-request': 'true' },
    cookies: opts.cookies,
    query: opts.query ?? {},
    body: opts.body,
    url: '/test',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
}

function mkRes() {
  let status = 200;
  let body: unknown;
  const setCookies: string[] = [];
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

function cookieValue(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1]!;
  }
  return null;
}

describe('impersonation flow (integration)', () => {
  let adminId: string;
  let targetId: string;

  beforeAll(async () => {
    const adminUser = await adminCreateUser({ email: ADMIN_EMAIL, password: PW, email_confirm: true });
    const targetUser = await adminCreateUser({ email: TARGET_EMAIL, password: PW, email_confirm: true });
    adminId = adminUser.id;
    targetId = targetUser.id;

    await seedPool.query(
      `INSERT INTO users (id, email, role, is_active) VALUES
         ($1, $2, 'super_admin', true),
         ($3, $4, 'viewer', true)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`,
      [adminId, ADMIN_EMAIL, targetId, TARGET_EMAIL]
    );
  });

  afterAll(async () => {
    await seedPool.query(`DELETE FROM admin_audit_log WHERE actor_id IN ($1,$2) OR target_user_id IN ($1,$2)`, [adminId, targetId]);
    await seedPool.query(`DELETE FROM admin_impersonation_stash WHERE admin_user_id IN ($1,$2) OR target_user_id IN ($1,$2)`, [adminId, targetId]);
    await seedPool.query(`DELETE FROM users WHERE id IN ($1,$2)`, [adminId, targetId]);
    try { await adminDeleteUser(adminId); } catch { /* best-effort */ }
    try { await adminDeleteUser(targetId); } catch { /* best-effort */ }
    await seedPool.end();
  });

  it('start → target session + stash + audit, end → admin restored', async () => {
    const adminToks = await signIn(ADMIN_EMAIL, PW);

    const { default: impersonateHandler } = await import('../../pages/api/admin/users/[id]/impersonate');
    const r1 = mkRes();
    await impersonateHandler(
      mkReq({
        method: 'POST',
        cookies: {
          'sb-access-token': adminToks.access_token,
          'sb-refresh-token': adminToks.refresh_token,
        },
        query: { id: targetId },
      }),
      r1.res
    );
    expect(r1.status).toBe(200);
    expect((r1.body as { data: { redirect: string } }).data.redirect).toBe('/accounting');

    const newAccess = cookieValue(r1.cookies, 'sb-access-token');
    expect(newAccess).toBeTruthy();
    const stashId = cookieValue(r1.cookies, 'sb-admin-stash');
    expect(stashId).toBeTruthy();
    expect(cookieValue(r1.cookies, 'is_impersonating')).toBe('1');

    const claims = await verifyToken(newAccess!);
    expect(claims.sub).toBe(targetId);

    const { rows: stashRows } = await seedPool.query(
      `SELECT admin_user_id, target_user_id FROM admin_impersonation_stash WHERE stash_id = $1::uuid`,
      [stashId]
    );
    expect(stashRows).toHaveLength(1);
    expect(stashRows[0].admin_user_id).toBe(adminId);
    expect(stashRows[0].target_user_id).toBe(targetId);

    const { rows: startRows } = await seedPool.query(
      `SELECT action FROM admin_audit_log WHERE actor_id = $1 AND target_user_id = $2 AND action = 'impersonation_start'`,
      [adminId, targetId]
    );
    expect(startRows.length).toBeGreaterThan(0);

    const { default: endHandler } = await import('../../pages/api/auth/end-impersonation');
    const r2 = mkRes();
    await endHandler(
      mkReq({
        method: 'POST',
        cookies: { 'sb-admin-stash': stashId! },
      }),
      r2.res
    );
    expect(r2.status).toBe(200);
    expect((r2.body as { data: { redirect: string } }).data.redirect).toBe('/admin');

    const restoredAccess = cookieValue(r2.cookies, 'sb-access-token');
    expect(restoredAccess).toBeTruthy();
    const restoredClaims = await verifyToken(restoredAccess!);
    expect(restoredClaims.sub).toBe(adminId);

    expect(r2.cookies.some((c) => /sb-admin-stash=;.*Max-Age=0/.test(c))).toBe(true);
    expect(r2.cookies.some((c) => /is_impersonating=;.*Max-Age=0/.test(c))).toBe(true);

    const { rows: afterRows } = await seedPool.query(
      `SELECT 1 FROM admin_impersonation_stash WHERE stash_id = $1::uuid`,
      [stashId]
    );
    expect(afterRows).toHaveLength(0);

    const { rows: endRows } = await seedPool.query(
      `SELECT action FROM admin_audit_log WHERE actor_id = $1 AND target_user_id = $2 AND action = 'impersonation_end'`,
      [adminId, targetId]
    );
    expect(endRows.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test**

```bash
set -a; source .env.local 2>/dev/null; set +a
bunx vitest run --config vitest.integration.config.ts tests/integration/impersonation-flow.int.test.ts 2>&1 | tail -15
```

Expected: 1/1 PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/impersonation-flow.int.test.ts
git commit -m "test(integration): full impersonation round-trip (start → end)"
```

---

## Task 11: Integration test — admin password reset

**Files:**
- Create: `tests/integration/admin-password-reset.int.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/integration/admin-password-reset.int.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminCreateUser, adminDeleteUser } from '@/lib/auth/gotrue';
import { initiateAdminPasswordReset } from '@/modules/admin/services/adminUserActionsService';

const MIGRATION_ADMIN_DATABASE_URL = process.env.MIGRATION_ADMIN_DATABASE_URL;
if (!MIGRATION_ADMIN_DATABASE_URL) throw new Error('MIGRATION_ADMIN_DATABASE_URL required');

const seedPool = new Pool({ connectionString: MIGRATION_ADMIN_DATABASE_URL, max: 1 });
const ADMIN_EMAIL = `reset-admin-${Date.now()}@test.local`;
const TARGET_EMAIL = `reset-target-${Date.now()}@test.local`;
const PW = 'ResetTest!Secret123';

describe('admin password reset (integration)', () => {
  let adminId: string;
  let targetId: string;

  beforeAll(async () => {
    const a = await adminCreateUser({ email: ADMIN_EMAIL, password: PW, email_confirm: true });
    const t = await adminCreateUser({ email: TARGET_EMAIL, password: PW, email_confirm: true });
    adminId = a.id;
    targetId = t.id;
    await seedPool.query(
      `INSERT INTO users (id, email, role, is_active) VALUES
         ($1, $2, 'super_admin', true),
         ($3, $4, 'viewer', true)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`,
      [adminId, ADMIN_EMAIL, targetId, TARGET_EMAIL]
    );
  });

  afterAll(async () => {
    await seedPool.query(`DELETE FROM admin_audit_log WHERE actor_id IN ($1,$2) OR target_user_id IN ($1,$2)`, [adminId, targetId]);
    await seedPool.query(`DELETE FROM users WHERE id IN ($1,$2)`, [adminId, targetId]);
    try { await adminDeleteUser(adminId); } catch { /* best-effort */ }
    try { await adminDeleteUser(targetId); } catch { /* best-effort */ }
    await seedPool.end();
  });

  it('returns a recovery action_link and writes an audit row', async () => {
    const result = await initiateAdminPasswordReset(adminId, targetId);
    expect(result.reset_link).toMatch(/\/auth\/v1\/verify\?.*type=recovery/);

    const { rows } = await seedPool.query(
      `SELECT action FROM admin_audit_log WHERE actor_id = $1 AND target_user_id = $2 AND action = 'password_reset_initiated'`,
      [adminId, targetId]
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run**

```bash
set -a; source .env.local 2>/dev/null; set +a
bunx vitest run --config vitest.integration.config.ts tests/integration/admin-password-reset.int.test.ts 2>&1 | tail -10
```

Expected: 1/1 PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/admin-password-reset.int.test.ts
git commit -m "test(integration): admin password reset via GoTrue recovery link"
```

---

## Task 12: Dev smoke test (manual)

Pure manual verification. No commits.

- [ ] **Step 1: Restart dev server with new env**

Run: `bun run dev`

- [ ] **Step 2: Log in as super_admin in the browser**

Open dev URL `/login`, log in with a `users.role='super_admin'` account.

- [ ] **Step 3: Navigate to users list and click "Login as" on a non-super_admin user**

Expected: browser redirects to `/accounting`. Orange banner appears at top: "Impersonating another user. Actions are audit-logged. [Return to my session]".

- [ ] **Step 4: Browse around as the impersonated user**

Verify: no super_admin menu; companies visible are only the target's.

- [ ] **Step 5: Click "Return to my session"**

Expected: redirect to `/admin`, banner gone, super_admin menu restored.

- [ ] **Step 6: Verify DB state**

```bash
psql "$MIGRATION_ADMIN_DATABASE_URL" -c "SELECT COUNT(*) FROM admin_impersonation_stash; SELECT action, created_at FROM admin_audit_log WHERE action LIKE 'impersonation%' ORDER BY created_at DESC LIMIT 4"
```

Expected: 0 rows in stash. At least one `impersonation_start` and one `impersonation_end` in audit log.

- [ ] **Step 7: Password reset smoke**

- Admin UI → pick a user → "Reset password".
- Admin UI shows a reset link (copy to clipboard).
- Open the link in incognito browser.
- GoTrue-hosted password form loads → set new password → redirects back.
- Log in with the new password → success.

---

## Task 13: Production deploy (gated)

> Production deploys require Hein's explicit approval and must run outside business hours (08:00–17:00 SAST). This task assumes approval has been granted and the deploy window is open.

- [ ] **Step 1: Apply migration 355 on prod as `supabase_admin`**

```bash
psql 'postgresql://supabase_admin:a23f6104debd1d3e88e8f00c0067f22f@100.96.203.105:5437/isaflow?sslmode=disable' \
  -f scripts/migrations/sql/355_admin_impersonation_stash.sql
CHECKSUM=$(sha256sum scripts/migrations/sql/355_admin_impersonation_stash.sql | awk '{print $1}')
psql 'postgresql://migration_admin:398ae138816873a688e534b28ba9116b@100.96.203.105:5437/isaflow?sslmode=disable' \
  -c "INSERT INTO schema_migrations (version, name, checksum) VALUES ('355', '355_admin_impersonation_stash.sql', '$CHECKSUM') ON CONFLICT DO NOTHING RETURNING name"
```

Expected: `CREATE TABLE`, `CREATE INDEX`, `GRANT`; tracking row inserted.

- [ ] **Step 2: Tag rollback anchor**

```bash
git tag -a v-pre-phase3c-impersonation -m "Pre-Phase3c impersonation-port rollback anchor"
git push origin v-pre-phase3c-impersonation
```

- [ ] **Step 3: Deploy**

```bash
bash scripts/deploy.sh
```

Expected: clean build + service restart, `isaflow.service` healthy.

- [ ] **Step 4: Prod smoke (Hein)**

Same checklist as Task 12 but on `https://admin.isaflow.co.za` / `https://app.isaflow.co.za`.

- [ ] **Step 5: Update memory**

Append to `~/.claude/projects/-home-hein-Workspace-IsaFlow/memory/project_supabase_cutover.md`, a new "Phase 3c" block summarising:
- Impersonation migrated to GoTrue magic-link + stash; jwt.ts/session.ts/password.ts deleted.
- Admin password reset migrated to GoTrue recovery link.
- Migration 355 on prod, rollback tag `v-pre-phase3c-impersonation`.
- Follow-up: drop `user_sessions` table after a week of confirmed non-use.

---

## Self-Review

**1. Spec coverage:**
- Architecture 1 (magic-link + stash): Tasks 2, 3, 4, 5. ✓
- Architecture 2 (end impersonation): Task 6. ✓
- Architecture 3 (admin password reset): Task 8. ✓
- Architecture 4 (file deletion): Task 9. ✓
- Banner UI: Task 7. ✓
- Migration 355: Task 1. ✓
- Audit-log writes: Tasks 5, 6, 8. ✓
- Cookie dual-scope clears: Task 3 helpers + Tasks 5, 6 use them. ✓
- Integration tests (2): Tasks 10, 11. ✓
- Unit tests (2): Tasks 2, 3. ✓
- Manual smoke: Task 12. ✓
- Prod deploy: Task 13. ✓

**2. Placeholder scan:** No TBD / TODO / vague phrases. Every code block complete. Task 8 Step 2 includes "ADAPT if signature differs" — that's prescriptive fallback, not a placeholder; the minimum required change is stated explicitly.

**3. Type consistency:**
- `GenerateLinkResult.token` defined in Task 2, consumed in Task 5. ✓
- `VerifyMagicLinkResult` defined in Task 2, consumed in Task 5. ✓
- `StashInput` / `StashRow` / `TargetValidationResult` defined in Task 4, consumed in Tasks 5 + 6. ✓
- `ADMIN_STASH_COOKIE`, `IS_IMPERSONATING_COOKIE` defined in Task 3, consumed in Tasks 6 + 7. ✓
- `initiateAdminPasswordReset` returns `{reset_link: string}` in Task 8, asserted in Task 11. ✓

No gaps. Plan ready for execution.
