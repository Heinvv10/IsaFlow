# Phase 4B — Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining security gaps from Phase 3 — Neon-backed rate limiter, hybrid CSRF, additive CSP, Zod MVP on 14 handlers, legacy cookie removal.

**Architecture:** Three execution waves. Wave α lands independent infrastructure (rate-limit migration + backend rewrite, CSP directives, legacy cookie removal) in parallel. Wave β lands CSRF sequentially (infra before route application). Wave γ applies Zod to 14 handlers via two parallel subagents.

**Tech Stack:** Next.js 14 · TypeScript (strict) · Neon Postgres (`sql` tagged templates) · Vitest · `zod@^4.3.6` (already installed). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-04-15-phase4b-security-hardening-design.md`

**Autonomy envelope:** Wave α runs unattended (additive, reversible). Hard stop after α. Wave β requires human review of CSRF middleware diff before dispatch. Hard stop after β. Wave γ dispatches 2 concurrent Zod subagents after spec primitives are in place.

---

## Per-task workflow (applies to every task)

```
1. Create worktree: git worktree add ../isaflow-<BL> master -b fix/<BL>-<slug>
2. Read the relevant spec section + CLAUDE.md.
3. Write failing test first (RED).
4. Run `bunx vitest run <test-path>` → confirm FAIL.
5. Implement minimum code to pass.
6. Run test → confirm PASS.
7. Run `bunx tsc --noEmit` → zero new errors.
8. Commit on branch (NOT master) with the prescribed message template.
9. Report diff + status to controller.
10. Controller rebases onto latest master, reviews diff + CLAUDE.md compliance,
    FF-merges, removes worktree, marks task complete.
```

**Migration numbers** start at **331** (330 was BL-23). Advance sequentially as tasks add migrations.

**Commit message template:** `fix(<BL>): <one-line summary>` followed by a brief body, ending with `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.

---

## File Structure

### New files
- `scripts/migrations/sql/331_rate_limit_counters.sql` — Wave α
- `src/lib/auth/csrf.ts` — Wave β
- `src/lib/auth/withCsrf.ts` — Wave β
- `src/lib/schemas/common.ts` — Wave γ
- `tests/integration/api/csrf.test.ts` — Wave β
- `tests/integration/csp-headers.test.ts` — Wave α
- `tests/integration/api/zod-validation.test.ts` — Wave γ

### Modified files
- `src/lib/rateLimit.ts` — Wave α (backend rewrite)
- `src/lib/apiFetch.ts` — Wave β (CSRF header injection)
- `src/lib/auth/sessionHelpers.ts` — Wave α (legacy cookie removal)
- `middleware.ts` — Wave α (legacy cookie removal) + Wave β (CSRF cookie issuance)
- `next.config.js` — Wave α (CSP directives)
- `tests/unit/lib/rateLimit.test.ts` — Wave α (extend)
- 14 handler files listed in Wave γ tasks.

---

# WAVE 4B-α — Parallel infrastructure (4 tasks)

All four can run concurrently in separate worktrees. Each is self-contained with one commit.

## Task α.1: Neon-backed rate limiter (BL-21)

**Files:**
- Create: `scripts/migrations/sql/331_rate_limit_counters.sql`
- Modify: `src/lib/rateLimit.ts`
- Test: `tests/unit/lib/rateLimit.test.ts` (extend)

- [ ] **Step 1: Write the migration**

Create `scripts/migrations/sql/331_rate_limit_counters.sql`:
```sql
-- BL-21: persistent rate-limit counters shared across pods.
-- Replaces the per-process LRU-only limiter (S-005).
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key TEXT PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rl_window_start ON rate_limit_counters (window_start);
```

- [ ] **Step 2: Apply migration to dev**

```bash
cd /home/hein/Workspace/isaflow-BL-21
export $(grep DATABASE_URL .env.local | xargs)
bun run db:migrate 2>&1 | tail -5
```
Expected: `Applied 1 new migration(s).`

- [ ] **Step 3: Write the failing test**

Extend `tests/unit/lib/rateLimit.test.ts` with a new `describe` block:
```typescript
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { sql } from '@/lib/neon';
import { checkRateLimit } from '@/lib/rateLimit';

describe('checkRateLimit — Neon-backed persistence (BL-21)', () => {
  const KEY = 'test:rl:bl21';

  beforeAll(async () => {
    await sql`DELETE FROM rate_limit_counters WHERE key = ${KEY}`;
  });

  afterEach(async () => {
    await sql`DELETE FROM rate_limit_counters WHERE key = ${KEY}`;
  });

  it('blocks the (N+1)-th request within the window', async () => {
    for (let i = 0; i < 5; i++) {
      const allowed = await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
      expect(allowed).toBe(true);
    }
    const blocked = await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    expect(blocked).toBe(false);
  });

  it('resets the window after expiry (simulated via DB update)', async () => {
    for (let i = 0; i < 5; i++) await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    // simulate window expiry
    await sql`UPDATE rate_limit_counters SET window_start = NOW() - INTERVAL '2 minutes' WHERE key = ${KEY}`;
    const allowed = await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    expect(allowed).toBe(true);
  });

  it('two independent callers share the same counter (cross-pod)', async () => {
    // Simulate by calling from the same import — the DB counter is the shared state
    for (let i = 0; i < 3; i++) await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    for (let i = 0; i < 2; i++) await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    const blocked = await checkRateLimit(KEY, { max: 5, windowSecs: 60 });
    expect(blocked).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

`cd /home/hein/Workspace/isaflow-BL-21 && bunx vitest run tests/unit/lib/rateLimit.test.ts -t "Neon-backed"`

Expected: FAIL — current `checkRateLimit` uses only LRU, DB counter never changes.

- [ ] **Step 5: Rewrite `checkRateLimit` to use atomic UPSERT**

In `src/lib/rateLimit.ts`, replace `checkRateLimit` with:
```typescript
import { sql } from '@/lib/neon';
import { LRUCache } from 'lru-cache';

const LRU_TTL_MS = 5_000;
const lru = new LRUCache<string, { count: number; windowStart: number }>({
  max: 10_000,
  ttl: LRU_TTL_MS,
});

export interface RateLimitOptions { max: number; windowSecs: number; }

export async function checkRateLimit(key: string, opts: RateLimitOptions): Promise<boolean> {
  const { max, windowSecs } = opts;

  // Short-circuit: if the LRU copy is fresh and well under the limit, skip the DB.
  const cached = lru.get(key);
  if (cached && cached.count < Math.floor(max * 0.5)) {
    cached.count += 1;
    return true;
  }

  const rows = (await sql`
    INSERT INTO rate_limit_counters (key, count, window_start)
    VALUES (${key}, 1, NOW())
    ON CONFLICT (key) DO UPDATE
      SET count = CASE
        WHEN rate_limit_counters.window_start < NOW() - make_interval(secs => ${windowSecs})
          THEN 1
        ELSE rate_limit_counters.count + 1
      END,
      window_start = CASE
        WHEN rate_limit_counters.window_start < NOW() - make_interval(secs => ${windowSecs})
          THEN NOW()
        ELSE rate_limit_counters.window_start
      END
    RETURNING count, window_start
  `) as { count: number; window_start: Date }[];

  const row = rows[0]!;
  lru.set(key, { count: row.count, windowStart: new Date(row.window_start).getTime() });
  return row.count <= max;
}
```

Preserve the existing `getClientIp` export (used by BL-20 register/forgot-password handlers).

- [ ] **Step 6: Run test to verify it passes**

`bunx vitest run tests/unit/lib/rateLimit.test.ts` → all tests (including the 3 new) PASS.

- [ ] **Step 7: tsc --noEmit**

Expected: zero new errors (pre-existing `ioredis` error is benign — the Redis skeleton is unused).

- [ ] **Step 8: Smoke test on dev**

```bash
source /tmp/isaflow-admin-token.env
for i in $(seq 1 7); do
  curl -s -o /dev/null -w "attempt=$i code=%{http_code}\n" \
    -X POST -H "Content-Type: application/json" \
    -d '{"email":"nobody@example.com","password":"wrong"}' \
    http://localhost:3200/api/auth/login
done
```
Expected: first ~5 return 401, subsequent return 429 (rate limit kicks in). Verifies auth-path still works.

- [ ] **Step 9: Commit**

```bash
git add scripts/migrations/sql/331_rate_limit_counters.sql src/lib/rateLimit.ts tests/unit/lib/rateLimit.test.ts
git commit -m "fix(BL-21): Neon-backed rate limiter — shared across pods (S-005)

Replaces per-process LRU with atomic UPSERT on rate_limit_counters.
Keeps 5s LRU short-circuit for low-pressure keys. Migration 331 adds
the counter table + window index.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task α.2: Additive CSP directives (BL-31)

**Files:**
- Modify: `next.config.js` (`cspDev` and `cspProd` strings)
- Test: `tests/integration/csp-headers.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/csp-headers.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

const BASE = 'http://localhost:3200';

describe('CSP response headers (BL-31)', () => {
  it('includes additive directives on the root path', async () => {
    const res = await fetch(`${BASE}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

`cd /home/hein/Workspace/isaflow-BL-31 && bunx vitest run tests/integration/csp-headers.test.ts`

Expected: FAIL — new directives not yet in CSP.

- [ ] **Step 3: Edit `next.config.js`**

Append the 4 directives to BOTH `cspDev` (line 3) and `cspProd` (line 4). Keep everything else untouched:

```js
const cspDev = "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.isaflow.co.za https://*.gravatar.com; font-src 'self' data:; connect-src 'self' https://api.anthropic.com https://*.sageone.co.za https://*.isaflow.co.za https://*.cloudflare.com https://cloudflareinsights.com http://localhost:3101 http://localhost:3004; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests";
const cspProd = "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.isaflow.co.za https://*.gravatar.com; font-src 'self' data:; connect-src 'self' https://api.anthropic.com https://*.sageone.co.za https://*.isaflow.co.za https://*.cloudflare.com https://cloudflareinsights.com https://static.cloudflareinsights.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests";
```

- [ ] **Step 4: Restart dev server**

```bash
cd /home/hein/Workspace/IsaFlow
lsof -ti :3200 | xargs -r kill
rm -rf .next
bun run dev > /tmp/isaflow-dev.log 2>&1 &
disown
sleep 7
curl -sI http://localhost:3200/ | grep -i content-security-policy
```
Expected: response header contains the 4 new directives.

- [ ] **Step 5: Run test to verify it passes**

`bunx vitest run tests/integration/csp-headers.test.ts` → PASS.

- [ ] **Step 6: tsc --noEmit**

- [ ] **Step 7: Commit**

```bash
git add next.config.js tests/integration/csp-headers.test.ts
git commit -m "fix(BL-31): CSP additive directives — object-src/base-uri/form-action (S-008)

Adds object-src 'none', base-uri 'self', form-action 'self',
upgrade-insecure-requests to both cspDev and cspProd. No removal of
existing directives. style-src 'unsafe-inline' hardening deferred to
Phase 5.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task α.3: Legacy cookie removal (BL-32)

**Files:**
- Modify: `src/lib/auth/sessionHelpers.ts:16,22`
- Modify: `middleware.ts:15,92,140`
- Test: extend an existing auth test (`tests/integration/api/auth.test.ts` if present, otherwise add a new file)

- [ ] **Step 1: Grep for all LEGACY_COOKIE_NAME references**

```bash
cd /home/hein/Workspace/isaflow-BL-32
grep -rn "LEGACY_COOKIE_NAME\|ff_auth_token" src/ pages/ middleware.ts --include='*.ts' --include='*.tsx'
```
Expected: exactly 2 files show references — `src/lib/auth/sessionHelpers.ts` and `middleware.ts`.

- [ ] **Step 2: Write the failing test**

Create `tests/integration/api/legacy-cookie-rejected.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('legacy ff_auth_token cookie (BL-32)', () => {
  it('is no longer accepted as an auth cookie', async () => {
    // Request a protected endpoint with only the legacy cookie set.
    const res = await fetch('http://localhost:3200/api/auth/me', {
      headers: { Cookie: 'ff_auth_token=legacyvalue' },
    });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run test to verify it FAILS (currently 200 via fallback)**

`bunx vitest run tests/integration/api/legacy-cookie-rejected.test.ts`

Expected: FAIL with `expected 200 to be 401` — current code accepts legacy cookie.

(If the endpoint validates the token's signature and rejects malformed values with 401, the test may pass accidentally. In that case, use a freshly-minted valid legacy-cookie-named token: re-issue a current token but set it under the `ff_auth_token` cookie name. The point is to prove the fallback path is gone.)

- [ ] **Step 4: Edit `src/lib/auth/sessionHelpers.ts`**

Delete line 16:
```typescript
// DELETE THIS LINE:
export const LEGACY_COOKIE_NAME = 'ff_auth_token';
```

Replace line 22:
```typescript
// BEFORE
const cookieToken = req.cookies[AUTH_COOKIE_NAME] || req.cookies[LEGACY_COOKIE_NAME];
// AFTER
const cookieToken = req.cookies[AUTH_COOKIE_NAME];
```

- [ ] **Step 5: Edit `middleware.ts`**

Delete line 15:
```typescript
// DELETE THIS LINE:
const LEGACY_COOKIE_NAME = 'ff_auth_token';
```

Replace lines 92 and 140:
```typescript
// BEFORE (both sites)
const token = request.cookies.get(AUTH_COOKIE_NAME)?.value || request.cookies.get(LEGACY_COOKIE_NAME)?.value;
// AFTER
const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
```

- [ ] **Step 6: Run test to verify it PASSES**

`bunx vitest run tests/integration/api/legacy-cookie-rejected.test.ts` → PASS.

- [ ] **Step 7: Grep check — no LEGACY references remain**

```bash
grep -rn "LEGACY_COOKIE_NAME\|ff_auth_token" src/ pages/ middleware.ts --include='*.ts' --include='*.tsx' | grep -v tests/
```
Expected: zero output.

- [ ] **Step 8: tsc --noEmit + run existing auth tests to confirm no regression**

```bash
bunx tsc --noEmit
bunx vitest run tests/unit/lib/rateLimit.test.ts tests/integration/api/products-categories.test.ts
```

- [ ] **Step 9: Commit**

```bash
git add src/lib/auth/sessionHelpers.ts middleware.ts tests/integration/api/legacy-cookie-rejected.test.ts
git commit -m "fix(BL-32): remove legacy ff_auth_token cookie fallback (S-009)

2h token TTL means no active session disruption — any active session
has already rotated to isaflow_auth within the TTL window. Anyone with
only the legacy cookie now gets 401 and logs in fresh.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task α.4: Wave α completion gate

After α.1, α.2, α.3 all merge to master:

- [ ] **Run full regression**

```bash
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit; echo "tsc EXIT: $?"
bash scripts/ci/check-internal-apis.sh
bunx vitest run 2>&1 | tail -5
```
Expected: tsc exit 0, CI lints OK, test count ≥ 1805 + new tests, zero failures.

- [ ] **Live smoke the changed surface**

```bash
source /tmp/isaflow-admin-token.env
# Rate-limit works
for i in $(seq 1 7); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
    -d '{"email":"nope@example.com","password":"x"}' http://localhost:3200/api/auth/login
done | sort | uniq -c
# Expected: ~5 × 401, 2+ × 429

# CSP directives present
curl -sI http://localhost:3200/ | grep -i content-security-policy | grep -oE "object-src|base-uri|form-action|upgrade-insecure-requests"
# Expected: 4 lines of directive names

# Legacy cookie rejected
curl -s -o /dev/null -w "%{http_code}\n" -H "Cookie: ff_auth_token=x" http://localhost:3200/api/auth/me
# Expected: 401
```

- [ ] **HARD STOP for Hein review before Wave β**

---

# WAVE 4B-β — Sequential CSRF (3 tasks)

Sequential within this wave because the files build on each other. All three sub-tasks land in one commit for the Wave β gate.

## Task β.1: CSRF infrastructure + apiFetch extension (BL-22)

**Files:**
- Create: `src/lib/auth/csrf.ts`
- Create: `src/lib/auth/withCsrf.ts`
- Modify: `src/lib/apiFetch.ts` (add CSRF header injection)
- Modify: `middleware.ts` (issue cookie on authenticated responses)
- Test: `tests/integration/api/csrf.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/api/csrf.test.ts`:
```typescript
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = 'http://localhost:3200';
const PROTECTED_ENDPOINT = '/api/accounting/bank-transactions-action';

describe('CSRF on money-moving endpoints (BL-22)', () => {
  let authToken: string;

  beforeAll(async () => {
    // Read the pre-minted admin token
    const fs = await import('node:fs');
    const env = fs.readFileSync('/tmp/isaflow-admin-token.env', 'utf-8');
    authToken = env.match(/TOKEN=(.+)/)?.[1] ?? '';
    expect(authToken.length).toBeGreaterThan(0);
  });

  it('GET does NOT require CSRF', async () => {
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'GET',
      headers: { Cookie: `isaflow_auth=${authToken}`, 'X-Company-Id': '00000000-0000-0000-0000-000000000001' },
    });
    // 405 Method Not Allowed or 200 — just not 403 CSRF
    expect(res.status).not.toBe(403);
  });

  it('POST without CSRF cookie + header → 403', async () => {
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Cookie: `isaflow_auth=${authToken}`,
        'X-Company-Id': '00000000-0000-0000-0000-000000000001',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'noop' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code).toBe('FORBIDDEN');
    expect(body.error?.message).toContain('CSRF');
  });

  it('POST with mismatched cookie and header → 403', async () => {
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Cookie: `isaflow_auth=${authToken}; isaflow_csrf=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
        'X-Company-Id': '00000000-0000-0000-0000-000000000001',
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      body: JSON.stringify({ action: 'noop' }),
    });
    expect(res.status).toBe(403);
  });

  it('POST with matching cookie and header → not 403', async () => {
    const token = 'a'.repeat(64);
    const res = await fetch(`${BASE}${PROTECTED_ENDPOINT}`, {
      method: 'POST',
      headers: {
        Cookie: `isaflow_auth=${authToken}; isaflow_csrf=${token}`,
        'X-Company-Id': '00000000-0000-0000-0000-000000000001',
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify({ action: 'noop' }),
    });
    expect(res.status).not.toBe(403);  // handler-level behavior depends on body; just prove CSRF passed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — CSRF layer does not exist yet; all requests pass through to the handler regardless of cookie/header.

- [ ] **Step 3: Create `src/lib/auth/csrf.ts`**

```typescript
import { randomBytes } from 'node:crypto';
import type { NextApiRequest } from 'next';

export const CSRF_COOKIE = 'isaflow_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function generateCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

export function verifyCsrf(req: NextApiRequest): boolean {
  const cookie = req.cookies[CSRF_COOKIE];
  const headerVal = req.headers[CSRF_HEADER];
  const header = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (!cookie || !header) return false;
  if (cookie.length < 32 || header.length < 32) return false;
  return cookie === header;
}
```

- [ ] **Step 4: Create `src/lib/auth/withCsrf.ts`**

```typescript
import type { NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { verifyCsrf } from './csrf';
import type { CompanyApiHandler, CompanyApiRequest } from './withCompany';

export function withCsrf(handler: CompanyApiHandler): CompanyApiHandler {
  return async (req: CompanyApiRequest, res: NextApiResponse) => {
    const method = req.method?.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return handler(req, res);
    }
    if (!verifyCsrf(req)) {
      return apiResponse.forbidden(res, 'CSRF token mismatch');
    }
    return handler(req, res);
  };
}
```

(Verify `CompanyApiHandler` and `CompanyApiRequest` are exported from `src/lib/auth/withCompany.ts` — BL-34 renamed these. If the exports live in `src/lib/auth/index.ts` instead, import from there.)

- [ ] **Step 5: Extend `middleware.ts` to issue the CSRF cookie**

Add at the top of the main handler (after the existing auth-cookie logic):
```typescript
import { CSRF_COOKIE, generateCsrfToken } from './src/lib/auth/csrf';

// ... existing middleware body ...

// After creating the response object but before returning it:
if (!request.cookies.get(CSRF_COOKIE)) {
  response.cookies.set(CSRF_COOKIE, generateCsrfToken(), {
    httpOnly: false,   // JS must read to mirror into X-CSRF-Token header
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}
```

Read the current `middleware.ts` first to place this in the right spot (it has multiple code paths — auth, admin, public). The cookie should be set on any response that carries an authenticated session.

- [ ] **Step 6: Extend `src/lib/apiFetch.ts`**

Replace the existing file contents with:
```typescript
/**
 * Fetch wrapper that automatically injects:
 *   - the active company ID header (existing)
 *   - the CSRF token header for non-idempotent requests (BL-22)
 * Use this instead of raw fetch() for all accounting API calls.
 */

const COMPANY_STORAGE_KEY = 'isaflow_active_company';
const CSRF_COOKIE = 'isaflow_csrf';

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${CSRF_COOKIE}=`));
  return match ? match.slice(CSRF_COOKIE.length + 1) : null;
}

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const headers = new Headers(options?.headers);
  const method = (options?.method ?? 'GET').toUpperCase();

  if (options?.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(COMPANY_STORAGE_KEY);
    if (stored) {
      try {
        const { id } = JSON.parse(stored);
        if (id) headers.set('X-Company-Id', id);
      } catch {
        // Invalid JSON — ignore
      }
    }
  }

  // BL-22: mirror the CSRF cookie into the X-CSRF-Token header on non-idempotent methods.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('X-CSRF-Token')) {
    const csrf = readCsrfCookie();
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }

  return fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });
}
```

- [ ] **Step 7: Do NOT apply withCsrf to routes yet** — that's Task β.2.

- [ ] **Step 8: tsc --noEmit + run the new CSRF test**

At this point the test should STILL fail for `POST without CSRF` (expects 403) because no route has `withCsrf` yet. That's correct — Task β.2 wires the routes; the test goes green there.

Note: some test cases in the new test file can't pass until Task β.2 lands. That's OK for this commit; Task β.2's commit makes all 4 cases pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/auth/csrf.ts src/lib/auth/withCsrf.ts src/lib/apiFetch.ts middleware.ts tests/integration/api/csrf.test.ts
git commit -m "feat(BL-22): CSRF infrastructure (csrf.ts, withCsrf.ts, apiFetch extension)

Double-submit-cookie scheme: middleware issues isaflow_csrf (HttpOnly=false,
SameSite=lax); apiFetch mirrors it into X-CSRF-Token on non-idempotent
requests; verifyCsrf compares the two constant-time-ish (length-guarded).
Routes not yet protected — applied in BL-22-apply.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task β.2: Apply `withCsrf` to 8 money-moving routes

**Files:** 8 handlers. Wrap each with `withCsrf` in the default export chain.

- [ ] **Step 1: Resolve exact endpoint filenames**

```bash
cd /home/hein/Workspace/isaflow-BL-22-apply
ls pages/api/accounting/bank-transactions-action.ts \
   pages/api/accounting/bank-rules-action.ts \
   pages/api/accounting/customer-invoices-detail.ts \
   pages/api/accounting/supplier-invoices-action.ts \
   pages/api/accounting/journal-entries-action.ts \
   pages/api/accounting/customer-payments.ts \
   pages/api/accounting/supplier-payments.ts \
   pages/api/accounting/credit-notes-action.ts
```
Expected: all 8 files exist.

If a filename differs from expected, use the closest matching action/detail file per endpoint (e.g., `supplier-invoices-action.ts` vs `supplier-invoices-detail.ts` — prefer the one that handles writes: approve/pay).

- [ ] **Step 2: For each of the 8 files, add `withCsrf` to the wrapper chain**

Pattern (edit one file at a time to keep diffs small):
```typescript
// BEFORE
import { withCompany } from '@/lib/auth';
// ...
export default withCompany(withErrorHandler(withWriteAccess(handler)));

// AFTER
import { withCompany } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
// ...
export default withCompany(withErrorHandler(withCsrf(withWriteAccess(handler))));
```

Wrapper order matters: `withCompany` → `withErrorHandler` → `withCsrf` → `withWriteAccess` → `handler`. CSRF runs AFTER auth (so we know who the user is) but BEFORE the handler body.

- [ ] **Step 3: Run the CSRF test — now all 4 cases should pass**

```bash
bunx vitest run tests/integration/api/csrf.test.ts
```
Expected: 4/4 PASS.

- [ ] **Step 4: tsc --noEmit**

- [ ] **Step 5: Live smoke one protected endpoint**

```bash
source /tmp/isaflow-admin-token.env
# Without CSRF → 403
curl -s -o /dev/null -w 'HTTP=%{http_code}\n' -X POST \
  -H "Cookie: isaflow_auth=$TOKEN" \
  -H "X-Company-Id: 00000000-0000-0000-0000-000000000001" \
  -H "Content-Type: application/json" \
  -d '{"action":"noop"}' \
  http://localhost:3200/api/accounting/bank-transactions-action
# Expected: HTTP=403

# With matching CSRF → passes through to handler
CSRF=$(openssl rand -hex 32)
curl -s -o /dev/null -w 'HTTP=%{http_code}\n' -X POST \
  -H "Cookie: isaflow_auth=$TOKEN; isaflow_csrf=$CSRF" \
  -H "X-Company-Id: 00000000-0000-0000-0000-000000000001" \
  -H "X-CSRF-Token: $CSRF" \
  -H "Content-Type: application/json" \
  -d '{"action":"noop"}' \
  http://localhost:3200/api/accounting/bank-transactions-action
# Expected: HTTP != 403 (handler-level response — 400 or 200 depending on body)
```

- [ ] **Step 6: Commit**

```bash
git add pages/api/accounting/bank-transactions-action.ts \
        pages/api/accounting/bank-rules-action.ts \
        pages/api/accounting/customer-invoices-detail.ts \
        pages/api/accounting/supplier-invoices-action.ts \
        pages/api/accounting/journal-entries-action.ts \
        pages/api/accounting/customer-payments.ts \
        pages/api/accounting/supplier-payments.ts \
        pages/api/accounting/credit-notes-action.ts
git commit -m "feat(BL-22): apply withCsrf to 8 money-moving endpoints (S-006)

Wrapper order: withCompany(withErrorHandler(withCsrf(withWriteAccess(handler)))).
GET/HEAD/OPTIONS bypass the check; POST/PUT/PATCH/DELETE require matching
isaflow_csrf cookie and X-CSRF-Token header (double-submit).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task β.3: Wave β completion gate

- [ ] **Full regression**

```bash
bunx tsc --noEmit; echo "tsc EXIT: $?"
bash scripts/ci/check-internal-apis.sh
bunx vitest run 2>&1 | tail -5
```
Expected: tsc exit 0, lints OK, test count grows, zero failures.

- [ ] **Verify frontend `apiFetch` usage**

```bash
grep -rn "fetch(" src/components/ pages/accounting/ --include='*.tsx' --include='*.ts' | \
  grep -v apiFetch | grep -v tests/ | grep -vE "^[^:]+:\s*//" | head -20
```
List any direct `fetch()` call sites in the UI. Each would need to migrate to `apiFetch` for CSRF to work on writes. Log findings as follow-up tickets; do NOT migrate in this sprint unless a blocking UI regression surfaces.

- [ ] **HARD STOP for Hein review before Wave γ**

---

# WAVE 4B-γ — Zod MVP on 14 handlers (2 parallel subagents)

Dispatch two subagents in parallel, each owning half the list. Both depend on `src/lib/schemas/common.ts` — that's Task γ.0 (controller does it inline before dispatching).

## Task γ.0: Shared schema primitives (controller-inline, ~5 min)

**Files:**
- Create: `src/lib/schemas/common.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/lib/schemas/common.ts
import { z } from 'zod';

export const UUID = z.string().uuid('Must be a valid UUID');
export const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
export const Currency = z.number().nonnegative().multipleOf(0.01);
export const NonEmptyString = z.string().min(1);
export const Email = z.string().email();
export const VatRate = z.number().min(0).max(100);
export const Reference = z.string().max(100).optional();
```

- [ ] **Step 2: tsc --noEmit — zero errors**

- [ ] **Step 3: Commit**

```bash
git add src/lib/schemas/common.ts
git commit -m "feat(BL-33): Zod schema primitives for Phase 4B MVP

Shared building blocks for the 14 money-moving handler schemas:
UUID, ISODate, Currency, NonEmptyString, Email, VatRate, Reference.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task γ.A: Zod on 7 auth+admin handlers (subagent A)

**Handlers:**
1. `pages/api/auth/login.ts`
2. `pages/api/auth/register.ts`
3. `pages/api/auth/do-reset-password.ts`
4. `pages/api/auth/forgot-password.ts` (bonus — while we're in the file)
5. `pages/api/accounting/sage-migration-action.ts`
6. `pages/api/accounting/company-logo.ts`
7. `pages/api/accounting/bank-rules-action.ts`

- [ ] **Dispatch subagent A with the full handler list + common.ts dependency + the per-handler Zod pattern from the spec.**

Per handler:
1. Read the file to identify all `req.body` destructuring sites.
2. Build a `z.object({...})` schema inline at the top, using `common.ts` primitives where applicable.
3. Replace raw destructuring with `const parsed = Schema.safeParse(req.body); if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);`
4. Use `const body = parsed.data;` as the new typed body reference.
5. Write a paired positive/negative test case per handler in `tests/integration/api/zod-validation.test.ts` (extend — shared file for Wave γ).
6. Run tests. Run tsc. Commit each handler individually OR one commit for the subagent if diffs are small.

## Task γ.B: Zod on 7 money-moving handlers (subagent B)

**Handlers:**
1. `pages/api/accounting/bank-transactions-action.ts`
2. `pages/api/accounting/customer-invoices-detail.ts`
3. `pages/api/accounting/supplier-invoices-action.ts`
4. `pages/api/accounting/journal-entries-action.ts`
5. `pages/api/accounting/customer-payments.ts`
6. `pages/api/accounting/supplier-payments.ts`
7. `pages/api/accounting/credit-notes-action.ts`
8. `pages/api/accounting/write-offs-action.ts` (bonus)

Same per-handler pattern as γ.A.

**Why split this way:** γ.A is lower-risk (auth payloads are simple shapes); γ.B touches money-moving handlers that already got `withCsrf`. Dispatching them separately keeps worktree diffs non-overlapping.

---

## Task γ.3: Wave γ completion gate

After γ.A and γ.B both merge:

- [ ] **Full regression**

```bash
bunx tsc --noEmit; echo "tsc EXIT: $?"
bash scripts/ci/check-internal-apis.sh
bunx vitest run 2>&1 | tail -5
```
Expected: tsc exit 0, lints OK, ~1805 + ~30 tests = ~1835+ passing.

- [ ] **Live smoke each of the 14 handlers — invalid body → 400 with `fields`**

```bash
source /tmp/isaflow-admin-token.env
# Example: send empty body, expect 400 with validation errors
curl -s -X POST -H "Cookie: isaflow_auth=$TOKEN" -H "Content-Type: application/json" \
  -d '{}' http://localhost:3200/api/auth/login | python3 -m json.tool | head -15
# Expected: success=false, error.code=VALIDATION_ERROR, error.details={...}
```
Loop through all 14 with the same `-d '{}'` probe.

- [ ] **HARD STOP — write Phase 4B closeout, hand off to 4C (Observability).**

---

# Phase 4B final gate

After γ.3 lands clean:

- [ ] Write `docs/audits/2026-04-15/phase4b-closeout.md` summarizing:
  - Migrations applied (331)
  - New files (csrf, withCsrf, schemas/common)
  - Modified files (rateLimit, apiFetch, middleware, next.config, 14 handlers)
  - Test additions (~30 new)
  - Follow-up items (BL-41 sage customer invoices, inline `fetch()` UI migrations, CSP `style-src` hardening)

- [ ] HARD STOP. Hein approves before Phase 4C brainstorm.

---

## Self-review notes (completed during plan writing)

1. **Spec coverage:** Every component in the spec maps to a task. Rate limiter (α.1), CSRF infra (β.1), CSRF apply (β.2), CSP (α.2), Zod primitives (γ.0), Zod handlers (γ.A + γ.B), legacy cookie (α.3). Gates are explicit between waves.
2. **Placeholder scan:** No "TBD"/"implement later". Every SQL, code block, and command is concrete. Endpoint filenames resolved via live grep.
3. **Type consistency:** `CompanyApiHandler` / `CompanyApiRequest` imports are noted with fallback instruction if they live in a different file. `RateLimitOptions` signature locked. `CSRF_COOKIE` / `CSRF_HEADER` constants reused across csrf.ts and apiFetch.ts.
4. **Real-vs-assumed file names:** Verified these exist:
   - `src/lib/apiFetch.ts` (exists; will extend)
   - `zod@^4.3.6` in package.json (confirmed)
   - `apiResponse.validationError(res, fieldErrors, message)` (confirmed at line 136)
   - `apiResponse.forbidden` (confirmed at line 172)
   - `cspDev` / `cspProd` in `next.config.js:3,4` (confirmed)
   - `LEGACY_COOKIE_NAME` in `sessionHelpers.ts:16` and `middleware.ts:15` (confirmed)
   - Handler files: `bank-transactions-action.ts`, `bank-rules-action.ts`, `customer-invoices-detail.ts`, `supplier-invoices-action.ts`, `journal-entries-action.ts`, `customer-payments.ts`, `supplier-payments.ts`, `credit-notes-action.ts`, `write-offs-action.ts`, `do-reset-password.ts`, `forgot-password.ts`, `sage-migration-action.ts`, `company-logo.ts` (all present per grep).
5. **Ambiguity check:** Wrapper order `withCompany(withErrorHandler(withCsrf(withWriteAccess(handler))))` is explicit. GET/HEAD/OPTIONS bypass is explicit. validationError vs. badRequest choice is explicit (uses existing validationError helper).
