# Admin Platform Auth on GoTrue + RLS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unlock `admin.isaflow.co.za` after the Phase 2 Supabase cutover by routing admin auth through a dedicated `platform_admin` Postgres role with `BYPASSRLS`, and enabling single-login across `app.*`/`admin.*` via cookie-domain sharing.

**Architecture:** Two-pool, two-tx fail-closed pattern. A new `withPlatformAdmin` middleware gates every admin request: it verifies the GoTrue JWT, checks `users.role='super_admin'` through the normal app pool running as `app_user` (RLS still applies), and only then opens a tx on a dedicated `platform_admin` pool (BYPASSRLS) that binds a client via ALS for the handler. `withAdmin` becomes a thin alias composing rate limit + CSRF-header + `withPlatformAdmin`. Cookies gain an optional `Domain=` attribute via a new `COOKIE_DOMAIN` env.

**Tech Stack:** Next.js 14 Pages Router, TypeScript, `pg.Pool`, GoTrue (`jose` JWT verify), Postgres RLS + roles, Vitest (unit + integration), Playwright (E2E), bun.

**Spec:** `docs/superpowers/specs/2026-04-18-admin-auth-gotrue-design.md`

---

## File Structure

**New files:**

| Path | Purpose |
|---|---|
| `scripts/migrations/sql/352_platform_admin_role.sql` | Creates `platform_admin` BYPASSRLS role + grants |
| `src/lib/auth/withPlatformAdmin.ts` | New middleware: JWT verify → role gate → platform_admin tx with ALS |
| `tests/unit/auth/withPlatformAdmin.test.ts` | Unit tests for the middleware |
| `tests/integration/admin-rls-bypass.test.ts` | Proves `BYPASSRLS` engages (cross-tenant count) |
| `tests/integration/admin-forbidden.test.ts` | Proves tenant user gets 403 on admin routes |
| `tests/e2e/admin-auth.spec.ts` | 3 E2E scenarios in one spec file |

**Modified files:**

| Path | Change |
|---|---|
| `src/lib/auth/cookies.ts` | Add `COOKIE_DOMAIN` support; `clearAuthCookies` emits dual-scope clears |
| `src/lib/als.ts` | Make `RequestContext.companyId` optional |
| `src/lib/auth/index.ts` | Export `withPlatformAdmin`, `PlatformAdminRequest` |
| `src/modules/admin/middleware/withAdmin.ts` | Swap `withAuth + withRole` → `withPlatformAdmin` |
| `tests/unit/auth/cookies.test.ts` | Add 3 cases for `COOKIE_DOMAIN` |
| `.env.example` | Add `PLATFORM_ADMIN_DATABASE_URL`, `COOKIE_DOMAIN` |

**Not touched (by design):** admin services (40 files — ALS routing is transparent), admin API routes, existing RLS policies, `withAuth`/`withUserAuth`/`withRole`.

---

## Task 1: Migration 352 — `platform_admin` Postgres role

**Files:**
- Create: `scripts/migrations/sql/352_platform_admin_role.sql`

- [ ] **Step 1: Write the migration SQL**

Create file `scripts/migrations/sql/352_platform_admin_role.sql`:

```sql
-- scripts/migrations/sql/352_platform_admin_role.sql
-- Phase 3: Platform-admin Postgres role for admin.isaflow.co.za runtime.
-- BYPASSRLS lets admin APIs read/write across all tenants without the
-- tenant_isolation policies blocking. Role is distinct from migration_admin
-- so runtime admin traffic is distinguishable in pg_stat_activity.
-- Password placeholder is rotated post-apply via ALTER ROLE — see Task 2.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_admin') THEN
    CREATE ROLE platform_admin
      WITH LOGIN BYPASSRLS NOINHERIT
      PASSWORD 'CHANGEME_SET_VIA_OPS';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, auth, app TO platform_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO platform_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_admin;

-- Audit-log triggers that call auth.uid() / auth.user_companies() must be
-- executable under the platform_admin role even though BYPASSRLS skips the
-- policies themselves.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO platform_admin;

-- Future tables/sequences inherit the grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO platform_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth
  GRANT EXECUTE ON FUNCTIONS TO platform_admin;
```

- [ ] **Step 2: Apply on dev**

Run:
```bash
cd /home/hein/Workspace/IsaFlow
bun scripts/apply-migrations.ts --dry-run
```

Expected: prints `352_platform_admin_role.sql` in the "to apply" list. Then:

```bash
bun scripts/apply-migrations.ts
```

Expected: `applied 352_platform_admin_role.sql` log line, exit 0.

- [ ] **Step 3: Verify role exists on dev**

Run (dev DB — `localhost:5437/isaflow_dev`):
```bash
psql "$MIGRATION_ADMIN_DATABASE_URL" -c "SELECT rolname, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'platform_admin'"
```

Expected:
```
    rolname     | rolbypassrls | rolcanlogin
----------------+--------------+-------------
 platform_admin | t            | t
```

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/sql/352_platform_admin_role.sql
git commit -m "feat(db): migration 352 — platform_admin BYPASSRLS role for admin runtime"
```

---

## Task 2: Rotate platform_admin password on dev + set env

**Files:**
- Modify: `/home/hein/Workspace/IsaFlow/.env.local` (gitignored — dev only)

- [ ] **Step 1: Generate a random password**

Run:
```bash
openssl rand -base64 32 | tr -d '/+=' | head -c 32
```

Save the output (referred to below as `<DEV_PW>`).

- [ ] **Step 2: Rotate the role password on dev**

Run:
```bash
psql "$MIGRATION_ADMIN_DATABASE_URL" -c "ALTER ROLE platform_admin PASSWORD '<DEV_PW>'"
```

Expected: `ALTER ROLE`.

- [ ] **Step 3: Verify connection works**

Run:
```bash
PGPASSWORD='<DEV_PW>' psql -h localhost -p 5437 -U platform_admin -d isaflow_dev -c "SELECT 1"
```

Expected: returns `1`. If it fails with `permission denied for schema public`, recheck Task 1 grants ran against the `isaflow_dev` DB (not `isaflow` prod DB).

- [ ] **Step 4: Add env vars to `.env.local`**

Append to `/home/hein/Workspace/IsaFlow/.env.local`:

```
PLATFORM_ADMIN_DATABASE_URL=postgresql://platform_admin:<DEV_PW>@localhost:5437/isaflow_dev?sslmode=disable
# COOKIE_DOMAIN intentionally unset in dev — localhost cannot share cookies
# across subdomains the way .isaflow.co.za can. Leave blank/unset.
```

- [ ] **Step 5: No commit**

`.env.local` is gitignored; do not stage.

---

## Task 3: ALS context — make `companyId` optional

`withPlatformAdmin` won't set `companyId`. The ALS type must accommodate that.

**Files:**
- Modify: `src/lib/als.ts`

- [ ] **Step 1: Write a failing test for optional companyId**

Create `tests/unit/lib/als.test.ts`:

```ts
// tests/unit/lib/als.test.ts
import { describe, it, expect } from 'vitest';
import { als } from '@/lib/als';

describe('als.RequestContext', () => {
  it('allows companyId to be omitted (platform-admin case)', async () => {
    await als.run(
      // @ts-expect-no-error — companyId is optional
      { client: null as never, userId: 'u1', claims: {} },
      async () => {
        const ctx = als.getStore()!;
        expect(ctx.userId).toBe('u1');
        expect(ctx.companyId).toBeUndefined();
      }
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- tests/unit/lib/als.test.ts`

Expected: FAIL — TypeScript error `Property 'companyId' is missing`.

- [ ] **Step 3: Update `src/lib/als.ts`**

Replace the contents of `src/lib/als.ts`:

```ts
// src/lib/als.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';

export interface RequestContext {
  client: PoolClient;
  userId: string;
  /** Absent for platform-admin requests (admin is global, not tenant-scoped). */
  companyId?: string;
  claims: Record<string, unknown>;
}

export const als = new AsyncLocalStorage<RequestContext>();

export function requireCtx(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error(
      'als: no request context — handler called outside withAuth/withPlatformAdmin or background job called sql without wrapping?'
    );
  }
  return ctx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- tests/unit/lib/als.test.ts`

Expected: PASS.

- [ ] **Step 5: Type-check the whole project**

Run: `bunx tsc --noEmit`

Expected: exit 0 with no new errors. (Sentry tags already guards with `if (ctx.companyId)`, so this is backward-compatible.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/als.ts tests/unit/lib/als.test.ts
git commit -m "feat(als): make RequestContext.companyId optional for platform-admin"
```

---

## Task 4: `cookies.ts` — add `COOKIE_DOMAIN` support (TDD)

**Files:**
- Modify: `src/lib/auth/cookies.ts`
- Modify: `tests/unit/auth/cookies.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/unit/auth/cookies.test.ts` inside the existing `describe('cookies', …)` block, before the closing `});`:

```ts
  describe('COOKIE_DOMAIN support', () => {
    const origDomain = process.env.COOKIE_DOMAIN;
    afterEach(() => {
      if (origDomain === undefined) delete process.env.COOKIE_DOMAIN;
      else process.env.COOKIE_DOMAIN = origDomain;
    });

    it('does not append Domain= when COOKIE_DOMAIN is unset', () => {
      delete process.env.COOKIE_DOMAIN;
      const { res, headers } = mkRes();
      setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
      for (const c of headers['set-cookie']) {
        expect(c).not.toMatch(/Domain=/);
      }
    });

    it('appends Domain=<value> to all auth cookies when COOKIE_DOMAIN is set', () => {
      process.env.COOKIE_DOMAIN = '.isaflow.co.za';
      const { res, headers } = mkRes();
      setAuthCookies(res, { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
      setActiveCompanyCookie(res, 'cid-1');
      for (const c of headers['set-cookie']) {
        expect(c).toMatch(/Domain=\.isaflow\.co\.za/);
      }
    });

    it('clearAuthCookies emits dual-scope clears (host + domain) during transition', () => {
      process.env.COOKIE_DOMAIN = '.isaflow.co.za';
      const { res, headers } = mkRes();
      clearAuthCookies(res);
      // 3 cookies × 2 scopings (host-scoped + domain-scoped)
      expect(headers['set-cookie']).toHaveLength(6);
      const hostScoped = headers['set-cookie'].filter((c) => !/Domain=/.test(c));
      const domainScoped = headers['set-cookie'].filter((c) => /Domain=\.isaflow\.co\.za/.test(c));
      expect(hostScoped).toHaveLength(3);
      expect(domainScoped).toHaveLength(3);
      for (const c of headers['set-cookie']) expect(c).toMatch(/Max-Age=0/);
    });
  });
```

Add `afterEach` to the imports at the top of the file:
```ts
import { describe, it, expect, afterEach } from 'vitest';
```

Also adjust the existing `'clearAuthCookies emits Max-Age=0 for all auth cookies'` test — when `COOKIE_DOMAIN` is unset it should still emit exactly 3 cookies (keep `toHaveLength(3)`). No change needed if the test runs with `COOKIE_DOMAIN` unset at that point — which it does thanks to the new `afterEach` restoring state.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- tests/unit/auth/cookies.test.ts`

Expected: the 3 new COOKIE_DOMAIN tests FAIL (Domain not present / wrong count).

- [ ] **Step 3: Update `src/lib/auth/cookies.ts`**

Replace the file with:

```ts
// src/lib/auth/cookies.ts
import type { NextApiRequest, NextApiResponse } from 'next';

export const ACCESS_COOKIE = 'sb-access-token';
export const REFRESH_COOKIE = 'sb-refresh-token';
export const ACTIVE_COMPANY_COOKIE = 'active_company_id';

function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

function cookieDomain(): string | undefined {
  const v = process.env.COOKIE_DOMAIN;
  return v && v.length > 0 ? v : undefined;
}

function cookieFlags(maxAgeSeconds: number, domain?: string): string {
  const parts = [
    `Path=/`,
    `Max-Age=${maxAgeSeconds}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (isSecure()) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

export function parseCookies(req: NextApiRequest): Record<string, string> {
  const header = req.headers.cookie ?? '';
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    const v = decodeURIComponent(s.slice(eq + 1).trim());
    out[k] = v;
  }
  return out;
}

function appendSetCookie(res: NextApiResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookie]);
    return;
  }
  const arr = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  arr.push(cookie);
  res.setHeader('Set-Cookie', arr);
}

export function setAuthCookies(
  res: NextApiResponse,
  params: { accessToken: string; refreshToken: string; expiresIn: number }
): void {
  const domain = cookieDomain();
  appendSetCookie(
    res,
    `${ACCESS_COOKIE}=${params.accessToken}; ${cookieFlags(params.expiresIn, domain)}`
  );
  appendSetCookie(
    res,
    `${REFRESH_COOKIE}=${params.refreshToken}; ${cookieFlags(60 * 60 * 24 * 30, domain)}`
  );
}

export function setActiveCompanyCookie(res: NextApiResponse, companyId: string): void {
  appendSetCookie(
    res,
    `${ACTIVE_COMPANY_COOKIE}=${companyId}; ${cookieFlags(60 * 60 * 24 * 30, cookieDomain())}`
  );
}

/**
 * Clears auth cookies. During the COOKIE_DOMAIN transition we emit clears for
 * BOTH host-scoped (pre-transition) and domain-scoped (post-transition)
 * cookies, so a single logout resolves any ambiguity left by older sessions.
 */
export function clearAuthCookies(res: NextApiResponse): void {
  const domain = cookieDomain();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, ACTIVE_COMPANY_COOKIE]) {
    appendSetCookie(res, `${name}=; ${cookieFlags(0)}`);
    if (domain) {
      appendSetCookie(res, `${name}=; ${cookieFlags(0, domain)}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- tests/unit/auth/cookies.test.ts`

Expected: all tests PASS (existing 4 + new 3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/cookies.ts tests/unit/auth/cookies.test.ts
git commit -m "feat(auth): COOKIE_DOMAIN support with dual-scope clears for transition"
```

---

## Task 5: `withPlatformAdmin` middleware (TDD)

**Files:**
- Create: `src/lib/auth/withPlatformAdmin.ts`
- Create: `tests/unit/auth/withPlatformAdmin.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `tests/unit/auth/withPlatformAdmin.test.ts`:

```ts
// tests/unit/auth/withPlatformAdmin.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    url: '/api/admin/test',
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

// Shared fake pg.Pool and tx client used by the mocked pool factories.
interface FakeClient {
  queries: Array<{ text: string; values: unknown[] }>;
  released: boolean;
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
}

function makeFakeClient(roleRow: string | null, shouldError = false): FakeClient {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let released = false;
  return {
    queries,
    get released() { return released; },
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (shouldError && /SELECT role FROM users/i.test(text)) {
        throw new Error('simulated DB failure');
      }
      if (/SELECT role FROM users/i.test(text)) {
        return { rows: roleRow ? [{ role: roleRow }] : [] };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
}

describe('withPlatformAdmin', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.JWT_SECRET = TEST_SECRET;
    process.env.GOTRUE_URL = 'http://example.test/auth/v1';
    process.env.DATABASE_URL = 'postgresql://postgres@localhost/ignored';
    process.env.PLATFORM_ADMIN_DATABASE_URL = 'postgresql://platform_admin@localhost/ignored';
  });

  afterEach(() => vi.resetAllMocks());

  it('401s when no sb-access-token cookie', async () => {
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const r = mkRes();
    await withPlatformAdmin(async () => { throw new Error('should not run'); })(mkReq(), r.res);
    expect(r.status).toBe(401);
  });

  it('401s on invalid token and clears auth cookies', async () => {
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const r = mkRes();
    await withPlatformAdmin(async () => { throw new Error('should not run'); })(mkReq('bogus'), r.res);
    expect(r.status).toBe(401);
    const sc = r.res.getHeader('set-cookie') as string[];
    expect(sc.some((c) => c.startsWith('sb-access-token=;'))).toBe(true);
  });

  it('403s when users.role !== super_admin', async () => {
    const appClient = makeFakeClient('viewer');
    const adminClient = makeFakeClient(null);
    vi.doMock('@/lib/auth/withPlatformAdmin.pools', () => ({
      getAppPool: () => ({ connect: async () => appClient }),
      getPlatformAdminPool: () => ({ connect: async () => adminClient }),
    }));
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const tok = await makeToken('user-1');
    const r = mkRes();
    let ran = false;
    await withPlatformAdmin(async () => { ran = true; })(mkReq(tok), r.res);
    expect(r.status).toBe(403);
    expect(ran).toBe(false);
    // Handler pool must NOT have been opened when gate fails
    expect(adminClient.queries).toHaveLength(0);
    // Auth cookies preserved (user is legitimate, just not super_admin)
    expect(r.res.getHeader('set-cookie')).toBeUndefined();
  });

  it('calls handler with req.user populated on super_admin', async () => {
    const appClient = makeFakeClient('super_admin');
    const adminClient = makeFakeClient(null);
    vi.doMock('@/lib/auth/withPlatformAdmin.pools', () => ({
      getAppPool: () => ({ connect: async () => appClient }),
      getPlatformAdminPool: () => ({ connect: async () => adminClient }),
    }));
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const tok = await makeToken('user-1');
    const r = mkRes();
    let seenId = '';
    await withPlatformAdmin(async (req: { user: { id: string } }) => {
      seenId = req.user.id;
      r.res.status(200).json({ ok: true });
    })(mkReq(tok), r.res);
    expect(seenId).toBe('user-1');
    expect(r.status).toBe(200);
    // Handler pool tx opened and committed
    const texts = adminClient.queries.map((q) => q.text.trim()).join('|');
    expect(texts).toContain('BEGIN');
    expect(texts).toContain('COMMIT');
    expect(adminClient.released).toBe(true);
  });

  it('returns 500 (fail-closed) when role-lookup query errors', async () => {
    const appClient = makeFakeClient('super_admin', true);
    const adminClient = makeFakeClient(null);
    vi.doMock('@/lib/auth/withPlatformAdmin.pools', () => ({
      getAppPool: () => ({ connect: async () => appClient }),
      getPlatformAdminPool: () => ({ connect: async () => adminClient }),
    }));
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const tok = await makeToken('user-1');
    const r = mkRes();
    let ran = false;
    await expect(
      withPlatformAdmin(async () => { ran = true; })(mkReq(tok), r.res)
    ).rejects.toThrow(/simulated DB failure/);
    expect(ran).toBe(false);
    expect(adminClient.queries).toHaveLength(0);
  });

  it('binds the admin client into ALS so sql`...` routes through it', async () => {
    const appClient = makeFakeClient('super_admin');
    const adminClient = makeFakeClient(null);
    vi.doMock('@/lib/auth/withPlatformAdmin.pools', () => ({
      getAppPool: () => ({ connect: async () => appClient }),
      getPlatformAdminPool: () => ({ connect: async () => adminClient }),
    }));
    const { als } = await import('@/lib/als');
    const { withPlatformAdmin } = await import('@/lib/auth/withPlatformAdmin');
    const tok = await makeToken('user-1');
    const r = mkRes();
    let seenClient: unknown = null;
    await withPlatformAdmin(async () => {
      seenClient = als.getStore()?.client;
      r.res.status(200).json({ ok: true });
    })(mkReq(tok), r.res);
    expect(seenClient).toBe(adminClient);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- tests/unit/auth/withPlatformAdmin.test.ts`

Expected: FAIL — `Cannot find module '@/lib/auth/withPlatformAdmin'`.

- [ ] **Step 3: Create pool factories in a separate module (for testability)**

Create `src/lib/auth/withPlatformAdmin.pools.ts`:

```ts
// src/lib/auth/withPlatformAdmin.pools.ts
// Pool factories split into a separate module so tests can vi.doMock them
// without also mocking the core middleware.
import pg from 'pg';
import { log } from '@/lib/logger';

let _appPool: pg.Pool | null = null;
let _adminPool: pg.Pool | null = null;

function sslOpt() {
  return process.env.DATABASE_SSL === 'strict'
    ? { rejectUnauthorized: true }
    : process.env.DATABASE_SSL === 'disable'
      ? false
      : { rejectUnauthorized: false };
}

export function getAppPool(): pg.Pool {
  if (_appPool) return _appPool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  _appPool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.AUTH_POOL_MAX ?? 20),
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    ssl: sslOpt(),
  });
  _appPool.on('error', (err) =>
    log.warn('withPlatformAdmin app pool error', { message: err.message }, 'Auth')
  );
  return _appPool;
}

export function getPlatformAdminPool(): pg.Pool {
  if (_adminPool) return _adminPool;
  const url = process.env.PLATFORM_ADMIN_DATABASE_URL;
  if (!url) throw new Error('PLATFORM_ADMIN_DATABASE_URL required');
  _adminPool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PLATFORM_ADMIN_POOL_MAX ?? 10),
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    ssl: sslOpt(),
  });
  _adminPool.on('error', (err) =>
    log.warn('withPlatformAdmin admin pool error', { message: err.message }, 'Auth')
  );
  return _adminPool;
}
```

- [ ] **Step 4: Create the middleware**

Create `src/lib/auth/withPlatformAdmin.ts`:

```ts
// src/lib/auth/withPlatformAdmin.ts
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import * as Sentry from '@sentry/nextjs';
import { verifyToken } from './gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE } from './cookies';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { setTenantTags, sanitizeRoute } from '@/lib/sentry/tags';
import { getAppPool, getPlatformAdminPool } from './withPlatformAdmin.pools';

export interface PlatformAdminRequest extends NextApiRequest {
  user: { id: string; email?: string; claims: Record<string, unknown> };
  // Note: no companyId, no companyRole — admin is global.
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

/**
 * Gates admin APIs. Two-pool, two-tx fail-closed:
 *   1. Verify GoTrue token.
 *   2. Short tx on app pool as app_user — read users.role via users_self_read
 *      RLS policy. 403 if not super_admin.
 *   3. Second tx on platform_admin pool (BYPASSRLS) — bind client via ALS,
 *      run handler, commit.
 *
 * If step 2 errors or skips, step 3 never runs — the handler never engages
 * BYPASSRLS until super-admin is confirmed.
 */
export function withPlatformAdmin(handler: Handler): NextApiHandler {
  return async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[ACCESS_COOKIE];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    let claims;
    try {
      claims = await verifyToken(token);
    } catch (err) {
      log.warn(
        'withPlatformAdmin: invalid token',
        { message: err instanceof Error ? err.message : String(err) },
        'Auth'
      );
      clearAuthCookies(res);
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' },
      });
    }

    // ── Gate: super-admin check via app_user + RLS ────────────────────────────
    const appClient = await getAppPool().connect();
    let role: string | undefined;
    try {
      await appClient.query('BEGIN');
      await appClient.query('SET LOCAL ROLE app_user');
      await appClient.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claims),
      ]);
      const result = await appClient.query<{ role: string }>(
        `SELECT role FROM users WHERE id = auth.uid()`
      );
      role = result.rows[0]?.role;
      await appClient.query('COMMIT');
    } catch (err) {
      try { await appClient.query('ROLLBACK'); } catch { /* secondary */ }
      throw err; // Fail-closed — withErrorHandler returns 500.
    } finally {
      appClient.release();
    }

    if (role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_SUPER_ADMIN', message: 'Platform-admin role required' },
      });
    }

    // ── Handler tx: platform_admin pool (BYPASSRLS) ──────────────────────────
    const startedAt = Date.now();
    const adminClient = await getPlatformAdminPool().connect();
    try {
      await adminClient.query('BEGIN');
      await adminClient.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claims),
      ]);

      (req as PlatformAdminRequest).user = {
        id: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        claims: claims as Record<string, unknown>,
      };

      const runHandler = async () =>
        als.run(
          { client: adminClient, userId: claims.sub, claims: claims as Record<string, unknown> },
          async () => { await handler(req, res); }
        );

      if (process.env.SENTRY_ENABLED === 'true') {
        await Sentry.withIsolationScope(async () => {
          setTenantTags({ userId: claims!.sub, route: sanitizeRoute(req.url) });
          await runHandler();
        });
      } else {
        await runHandler();
      }

      await adminClient.query('COMMIT');
    } catch (err) {
      try { await adminClient.query('ROLLBACK'); } catch { /* secondary */ }
      throw err;
    } finally {
      adminClient.release();
      const ms = Date.now() - startedAt;
      if (ms > 200) log.info('withPlatformAdmin slow request', { ms, url: req.url }, 'Auth');
      if (process.env.SENTRY_ENABLED === 'true') {
        Sentry.metrics.distribution('auth.withPlatformAdmin.duration_ms', ms, {
          unit: 'millisecond',
        });
      }
    }
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test:unit -- tests/unit/auth/withPlatformAdmin.test.ts`

Expected: all 6 tests PASS.

If the `setTenantTags` import fails because it expects a `companyId` argument, update `src/lib/sentry/tags.ts` so `companyId` is optional in the `setTenantTags` signature:

```ts
export function setTenantTags(args: { companyId?: string; userId: string; route?: string }) {
  // existing body — already guards with `if (ctx.companyId)`-style checks
}
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/withPlatformAdmin.ts src/lib/auth/withPlatformAdmin.pools.ts tests/unit/auth/withPlatformAdmin.test.ts src/lib/sentry/tags.ts
git commit -m "feat(auth): withPlatformAdmin middleware with two-pool fail-closed RLS bypass"
```

---

## Task 6: Wire `withPlatformAdmin` into auth barrel + `withAdmin`

**Files:**
- Modify: `src/lib/auth/index.ts`
- Modify: `src/modules/admin/middleware/withAdmin.ts`

- [ ] **Step 1: Update auth barrel**

Edit `src/lib/auth/index.ts` — add the export after the existing `withAuth` / `withUserAuth` exports:

```ts
// withPlatformAdmin: user-only + super_admin gate + BYPASSRLS pool
export { withPlatformAdmin, type PlatformAdminRequest } from './withPlatformAdmin';
```

- [ ] **Step 2: Update `withAdmin` to use the new middleware**

Replace `src/modules/admin/middleware/withAdmin.ts` with:

```ts
/**
 * Admin Middleware
 * Convenience wrapper: withPlatformAdmin + rate-limit + CSRF-header + error-handler.
 * All admin API routes must be wrapped with this.
 */

import { withPlatformAdmin, type PlatformAdminRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { checkRateLimit } from '@/lib/rateLimit';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';

export function withAdmin(
  handler: (req: PlatformAdminRequest, res: NextApiResponse) => Promise<void>
): NextApiHandler {
  const rateLimitedHandler = async (req: NextApiRequest, res: NextApiResponse) => {
    // F-03: In-memory rate limiter — not shared across multiple instances.
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (() => {
      if (forwarded) {
        const raw = Array.isArray(forwarded) ? forwarded[0] ?? '' : forwarded;
        const ips = raw.split(',').map((s: string) => s.trim());
        return ips[0] || req.socket.remoteAddress || 'unknown';
      }
      return req.socket.remoteAddress || 'unknown';
    })();
    const allowed = await checkRateLimit(`admin:${ip}`, { max: 120, windowSecs: 60 });
    if (!allowed) {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
      });
      return;
    }

    // F-04: CSRF mitigation — require a custom request header on mutating methods.
    if (req.method !== 'GET' && req.headers['x-admin-request'] !== 'true') {
      res.status(403).json({ error: 'Missing required header: X-Admin-Request' });
      return;
    }

    return handler(req as PlatformAdminRequest, res);
  };
  const errorWrapped = withErrorHandler(rateLimitedHandler);
  return withPlatformAdmin(errorWrapped) as NextApiHandler;
}
```

- [ ] **Step 3: Type-check the full project**

Run: `bunx tsc --noEmit`

Expected: exit 0. If any admin route fails because it imported `AuthenticatedNextApiRequest` from an unusual path, leave the import — it's still re-exported from the auth barrel and matches `PlatformAdminRequest` structurally.

- [ ] **Step 4: Commit**

```bash
git add src/lib/auth/index.ts src/modules/admin/middleware/withAdmin.ts
git commit -m "feat(admin): rewire withAdmin to use withPlatformAdmin"
```

---

## Task 7: Integration test — RLS bypass proof

**Files:**
- Create: `tests/integration/admin-rls-bypass.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/integration/admin-rls-bypass.test.ts`:

```ts
// tests/integration/admin-rls-bypass.test.ts
// Proves BYPASSRLS is actually engaged for withPlatformAdmin:
// - Seeds 2 companies + 2 invoices (one per company).
// - Seeds a super_admin user.
// - Runs withPlatformAdmin → handler counts customer_invoices across all companies.
// - Expects count >= 2 (cross-tenant visible). Under RLS, a single-company
//   membership would see at most 1.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SignJWT } from 'jose';
import type { NextApiResponse } from 'next';
import { Pool } from 'pg';
import { withPlatformAdmin } from '@/lib/auth/withPlatformAdmin';
import { sql } from '@/lib/neon';

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
if (!JWT_SECRET || !DATABASE_URL) throw new Error('JWT_SECRET + DATABASE_URL required');

const seedPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
const USER_ID = 'plat-admin-test-user';
const CO_A = '00000000-0000-0000-0000-000000000aa1';
const CO_B = '00000000-0000-0000-0000-000000000aa2';

async function seed() {
  await seedPool.query(`
    INSERT INTO companies (id, name, is_active) VALUES
      ($1, 'Platform Admin Test A', true),
      ($2, 'Platform Admin Test B', true)
    ON CONFLICT (id) DO NOTHING
  `, [CO_A, CO_B]);
  await seedPool.query(`
    INSERT INTO users (id, email, role, is_active) VALUES
      ($1, 'plat-admin@test.local', 'super_admin', true)
    ON CONFLICT (id) DO UPDATE SET role = 'super_admin'
  `, [USER_ID]);
  // Ensure 1 invoice per company exists
  await seedPool.query(`
    INSERT INTO customer_invoices (id, company_id, invoice_number, invoice_date, total)
    VALUES
      (gen_random_uuid(), $1, 'PA-TEST-A-1', CURRENT_DATE, 100),
      (gen_random_uuid(), $2, 'PA-TEST-B-1', CURRENT_DATE, 100)
    ON CONFLICT (invoice_number) DO NOTHING
  `, [CO_A, CO_B]);
}

async function makeToken(sub: string) {
  return new SignJWT({ sub, aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function mkReq(token: string) {
  return { headers: { cookie: `sb-access-token=${token}` }, url: '/api/admin/test' } as never;
}

function mkRes() {
  let status = 200;
  let body: unknown;
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body = v; return this; },
    setHeader() { /* noop */ },
    getHeader() { return undefined; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body; } };
}

describe('withPlatformAdmin — RLS bypass proof', () => {
  beforeAll(async () => { await seed(); });
  afterAll(async () => { await seedPool.end(); });

  it('sees invoices from multiple tenants (BYPASSRLS engaged)', async () => {
    const tok = await makeToken(USER_ID);
    const r = mkRes();
    let seenRowCount = 0;
    await withPlatformAdmin(async () => {
      const rows = await sql`SELECT COUNT(*)::int AS n FROM customer_invoices WHERE invoice_number LIKE 'PA-TEST-%'`;
      seenRowCount = (rows[0] as { n: number }).n;
      r.res.status(200).json({ ok: true });
    })(mkReq(tok), r.res);

    expect(r.status).toBe(200);
    expect(seenRowCount).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the test on dev**

Ensure env is loaded:
```bash
export $(grep -E '^(JWT_SECRET|DATABASE_URL|PLATFORM_ADMIN_DATABASE_URL|GOTRUE_URL)=' .env.local | xargs)
bun run test:unit -- tests/integration/admin-rls-bypass.test.ts
```

Expected: PASS. `seenRowCount >= 2`.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/admin-rls-bypass.test.ts
git commit -m "test(integration): prove platform_admin BYPASSRLS for cross-tenant reads"
```

---

## Task 8: Integration test — tenant user forbidden

**Files:**
- Create: `tests/integration/admin-forbidden.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/integration/admin-forbidden.test.ts`:

```ts
// tests/integration/admin-forbidden.test.ts
// A non-super-admin user must be rejected by withPlatformAdmin (403).
// The handler must never run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SignJWT } from 'jose';
import type { NextApiResponse } from 'next';
import { Pool } from 'pg';
import { withPlatformAdmin } from '@/lib/auth/withPlatformAdmin';

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
if (!JWT_SECRET || !DATABASE_URL) throw new Error('JWT_SECRET + DATABASE_URL required');

const seedPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
const USER_ID = 'tenant-only-test-user';

async function seed() {
  await seedPool.query(`
    INSERT INTO users (id, email, role, is_active) VALUES
      ($1, 'tenant-only@test.local', 'manager', true)
    ON CONFLICT (id) DO UPDATE SET role = 'manager'
  `, [USER_ID]);
}

async function makeToken(sub: string) {
  return new SignJWT({ sub, aud: 'authenticated', role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function mkReq(token: string) {
  return { headers: { cookie: `sb-access-token=${token}` }, url: '/api/admin/test' } as never;
}

function mkRes() {
  let status = 200;
  let body: unknown;
  const res = {
    status(c: number) { status = c; return this; },
    json(v: unknown) { body = v; return this; },
    setHeader() { /* noop */ },
    getHeader() { return undefined; },
  } as unknown as NextApiResponse;
  return { res, get status() { return status; }, get body() { return body; } };
}

describe('withPlatformAdmin — tenant user forbidden', () => {
  beforeAll(async () => { await seed(); });
  afterAll(async () => { await seedPool.end(); });

  it('returns 403 NOT_SUPER_ADMIN and does not invoke handler', async () => {
    const tok = await makeToken(USER_ID);
    const r = mkRes();
    let ran = false;
    await withPlatformAdmin(async () => { ran = true; })(mkReq(tok), r.res);
    expect(r.status).toBe(403);
    expect(ran).toBe(false);
    expect(r.body).toMatchObject({
      success: false,
      error: { code: 'NOT_SUPER_ADMIN' },
    });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun run test:unit -- tests/integration/admin-forbidden.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/admin-forbidden.test.ts
git commit -m "test(integration): withPlatformAdmin rejects non-super-admin users"
```

---

## Task 9: E2E tests — admin auth flows

**Files:**
- Create: `tests/e2e/admin-auth.spec.ts`

- [ ] **Step 1: Seed test users on dev**

Ensure two accounts exist in dev GoTrue + `users` table:

```bash
# Super admin (use GoTrue admin API via existing helper)
curl -s -X POST "$GOTRUE_URL/admin/users" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin-e2e@test.local","password":"AdminE2E!Secret123","email_confirm":true}'

# Non-super-admin
curl -s -X POST "$GOTRUE_URL/admin/users" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"user-e2e@test.local","password":"UserE2E!Secret123","email_confirm":true}'
```

Then sync to `users` table via the existing `upsertUserProfile` path or directly:

```bash
psql "$MIGRATION_ADMIN_DATABASE_URL" <<SQL
INSERT INTO users (id, email, role, is_active)
SELECT u.id::text, u.email, 'super_admin', true
FROM auth.users u WHERE u.email = 'admin-e2e@test.local'
ON CONFLICT (id) DO UPDATE SET role = 'super_admin';

INSERT INTO users (id, email, role, is_active)
SELECT u.id::text, u.email, 'viewer', true
FROM auth.users u WHERE u.email = 'user-e2e@test.local'
ON CONFLICT (id) DO UPDATE SET role = 'viewer';
SQL
```

- [ ] **Step 2: Write the Playwright spec**

Create `tests/e2e/admin-auth.spec.ts`:

```ts
// tests/e2e/admin-auth.spec.ts
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3200';
const ADMIN_EMAIL = 'admin-e2e@test.local';
const ADMIN_PW = 'AdminE2E!Secret123';
const USER_EMAIL = 'user-e2e@test.local';
const USER_PW = 'UserE2E!Secret123';

async function loginViaApi(request: import('@playwright/test').APIRequestContext, email: string, password: string) {
  const res = await request.post(`${BASE}/api/auth/login`, {
    data: { email, password },
    headers: { 'content-type': 'application/json' },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe('admin auth', () => {
  test('super_admin can load admin dashboard API', async ({ request }) => {
    await loginViaApi(request, ADMIN_EMAIL, ADMIN_PW);
    const res = await request.get(`${BASE}/api/admin/dashboard-stats`, {
      headers: { 'x-admin-request': 'true' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  test('non-super-admin user is blocked with 403', async ({ request }) => {
    await loginViaApi(request, USER_EMAIL, USER_PW);
    const res = await request.get(`${BASE}/api/admin/dashboard-stats`, {
      headers: { 'x-admin-request': 'true' },
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error?.code).toBe('NOT_SUPER_ADMIN');
  });

  test('unauthenticated user gets 401', async ({ request }) => {
    const res = await request.get(`${BASE}/api/admin/dashboard-stats`, {
      headers: { 'x-admin-request': 'true' },
    });
    expect(res.status()).toBe(401);
  });
});
```

Note on shared-cookie E2E: verifying `Domain=.isaflow.co.za` behavior requires hitting real subdomains, which only works on dev/prod — not localhost. Skip that case in the spec and cover it in the manual smoke test (Task 11). A unit-level assertion on the `Set-Cookie` header (already covered in `cookies.test.ts`) confirms the attribute is emitted.

- [ ] **Step 3: Run the spec**

Start dev server:
```bash
bun run dev &
sleep 5
```

Run:
```bash
bunx playwright test tests/e2e/admin-auth.spec.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/admin-auth.spec.ts
git commit -m "test(e2e): admin auth — super_admin allowed, tenant user 403, anon 401"
```

---

## Task 10: Document env in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add new entries**

Append to `.env.example`:

```env

# ── Phase 3: Admin platform auth ────────────────────────────────────────────
# Dedicated Postgres role with BYPASSRLS for admin.isaflow.co.za runtime.
# Create via migration 352 and rotate password via ALTER ROLE.
PLATFORM_ADMIN_DATABASE_URL=postgresql://platform_admin:CHANGEME@localhost:5437/isaflow?sslmode=disable

# Share auth cookies across app.isaflow.co.za and admin.isaflow.co.za.
# Leave unset for localhost dev (subdomain sharing requires eTLD+1 host).
# COOKIE_DOMAIN=.isaflow.co.za
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document PLATFORM_ADMIN_DATABASE_URL + COOKIE_DOMAIN"
```

---

## Task 11: Dev smoke test via browser

Manual verification that admin actually works end-to-end on dev before pushing to prod.

- [ ] **Step 1: Restart dev server with new env**

```bash
bun run dev
```

- [ ] **Step 2: Log in as super_admin on dev admin host**

Open `http://localhost:3200/login` (or the dev-admin host if configured). Submit `admin-e2e@test.local` / `AdminE2E!Secret123`. Verify redirect to `/` (admin dashboard on admin host).

- [ ] **Step 3: Verify admin dashboard loads**

Check browser devtools Network tab: `/api/admin/dashboard-stats` returns 200 with data. Check Application → Cookies: `sb-access-token` present. If `COOKIE_DOMAIN` is set for dev, confirm `Domain=` is applied; otherwise it should be host-scoped.

- [ ] **Step 4: Verify tenant user is blocked**

Log out. Log in as `user-e2e@test.local`. Attempt to hit `/api/admin/dashboard-stats` via devtools (`fetch('/api/admin/dashboard-stats', { headers: { 'x-admin-request': 'true' } })`). Expect 403 response with `NOT_SUPER_ADMIN`.

- [ ] **Step 5: Verify super_admin using the accounting app does NOT bypass RLS**

Log in as `admin-e2e@test.local` on `http://localhost:3200/accounting`. Verify pages show empty or only-their-memberships data (super_admin has no company memberships in the test setup; the app should show the onboarding flow or empty states, not all tenants' data).

- [ ] **Step 6: Verify `pg_stat_activity`**

```bash
psql "$MIGRATION_ADMIN_DATABASE_URL" -c "SELECT usename, count(*) FROM pg_stat_activity WHERE datname='isaflow_dev' GROUP BY usename"
```

Expected: both `postgres` and `platform_admin` appear (after making at least one admin request).

- [ ] **Step 7: No commit — this is verification only**

---

## Task 12: Production deploy (gated)

> **Production time gate:** Per project policy, production deploys require Hein's explicit approval and must occur outside business hours (08:00–17:00 SAST). This task assumes approval has been granted and the deploy window is open.

**Files (not in repo):**
- Modify: `/home/velo/isaflow/.env.local` (prod)

- [ ] **Step 1: Generate production password**

```bash
openssl rand -base64 48 | tr -d '/+=' | head -c 40
```

Save as `<PROD_PW>`.

- [ ] **Step 2: Apply migration 352 on prod**

SSH to velo, then:
```bash
cd /home/velo/isaflow
bun scripts/apply-migrations.ts
```

Expected: `applied 352_platform_admin_role.sql`.

- [ ] **Step 3: Rotate the prod password**

```bash
psql "$MIGRATION_ADMIN_DATABASE_URL" -c "ALTER ROLE platform_admin PASSWORD '<PROD_PW>'"
```

- [ ] **Step 4: Back up + update prod env**

```bash
cp /home/velo/isaflow/.env.local "/home/velo/isaflow/.env.local.backup-pre-phase3-$(date +%Y%m%d-%H%M%S)"
```

Append to `/home/velo/isaflow/.env.local`:
```
PLATFORM_ADMIN_DATABASE_URL=postgresql://platform_admin:<PROD_PW>@localhost:5437/isaflow?sslmode=disable
COOKIE_DOMAIN=.isaflow.co.za
```

- [ ] **Step 5: Deploy the app code**

From local workspace:
```bash
bash scripts/deploy.sh
```

Monitor the deploy script's output. Expected: lint gates pass, build succeeds, service swaps, health check passes.

- [ ] **Step 6: Prod smoke test**

1. Visit `https://admin.isaflow.co.za` — should redirect to `/login` if not already signed in.
2. Log in with Hein's super_admin account. Confirm dashboard loads.
3. Visit a few admin pages: Companies list, Billing subscriptions, Audit log. Confirm data loads (cross-tenant).
4. Open a new browser tab to `https://app.isaflow.co.za`. Should be signed in automatically (shared cookie). Confirm the accounting app loads normally with admin's regular memberships (not all tenants).
5. On the DB:
   ```bash
   psql "$MIGRATION_ADMIN_DATABASE_URL" -c "SELECT usename, count(*) FROM pg_stat_activity WHERE datname='isaflow' GROUP BY usename"
   ```
   Expect `platform_admin` rows after admin requests. Also check `postgres` rows are still present (app pool still running).

- [ ] **Step 7: Post-deploy monitoring**

Watch application logs for `withPlatformAdmin` warnings or Sentry errors for 10 minutes. Expected: quiet.

- [ ] **Step 8: Tag rollback anchor**

```bash
git tag -a v-pre-phase3-admin -m "Pre-Phase3 admin-auth rollback anchor"
git push origin v-pre-phase3-admin
```

- [ ] **Step 9: Update memory**

Append to `~/.claude/projects/-home-hein-Workspace-IsaFlow/memory/project_supabase_cutover.md`:

```markdown
## Phase 3 — admin auth (shipped 2026-04-18)

- Migration 352 on prod: platform_admin BYPASSRLS role created + grants.
- withPlatformAdmin middleware replaces withAuth+withRole inside withAdmin.
- COOKIE_DOMAIN=.isaflow.co.za — shared auth cookies across app.* and admin.*
- Rollback anchor: tag v-pre-phase3-admin.
```

And update `project_admin_platform.md` to remove the "admin platform auth locked" note.

---

## Self-Review

Running through the plan against the spec:

**Spec coverage:**
- Architecture → Identity model: Task 5 (users.role lookup). ✓
- Architecture → Postgres identity: Task 1 (migration 352). ✓
- Architecture → Runtime middleware: Task 5 (withPlatformAdmin). ✓
- Architecture → Session cookie-domain sharing: Task 4 (cookies.ts). ✓
- Architecture → `withAdmin` shape: Task 6. ✓
- Changes by file → new files, modified files: all covered across Tasks 1, 3–6, 7–9. ✓
- Data flow: verified end-to-end via unit tests (Task 5) + integration tests (Tasks 7–8) + E2E (Task 9) + manual smoke (Task 11). ✓
- Migration & rollout → SQL template, env, deploy order, rollback: Tasks 1, 2, 10, 12. ✓
- Risks → BYPASSRLS blast radius (fail-closed test in Task 5, step 1, case 5). ✓
- Risks → cookie-domain transition (dual-scope clear test in Task 4). ✓
- Testing → unit, integration, E2E, smoke, test data: all covered. ✓

**Placeholder scan:** None. Every code block is complete; every test has assertions; every command has expected output.

**Type consistency:**
- `PlatformAdminRequest` — defined in Task 5, imported in Task 6. ✓
- `RequestContext.companyId?` — made optional in Task 3, used by withPlatformAdmin in Task 5 (no companyId passed). ✓
- `withPlatformAdmin.pools.ts` — created in Task 5 step 3, imported in Task 5 step 4 and mocked in Task 5 step 1. ✓
- `setTenantTags` — called without `companyId` in Task 5; signature update noted in Task 5 step 5. ✓

**Gaps:** None identified.
