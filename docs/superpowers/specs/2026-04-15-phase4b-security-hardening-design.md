# Phase 4B — Security Hardening Design

**Date:** 2026-04-15
**Prior phase:** `docs/audits/2026-04-14/06-phase3-closeout.md` (Phase 3 substantively complete; all P0/P1 closed)
**Plan will live at:** `docs/superpowers/plans/2026-04-15-phase4b-security-hardening-plan.md`

## Goal

Close the remaining security gaps identified in `docs/audits/2026-04-14/02-security-findings.md` and the CLAUDE.md input-validation standard. Specifically:

1. Eliminate per-process rate-limit bypass under horizontal scaling (S-005 / BL-21)
2. Add CSRF defense-in-depth on money-moving endpoints (S-006 / BL-22)
3. Tighten CSP with safe additive directives (S-008 / BL-31)
4. Adopt Zod input validation on 12–14 highest-risk write handlers (S-010 / BL-33 MVP)
5. Remove the legacy `ff_auth_token` cookie fallback (S-009 / BL-32) — time-gate waived (2h token TTL)

## Non-goals

- No new runtime infrastructure (no Redis, no MQ, no edge workers). Everything runs on the existing Next.js 14 + Neon stack.
- No CSP nonce-based `style-src` tightening. Deferred to Phase 5.
- No Zod on every write handler. Only the 12–14 money-moving / auth endpoints in this sprint.
- No CSP violation reporting endpoint (`/api/csp-report`). Deferred to Phase 5.
- No new frontend UI. All changes are server-side + one client-side `apiFetch` wrapper.

## Success criteria

- Rate limit counters are visible across pods/processes (proven by a two-importer test that shares the counter).
- CSRF enforcement active on 8 money-moving routes: request without matching cookie + header → 403.
- CSP response header contains `object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests`.
- 12–14 Zod'd handlers reject malformed input with 400 + structured `{ fields: {...} }` error.
- Legacy `ff_auth_token` cookie no longer accepted; only `isaflow_auth` works.
- Zero regression on 1805-test suite baseline.
- `tsc --noEmit` exit 0 maintained.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                  Phase 4B — Security Hardening                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Rate limit backend                Neon-backed counters       │
│     src/lib/rateLimit.ts              → shared across pods       │
│     migration 331                     → atomic UPSERT per req    │
│                                       → LRU in-memory cache      │
│                                         short-circuit            │
│                                                                  │
│  2. CSRF hybrid                       Opt-in wrapper             │
│     src/lib/auth/csrf.ts (new)        → double-submit cookie     │
│     src/lib/auth/withCsrf.ts (new)    → middleware sets cookie   │
│     src/lib/apiFetch.ts (extend)      → client auto-adds header  │
│                                       → 8 money-moving routes    │
│                                                                  │
│  3. CSP additive                      next.config.js             │
│                                       → object-src 'none'        │
│                                       → base-uri 'self'          │
│                                       → form-action 'self'       │
│                                       → upgrade-insecure-requests│
│                                                                  │
│  4. Zod MVP                           12-14 handlers             │
│     src/lib/schemas/common.ts (new)   → parse() at top           │
│     per-handler inline schemas        → 400 with field errors    │
│                                                                  │
│  5. Legacy cookie removal             sessionHelpers + mw        │
│     one-commit deletion               → only isaflow_auth        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Each component is independent and testable. Only #1 requires a DB migration.

### Execution waves inside 4B

- **Wave 4B-α** (parallel, safe): migration 331 + rate-limit rewrite + CSP + legacy cookie removal. 4 small commits.
- **Wave 4B-β** (sequential, cross-cutting): CSRF infrastructure (csrf.ts + withCsrf.ts + apiFetch update) then apply to 8 routes. 1 larger commit.
- **Wave 4B-γ** (parallel): Zod on 14 handlers — 2 concurrent subagents (one for auth+sage, one for money-moving).

## Components

### 1. Neon-backed rate limiter (BL-21)

**Migration 331 — `scripts/migrations/sql/331_rate_limit_counters.sql`:**
```sql
CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key TEXT PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rl_window_start ON rate_limit_counters (window_start);
```

**Rewrite `src/lib/rateLimit.ts::checkRateLimit`** to use an atomic upsert on the counter table:
```sql
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
RETURNING count, window_start;
```

Single round-trip, atomic. ~1-3ms on Neon at current scale.

**Keep the existing in-memory LRU** as a per-pod short-circuit cache: if the cached count is already below a safe threshold (e.g. half the limit) and the cache entry is less than 5 seconds old, skip the DB round-trip. Otherwise defer to the DB.

**TTL cleanup:** the table stays small (one row per active rate-limited key). Weekly manual housekeeping: `DELETE FROM rate_limit_counters WHERE window_start < NOW() - INTERVAL '1 hour';`. Can be cron-ified later; not part of 4B.

**Tests** — extend `tests/unit/lib/rateLimit.test.ts`:
- 6th request in a 5/min window is blocked (returns false).
- Window resets after expiry (7th request after 60s passes).
- Two independent service imports (simulated pods) share the same counter — calling 3 times from each totals 6, 6th call blocks.

### 2. Hybrid CSRF (BL-22)

**New file `src/lib/auth/csrf.ts`:**
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

**Middleware (`middleware.ts`)** — after authentication, if no `isaflow_csrf` cookie is set, issue one. Cookie flags: `HttpOnly=false` (JS must read), `Secure=true`, `SameSite=lax`, `Path=/`.

**New wrapper `src/lib/auth/withCsrf.ts`:**
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

**`src/lib/apiFetch.ts`** — extend the central client fetch wrapper to auto-add `X-CSRF-Token` on non-idempotent requests:
```typescript
export async function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const method = (opts.method || 'GET').toUpperCase();
  const needsCsrf = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const headers = new Headers(opts.headers);
  if (needsCsrf && typeof document !== 'undefined') {
    const csrfToken = document.cookie
      .split('; ')
      .find((c) => c.startsWith('isaflow_csrf='))
      ?.split('=')[1];
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  }
  return fetch(url, { ...opts, headers, credentials: 'include' });
}
```

If `src/lib/apiFetch.ts` does not exist today, create it and flag any direct `fetch(...)` call-sites in the frontend that should be migrated (non-blocking — list in the plan).

**8 money-moving routes get `withCsrf`:**
1. `pages/api/accounting/bank-transactions-action.ts`
2. `pages/api/accounting/bank-rules-action.ts`
3. `pages/api/accounting/customer-invoices-detail.ts`
4. `pages/api/accounting/supplier-invoices-detail.ts` (or the closest pay/approve variant)
5. `pages/api/accounting/gl-journals-detail.ts` (or manual-journal create)
6. `pages/api/accounting/customer-payments.ts`
7. `pages/api/accounting/supplier-payments.ts`
8. `pages/api/accounting/credit-notes-detail.ts`

Wrapper order: `withCompany(withErrorHandler(withCsrf(withWriteAccess(handler))))`.

**Tests** — `tests/integration/api/csrf.test.ts`:
- GET a protected route without CSRF → 200 (no check on idempotent).
- POST without any CSRF cookie/header → 403 `CSRF token mismatch`.
- POST with mismatched cookie and header → 403.
- POST with matching cookie and header → 200 (happy path).

### 3. CSP additive (BL-31)

**Edit `next.config.js`** — the `headers()` block's CSP string. Append these directives (preserve everything else, including the existing `'unsafe-inline'` on `style-src`):
```
object-src 'none';
base-uri 'self';
form-action 'self';
upgrade-insecure-requests
```

**Tests** — `tests/integration/csp-headers.test.ts`:
- Fetch `/` (or any page), assert CSP header contains all four new directives as substrings.

**Follow-up TODO** logged in the plan's deferred section: style-src hardening (nonce-based) = Phase 5.

### 4. Zod MVP (BL-33)

**Create `src/lib/schemas/common.ts`** with shared primitives:
```typescript
import { z } from 'zod';

export const UUID = z.string().uuid('Must be a valid UUID');
export const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
export const Currency = z.number().nonnegative().multipleOf(0.01);
export const NonEmptyString = z.string().min(1);
export const Email = z.string().email();
export const VatRate = z.number().min(0).max(100);
export const Reference = z.string().max(100).optional();
```

**Verify `zod` is in `package.json`** (it almost certainly is for Next 14 apps). If not, `bun add zod`.

**Per-handler pattern** — inline schema at top of file:
```typescript
import { z } from 'zod';
import { UUID, ISODate, Currency } from '@/lib/schemas/common';

const CreatePaymentSchema = z.object({
  customerId: UUID,
  paymentDate: ISODate,
  amount: Currency,
  allocations: z.array(z.object({ invoiceId: UUID, amount: Currency })).max(200),
});

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const parsed = CreatePaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    return apiResponse.badRequest(res, 'Invalid input', parsed.error.flatten());
  }
  const body = parsed.data;
  // ... handler body ...
}
```

**`apiResponse.badRequest` extension:** add optional third arg `details?: unknown` that folds into the response body as `error.fields`. Implement if not already present.

**14 target handlers:**

Auth (3):
1. `pages/api/auth/login.ts`
2. `pages/api/auth/register.ts`
3. `pages/api/auth/reset-password.ts`

Money-moving writes (9):
4. `pages/api/accounting/bank-transactions-action.ts`
5. `pages/api/accounting/bank-rules-action.ts`
6. `pages/api/accounting/customer-invoices-detail.ts`
7. `pages/api/accounting/supplier-invoices-detail.ts` (or closest pay/approve handler)
8. `pages/api/accounting/gl-journals-detail.ts` (or manual-journal create)
9. `pages/api/accounting/customer-payments.ts`
10. `pages/api/accounting/supplier-payments.ts`
11. `pages/api/accounting/credit-notes-detail.ts`
12. `pages/api/accounting/writeoffs-detail.ts` (or writeoffs-action)

Bonus hardening (2):
13. `pages/api/accounting/company-logo.ts`
14. `pages/api/accounting/sage-migration-action.ts`

**Tests** — one paired positive/negative case per handler:
- Valid body → normal success path (200/201/etc).
- Missing required field → 400 with `{ error: { fields: { <name>: [<msg>] } } }`.

### 5. Legacy cookie removal (BL-32)

Simple deletion:

**`src/lib/auth/sessionHelpers.ts`** — delete line 16 (`export const LEGACY_COOKIE_NAME = 'ff_auth_token';`). Update line 22:
```typescript
// BEFORE
const cookieToken = req.cookies[AUTH_COOKIE_NAME] || req.cookies[LEGACY_COOKIE_NAME];
// AFTER
const cookieToken = req.cookies[AUTH_COOKIE_NAME];
```

**`middleware.ts`** — delete line 15 (`const LEGACY_COOKIE_NAME = 'ff_auth_token';`). Simplify lines 92 and 140:
```typescript
// BEFORE
const token = request.cookies.get(AUTH_COOKIE_NAME)?.value || request.cookies.get(LEGACY_COOKIE_NAME)?.value;
// AFTER
const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;
```

**Test:** add to an existing auth test — set only `ff_auth_token` cookie, request protected endpoint → 401 (was 200 via fallback pre-change).

**Rationale for waiving the 14-day time gate:** auth tokens have a 2h TTL. Within 2h of deploy, every active session has rotated to `isaflow_auth` naturally. Stale-cookie users get a normal 401 and re-login.

## Error handling

- **Rate-limit hit** → 429 Too Many Requests with `Retry-After: <seconds-until-window-end>` header. Preserve existing response body shape.
- **CSRF mismatch** → 403 Forbidden with body `{ error: { code: 'CSRF_MISMATCH', message: 'CSRF token mismatch' } }`. Frontend `apiFetch` surfaces this as a hard error (no silent swallow).
- **Zod validation failure** → 400 Bad Request with body `{ error: { code: 'BAD_REQUEST', message: 'Invalid input', fields: { <field>: [<msg>] } } }`. Matches the existing `apiResponse.badRequest` shape with one new optional field.
- **Legacy cookie only present** → 401 Unauthorized (same as any unauthenticated request).
- **CSP header** is set once; no runtime error path.

## Testing strategy

Each component has its own test file:
- `tests/unit/lib/rateLimit.test.ts` (extend — DB integration test)
- `tests/integration/api/csrf.test.ts` (new)
- `tests/integration/csp-headers.test.ts` (new)
- `tests/integration/api/zod-validation.test.ts` (new — one group per handler, paired positive/negative)
- One negative case added to an existing auth test file for the legacy-cookie-removal check

All new tests run as part of the full `bunx vitest run` suite. Target: 1805 (baseline) + ~30 new = 1835+ passing, zero failures.

## Rollout

Execution waves as noted in Architecture above. Gate between waves:
- After α: tsc + full vitest + live smoke of one rate-limited endpoint (e.g. `/api/auth/login` bursted with 50 requests, expect 429 within the limit) + CSP header check + verify `ff_auth_token` cookie now returns 401.
- After β: tsc + full vitest + CSRF smoke (GET=200, mismatched POST=403, matched POST=200).
- After γ: tsc + full vitest + one Zod smoke per handler (invalid body → 400 with fields).

## Risks

- **DB round-trip on every rate-limited request.** Mitigated by the in-memory LRU short-circuit for low-pressure keys. Worst case: auth endpoints hit with ~5-10ms overhead per rejected request. Acceptable at our scale.
- **CSRF on cross-domain invite links.** We chose `SameSite=lax` for the auth cookie (unchanged). The new `isaflow_csrf` cookie also uses `SameSite=lax`. Invite-accept flows continue to work because they're GET-only (no CSRF check on GET).
- **Frontend `apiFetch` not used everywhere.** If direct `fetch()` calls exist in pages/ or components/, they'll fail with 403 after CSRF is applied. Mitigation: grep all frontend `fetch(` calls during plan writing; migrate to `apiFetch` in-scope or flag for Phase 5 follow-up.
- **Zod `safeParse` performance overhead.** Negligible for our payload sizes (<1ms per handler).
- **Legacy-cookie revocation for mobile clients with long-lived sessions.** 2h token TTL bounds this. If a client somehow has an `ff_auth_token` older than 2h, it would have been expired server-side anyway.

## Artifacts

```
docs/superpowers/specs/
  2026-04-15-phase4b-security-hardening-design.md   ← this file
docs/superpowers/plans/
  2026-04-15-phase4b-security-hardening-plan.md     ← to be written by writing-plans
scripts/migrations/sql/
  331_rate_limit_counters.sql                        ← new
src/lib/schemas/
  common.ts                                          ← new
src/lib/auth/
  csrf.ts                                            ← new
  withCsrf.ts                                        ← new
  sessionHelpers.ts                                  ← modified (legacy cookie removal)
src/lib/
  apiFetch.ts                                        ← new or extended
  rateLimit.ts                                       ← rewritten
middleware.ts                                        ← modified (CSRF cookie issuance + legacy removal)
next.config.js                                       ← modified (CSP directives)
pages/api/auth/login.ts                              ← modified (Zod)
pages/api/auth/register.ts                           ← modified (Zod)
pages/api/auth/reset-password.ts                     ← modified (Zod)
pages/api/accounting/bank-transactions-action.ts     ← modified (Zod + withCsrf)
pages/api/accounting/bank-rules-action.ts            ← modified (Zod + withCsrf)
pages/api/accounting/customer-invoices-detail.ts     ← modified (Zod + withCsrf)
pages/api/accounting/supplier-invoices-detail.ts     ← modified (Zod + withCsrf)
pages/api/accounting/gl-journals-detail.ts           ← modified (Zod + withCsrf)
pages/api/accounting/customer-payments.ts            ← modified (Zod + withCsrf)
pages/api/accounting/supplier-payments.ts            ← modified (Zod + withCsrf)
pages/api/accounting/credit-notes-detail.ts          ← modified (Zod + withCsrf)
pages/api/accounting/writeoffs-detail.ts             ← modified (Zod + withCsrf)
pages/api/accounting/company-logo.ts                 ← modified (Zod)
pages/api/accounting/sage-migration-action.ts        ← modified (Zod)
tests/unit/lib/rateLimit.test.ts                     ← extended
tests/integration/api/csrf.test.ts                   ← new
tests/integration/csp-headers.test.ts                ← new
tests/integration/api/zod-validation.test.ts         ← new
```

## Autonomy envelope

- Wave α can run unattended (additive migration, additive CSP, rate-limit backend swap is contained). Hard stop at gate.
- Wave β requires human review of the CSRF middleware + apiFetch diff before dispatch (frontend-affecting). Hard stop at gate.
- Wave γ can dispatch 2 concurrent Zod subagents; human review of the `common.ts` schema primitives before dispatching the 14 handler fixes.

---

## Self-review notes (completed during spec writing)

1. **Placeholder scan:** no "TBD"/"fill-in-details". Every component has concrete SQL, code sketches, and exact file paths.
2. **Internal consistency:** the 8 CSRF-protected routes are a subset of the 14 Zod-validated routes (all money-moving writes are both). That's intentional and mentioned in the per-handler list.
3. **Scope check:** 5 components, each independently specced. Plan will decompose into 3 waves with concrete tasks.
4. **Ambiguity check:** legacy cookie removal timing (waived) is justified in-line. CSP `style-src` hardening scope (deferred) is explicit.
5. **Existing patterns followed:** `withX` wrapper style matches existing `withCompany`/`withErrorHandler`/`withWriteAccess`. `apiResponse.X` helper usage unchanged. Migration uses the standard `IF NOT EXISTS` pattern.
