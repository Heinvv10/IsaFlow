# IsaFlow MCP Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose IsaFlow as a hosted remote MCP server so users connect Claude Code / Claude Desktop / claude.ai / Codex with an OAuth login (or PAT fallback) and operate their accounting — reads, draft writes, and explicitly-granted posting — under the existing tenant/RLS model.

**Architecture:** In-repo (no separate service). One Bearer-only JSON-RPC transport route (`/api/mcp`) authenticates via the existing PRD-10 PAT/OAuth tokens, establishes the same tx/GUC/RLS context as `withAuth`, and dispatches to a tenant-scoped tool registry that calls the existing service layer. OAuth discovery (`.well-known`) + dynamic client registration make "paste URL → browser login" work with zero client setup. Modeled on ApexGEO's `src/lib/mcp` (same stack) with Cortex's revocation/thin-layer lessons.

**Tech Stack:** Next.js 14 pages router, TypeScript, `sql` tagged template (`@/lib/neon`), Vitest, existing `src/lib/auth/*` (GoTrue, PAT, OAuth, scopes), Postgres RLS, bun.

## Decisions already made (Hein, 2026-07-18 — do not re-litigate)

1. **Full writes including posting are in scope.**
2. **Posting is gated:** a new `write:post` scope, **default off**, explicitly enabled per token/connection on the consent screen and PAT-mint UI. Read + draft-write scopes work without it.
3. Ships **DARK** behind per-company feature flag `mcp_connector` (SARS-ISV pattern). Hein flips pilots on.
4. PR per phase; blind `/review` per PR; final programme review + targeted pentest + live client test before any deploy.

## Global Constraints (from CLAUDE.md — every task inherits these)

- **Branch first — NEVER edit on `master`.** One branch + PR per phase: `feat/mcp-p0-auth-tests`, `feat/mcp-p1-oauth-discovery`, `feat/mcp-p2-server-read`, `feat/mcp-p3-writes`, `feat/mcp-p4-connect-ux`.
- TDD enforced: failing test → implementation → pass → commit. No stubs, no `return null` placeholders.
- Every DB query scoped by `company_id`; `sql` tagged template only; no string concatenation.
- Responses via `apiResponse.*`; logging via `log` from `@/lib/logger` (never console.log); no empty catch; 100% types; **max 300 lines per file**.
- Migrations: `IF NOT EXISTS`; next unused 3-digit prefix — **verify at execution time** with `ls scripts/migrations/sql/ | sort | tail` (505 was latest on 2026-07-18; plan assumes 506/507 — renumber if taken).
- bun (`bun run test:unit`, `bun run ci`); Node ≥ 20.12.
- Git: `env -u GITHUB_TOKEN -u GH_TOKEN` prefix for all git/gh remote ops; `timeout 420 git push` (pre-push hook builds); stage by explicit path, never `git add -A`; check branch after PR auto-merge.
- New module dir ⇒ sibling `.claude.md` (`src/lib/mcp/.claude.md`).
- Deploy: dark, via `bash scripts/deploy.sh`, never during business hours, Hein approval required. **This plan ends at "merged + verified on dev"; prod deploy is Hein-gated.**

## Security invariants (from ApexGEO pattern — enforced by tests, not convention)

- `companyId`/`userId` come from **auth context only, never from tool args**. No tool accepts a company identifier.
- Cross-tenant probes return the **same error text** as not-found (no existence enumeration).
- The MCP endpoint accepts **Bearer only — never cookies** (CSRF).
- Registry enforces scopes **before** the handler runs; posting tools additionally require `write:post`.
- Token-scan test: `JSON.stringify` every tool response; assert no `pat_`, `oat_`, `ort_`, `Bearer `, `apikey`, cookie material.
- Every `tools/call` is audit-logged with token `jti`; write tools require an idempotency key.

## File map

| File | Responsibility | Phase |
|---|---|---|
| `tests/unit/auth/{personalAccessTokens,oauth,withBearerOrCookieAuth,withScope}.test.ts` | Prove the PRD-10 boundary | 0 |
| `src/lib/auth/withBearerAuth.ts` | Strict Bearer-only wrapper (no cookie fallback) | 2 |
| `pages/api/oauth/metadata.ts`, `pages/api/oauth/resource-metadata.ts` | RFC 8414 / 9728 discovery JSON | 1 |
| `pages/api/oauth/register.ts` | RFC 7591 dynamic client registration | 1 |
| `next.config.js` (modify `rewrites()` ~line 52) | `/.well-known/*` → the two metadata routes | 1 |
| `scripts/migrations/sql/506_mcp_tool_calls.sql` | Audit + idempotency table | 2 |
| `scripts/migrations/sql/507_oauth_dynamic_clients.sql` | DCR columns + `mcp_connector` feature flag row | 1 |
| `src/lib/mcp/types.ts` | `McpTool`, `McpToolContext`, `McpToolResult` | 2 |
| `src/lib/mcp/registry.ts` | register/getManifest/call — scope fence, audit, idempotency | 2 |
| `src/lib/mcp/audit.ts` | `recordToolCall`, `findIdempotentReplay` | 2 |
| `src/lib/mcp/tools/{company,reports,invoices,contacts,bank,vat}.ts` | Read tools | 2 |
| `src/lib/mcp/tools/{writeInvoices,writeJournals,writeBank}.ts` | Write + post tools | 3 |
| `src/lib/mcp/toolIndex.ts` | Assembles `MCP_TOOLS` | 2–3 |
| `src/lib/mcp/clientMetadata.ts` | ZERO-import constants (endpoint path, prod origin, tool names) | 2 |
| `pages/api/mcp/index.ts` | JSON-RPC transport (POST/GET/OPTIONS) | 2 |
| `src/lib/auth/personalAccessTokens.ts:18` + `src/lib/auth/oauth.ts:23` (modify) | Add `read:contacts`, `read:vat`, `write:post` to `PAT_SCOPES`/`OAUTH_SCOPES` | 2–3 |
| `pages/oauth/authorize.tsx`, `pages/developer/personal-tokens.tsx` (modify) | `write:post` shown unchecked + warning styling | 3 |
| `pages/accounting/settings/integrations-mcp.tsx` + `accountingNavConfig.ts` | Connect panel (flag-gated) | 4 |
| `docs/mcp-connect.md` | User-facing connect doc | 4 |
| `scripts/mcp-smoke.sh` | Live JSON-RPC smoke against dev | 4 |
| `src/lib/mcp/__tests__/*` | Registry manifest + security proofs + drift guard | 2–3 |

---

# Phase 0 — Prove the auth boundary (branch `feat/mcp-p0-auth-tests`, PR 1)

The PRD-10 machinery (`personalAccessTokens.ts`, `oauth.ts`, `withBearerOrCookieAuth.ts`, `withScope.ts`) has **zero tests** and is about to become the security boundary for money data. This phase is tests-only (plus fixes for any real bug the tests expose — fixes need their own failing test first).

### Task 0.1: PAT lifecycle tests

**Files:**
- Test: `tests/unit/auth/personalAccessTokens.test.ts`
- Read first: `src/lib/auth/personalAccessTokens.ts` (mint/verify/revoke API), `scripts/migrations/sql/467_personal_access_tokens.sql` (schema), existing service-test mocking pattern in `tests/unit/services/` (mock the `sql` template the way neighbouring tests do)

**Interfaces:** Produces the mock-DB harness (`mockSqlOnce(rows)`) reused by Tasks 0.2–0.4 — export it from `tests/unit/auth/helpers.ts`.

- [x] **Step 1: Write failing tests** covering, at minimum:

```typescript
// tests/unit/auth/personalAccessTokens.test.ts — names are the spec; write real assertions per the actual API you read in Step 0
it('mints pat_ prefixed token and stores only the SHA-256 hash, never the raw token');
it('verify returns user+company+scopes for a valid unexpired token');
it('verify rejects an expired token');
it('verify rejects a revoked token');
it('verify rejects a tampered token (one flipped char → hash mismatch)');
it('rejects minting with a scope outside PAT_SCOPES');
it('caps expiry at 365 days');
```

- [x] **Step 2:** `bun run test:unit tests/unit/auth/personalAccessTokens.test.ts` → all FAIL (or error: file missing)
- [x] **Step 3:** Fill in real assertions against the actual exported functions; mock DB rows to match migration 467 columns. If a test exposes a genuine bug, fix the lib with its own red→green cycle.
- [x] **Step 4:** Re-run → ALL PASS
- [x] **Step 5:** Commit: `test(auth): PAT lifecycle coverage (PRD-10 layer 3)` — done: `75de47c3`, 17/17 pass, no lib bugs exposed

### Task 0.2: OAuth token endpoint tests

**Files:**
- Test: `tests/unit/auth/oauth.test.ts`
- Read first: `src/lib/auth/oauth.ts`, `pages/api/oauth/token.ts:76`, `scripts/migrations/sql/469_oauth.sql`

- [x] **Step 1: Failing tests:** auth-code exchange happy path; PKCE S256 verifier mismatch rejected; auth code single-use (second exchange rejected); refresh rotation (old `ort_` rejected after use — replay defence); refresh of a revoked authorisation rejected; scopes on minted `oat_` ⊆ scopes consented.
- [x] **Step 2:** Run → FAIL. **Step 3:** Implement assertions (fix real bugs TDD-style). **Step 4:** PASS. **Step 5:** Commit `test(auth): OAuth code+PKCE+refresh coverage`. — done: 10/10 pass, auth dir 126/126; note mig 470 already made refresh_token_hash nullable (not a bug)

### Task 0.3: withBearerOrCookieAuth tests

**Files:**
- Test: `tests/unit/auth/withBearerOrCookieAuth.test.ts`
- Read first: `src/lib/auth/withBearerOrCookieAuth.ts` (esp. lines ~76 dispatch, ~128–136 GUC setup + membership re-check)

- [x] **Step 1: Failing tests:** `Bearer pat_…` valid → handler runs with `req.user/companyId/scopes` attached and GUCs set (`request.jwt.claims`, `app.current_company_id`); same for `oat_…`; invalid/expired token → 401 **without** cookie fallback being attempted for a Bearer-presenting request; membership revoked after mint → 401/403 (the `company_users` re-check); no Authorization header → falls back to cookie `withAuth` path; malformed Bearer scheme → 401.
- [x] **Steps 2–5:** red → assert → green → commit `test(auth): dual-auth wrapper coverage`. — done: `dd38f78a`, 8/8 pass, auth dir 134/134. Reality note: non-Bearer schemes (e.g. Basic) fall through to cookie auth by design (extractBearerToken only strips `Bearer `); "malformed" = `Bearer` + unsupported prefix → 401.

### Task 0.4: withScope tests

**Files:**
- Test: `tests/unit/auth/withScope.test.ts` (source `src/lib/auth/withScope.ts` — small, read fully)

- [x] **Step 1: Failing tests:** cookie session (`req.scopes` undefined) → no-op pass-through; Bearer with required scope → pass; Bearer missing scope → 403 `INSUFFICIENT_SCOPE`; array form passes when ANY required scope present.
- [x] **Steps 2–5:** red → green → commit `test(auth): withScope gate coverage`. — done: 6/6 pass, auth dir 140/140

### Task 0.5: PR 1

- [x] `bun run ci` clean → push (`timeout 420`, `env -u GITHUB_TOKEN -u GH_TOKEN`) → PR titled `test(auth): PRD-10 auth machinery test suite (MCP phase 0)` → **blind `/review`** → merge. — done: PR #224 merged `8c5440e1`. Blind review (2 reviewers): round 1 REQUEST_CHANGES (HIGH: validateOauthAccessToken zero coverage; MEDIUMs: app-binding unpinned, single-use mock theatre, tautology, rate-limit/22P02/handler-throw branches); fixed in `5af14a4f` (+15 tests, suite 155/155); round 2 both APPROVED. Deferred LOWs documented in PR comment; pg integration test noted for Phase 5 Gate D.

---

# Phase 1 — OAuth discovery + dynamic client registration (branch `feat/mcp-p1-oauth-discovery`, PR 2)

Claude clients discover auth via RFC 9728/8414 and self-register via RFC 7591. This is the difference between "paste URL, click Connect, log in" and "read a setup doc". IsaFlow's authorize/consent/token endpoints already exist — this phase only adds discovery + registration around them.

### Task 1.1: Migration 507 — DCR columns + feature flag

**Files:**
- Create: `scripts/migrations/sql/507_oauth_dynamic_clients.sql`
- Read first: `scripts/migrations/sql/469_oauth.sql` for the **exact** apps-table name/columns, and the feature-flags migration (grep `featureFlagService.ts` for its table name) for the flag-row insert shape.

- [x] **Step 1:** Write migration (adapt table/column names to what 469 actually created): — DEVIATIONS: renumbered 507→506 (next unused vs master; Phase 2 audit table will take 507); feature_flags has `is_global` not `enabled_by_default` (dark = is_global=false + no plan row); ALSO relaxed NOT NULLs on client_secret_hash/client_secret_prefix/owner_user_id (469 forbids public secret-less ownerless DCR clients) + CHECK on token_endpoint_auth_method

```sql
-- 507_oauth_dynamic_clients.sql
ALTER TABLE oauth_apps ADD COLUMN IF NOT EXISTS is_dynamic boolean NOT NULL DEFAULT false;
ALTER TABLE oauth_apps ADD COLUMN IF NOT EXISTS token_endpoint_auth_method text NOT NULL DEFAULT 'client_secret_post';
CREATE INDEX IF NOT EXISTS oauth_apps_is_dynamic_idx ON oauth_apps (is_dynamic) WHERE is_dynamic;
-- feature flag (mirror the existing flags table insert pattern; ON CONFLICT DO NOTHING)
INSERT INTO feature_flags (code, name, enabled_by_default)
VALUES ('mcp_connector', 'MCP Connector (AI agents)', false)
ON CONFLICT (code) DO NOTHING;
```

- [x] **Step 2:** `bun run db:migrate` against local `isaflow_dev` → applies clean. Commit `feat(mcp): migration 507 — dynamic OAuth clients + mcp_connector flag`. — done: applied ok (35ms), verified via psql (flag dark, columns nullable), committed `fc904d2c` as 506

### Task 1.2: Discovery metadata endpoints

**Files:**
- Create: `pages/api/oauth/metadata.ts`, `pages/api/oauth/resource-metadata.ts`
- Test: `tests/unit/mcp/discovery.test.ts`
- Modify: `next.config.js` `rewrites()` (~line 52)

**Interfaces — Produces:** `GET /.well-known/oauth-authorization-server` and `GET /.well-known/oauth-protected-resource` (both unauthenticated, cache 5 min).

- [x] **Step 1: Failing tests:** metadata includes `issuer`, `authorization_endpoint` ending `/oauth/authorize`, `token_endpoint` ending `/api/oauth/token`, `registration_endpoint` ending `/api/oauth/register`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported` includes `"none"`, `scopes_supported` === `OAUTH_SCOPES`; resource-metadata includes `resource` ending `/api/mcp` and `bearer_methods_supported: ["header"]`.
- [x] **Step 2:** Run → FAIL. **Step 3:** Implement both routes (plain `NextApiHandler`, no auth wrapper, `res.setHeader('Cache-Control','public, max-age=300')`; origin from `process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za'`). Add rewrites:

```js
{ source: '/.well-known/oauth-authorization-server', destination: '/api/oauth/metadata' },
{ source: '/.well-known/oauth-protected-resource', destination: '/api/oauth/resource-metadata' },
{ source: '/.well-known/oauth-protected-resource/api/mcp', destination: '/api/oauth/resource-metadata' },
```

- [x] **Step 4:** Tests PASS + `curl localhost:3200/.well-known/oauth-authorization-server` returns the JSON. **Step 5:** Commit `feat(mcp): OAuth discovery endpoints (RFC 8414/9728)`. — done: 5/5 tests, all 3 well-known routes curl-verified live (incl. /api/mcp variant), committed `3b3d725c`. Note: tests import handlers via relative path (`@/` alias maps to src/ only).

### Task 1.3: Dynamic client registration

**Files:**
- Create: `pages/api/oauth/register.ts`
- Test: `tests/unit/mcp/register.test.ts`
- Read first: how `pages/api/developer/oauth-apps/index.ts` creates an app row (reuse its service function — do not duplicate insert SQL).

**Interfaces — Produces:** `POST /api/oauth/register` per RFC 7591: accepts `{redirect_uris: string[], client_name?, grant_types?, response_types?, token_endpoint_auth_method?}`; returns 201 `{client_id, client_name, redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code","refresh_token"]}` — **public client, no secret, PKCE mandatory at authorize time**.

- [x] **Step 1: Failing tests:** valid registration → 201 with `client_id` and NO `client_secret`; `redirect_uris` missing/empty → 400; non-https redirect URI rejected **except** `http://localhost:*` and `http://127.0.0.1:*` (loopback per RFC 8252 — Claude Code/Codex use loopback callbacks); >5 redirect URIs → 400; rate-limited per IP (mock `checkRateLimit` → assert called with an `oauth-register` bucket, 10/hour).
- [x] **Step 2:** FAIL. **Step 3:** Implement: no auth wrapper; `withRateLimit` from `src/lib/rateLimit.ts`; validate; create app row with `is_dynamic = true`, `token_endpoint_auth_method = 'none'`. Confirm the authorize/consent flow (`pages/oauth/authorize.tsx`, `pages/api/oauth/consent.ts`) accepts a dynamic public client + enforces PKCE for `token_endpoint_auth_method='none'` — if `pages/api/oauth/token.ts` currently requires a client secret for all clients, extend it: secret NOT required when the app row says `'none'`, PKCE verifier REQUIRED instead (add a token-endpoint test for this in `tests/unit/auth/oauth.test.ts`).
- [x] **Step 4:** PASS. **Step 5:** Commit `feat(mcp): RFC 7591 dynamic client registration (public clients, PKCE-only)`. — done: `f2d6cbcd`, 14 new tests, full suite 4747 green, tsc clean. DEVIATIONS: token.ts needed NO extension (isConfidential already derived from hash presence; PKCE already unconditional — proven by tests); token-endpoint tests in tests/unit/auth/oauthTokenEndpoint.test.ts (not oauth.test.ts) for the 300-line cap; extended registerOauthApp with dynamic mode rather than new insert SQL.

### Task 1.4: PR 2

- [x] `bun run ci` → push → PR `feat(mcp): OAuth discovery + dynamic client registration` → blind `/review` → merge. — done: PR #225 merged `6b1c0a90`. Blind review round 1: 2× REQUEST_CHANGES — HIGH: mig-469 owner-only RLS 404'd all dynamic-app consent (fixed: oauth_apps_dynamic_read SELECT policy, psql-proven); HIGH pre-existing: consent.ts trusted body.companyId (fixed: membership gate + UUID check); MEDIUMs: MCP_DCR_ENABLED kill switch (dark by default), pruneStaleDynamicApps, 8kb/512-char caps, [::1]; fixes `0ff60d33`, both reviewers re-verified & APPROVED (incl. live-DB policy + checksum verification). NOTE for Gate C: dev needs MCP_DCR_ENABLED=true to test DCR.

---

# Phase 2 — MCP transport + read-only tool registry (branch `feat/mcp-p2-server-read`, PR 3)

### Task 2.1: Migration 506 — audit + idempotency table

**Files:** Create `scripts/migrations/sql/506_mcp_tool_calls.sql` (read `468_personal_access_tokens_rls.sql` first and mirror its RLS enable/policy shape).

- [x] **Step 1:** (shipped as 507_mcp_tool_calls.sql)

```sql
-- 506_mcp_tool_calls.sql
CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_jti text,
  oauth_app_id uuid,
  tool text NOT NULL,
  args_hash text NOT NULL,
  idempotency_key text,
  status text NOT NULL CHECK (status IN ('ok','error','rejected')),
  result jsonb,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_tool_calls_idem_uq
  ON mcp_tool_calls (company_id, tool, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_tool_calls_company_created_idx
  ON mcp_tool_calls (company_id, created_at DESC);
ALTER TABLE mcp_tool_calls ENABLE ROW LEVEL SECURITY;
-- + company-scoped RLS policy mirroring migration 468's pattern
```

- [x] **Step 2:** `bun run db:migrate` clean → commit `feat(mcp): migration 506 — mcp_tool_calls audit/idempotency`. — done as **507** (506 taken); applied ok (271ms); RLS uses the modern 442/498 idiom (auth.user_companies()/app.current_company_id(), FORCE RLS, append-only grants) rather than 468's user-scoped shape; user_id is text (FK-free, matches users.id type)

### Task 2.2: Types + registry (TDD, security proofs first)

**Files:**
- Create: `src/lib/mcp/types.ts`, `src/lib/mcp/registry.ts`, `src/lib/mcp/audit.ts`, `src/lib/mcp/.claude.md`
- Test: `src/lib/mcp/__tests__/registry.test.ts`

**Interfaces — Produces (later tasks depend on these exact shapes):**

```typescript
// src/lib/mcp/types.ts
export interface McpToolContext {
  userId: string;
  companyId: string;          // from auth ONLY — never from args
  scopes: string[];
  tokenJti: string | null;
  oauthAppId: string | null;
}
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;       // JSON Schema
  scope: string | null;                       // null = any authenticated token
  write: boolean;                             // write tools REQUIRE args.idempotency_key
  requiresPost?: boolean;                     // additionally requires 'write:post'
  handler(args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult>;
}
// registry.ts
export class McpRegistry {
  register(tool: McpTool): void;              // throws on duplicate name
  getManifest(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  call(name: string, args: Record<string, unknown>, ctx: McpToolContext): Promise<McpToolResult>;
}
// audit.ts
export async function recordToolCall(row: { ctx: McpToolContext; tool: string; argsHash: string; idempotencyKey: string | null; status: 'ok' | 'error' | 'rejected'; result: unknown; durationMs: number }): Promise<void>;
export async function findIdempotentReplay(companyId: string, tool: string, key: string): Promise<McpToolResult | null>;
```

- [x] **Step 1: Failing security-proof tests** (ApexGEO TDD order — the fence is in the registry, provably before the handler): — tests at tests/unit/mcp/registry.test.ts (vitest include is tests/unit/** only)

```typescript
// __tests__/registry.test.ts
it('unknown tool → isError result (not a throw)');
it('missing scope → rejected BEFORE handler runs', async () => {
  const handler = vi.fn();
  registry.register({ name: 't', scope: 'read:reports', write: false, /*…*/ handler });
  const r = await registry.call('t', {}, ctxWithScopes(['read:invoices']));
  expect(r.isError).toBe(true);
  expect(handler).not.toHaveBeenCalled();          // ← proves early fence
});
it('write tool without idempotency_key → rejected before handler');
it('requiresPost without write:post scope → rejected before handler, error text does not mention other scopes');
it('write tool replay with same idempotency_key → returns stored result, handler NOT called again');
it('happy path → handler called with ctx, result audited with status ok');
it('handler throw → isError result, audited with status error, message is generic (no stack/SQL leaked)');
```

- [x] **Step 2:** FAIL. **Step 3:** Implement types/registry/audit. `call()` order: resolve tool → scope check → `write:post` check → idempotency-key presence (write) → replay lookup → handler → audit. `argsHash` = SHA-256 of canonical JSON. Audit insert uses `sql` and includes `company_id` (RLS holds because tools run inside the request's GUC context). **Step 4:** PASS. **Step 5:** Commit `feat(mcp): tool registry with scope fence, audit, idempotency`. — done: `d2963d12`, 11/11 security proofs, tsc clean, .claude.md added. Known bound documented: concurrent same-key writes both pass replay lookup (unique index bounds the audit, not the handler).

### Task 2.3: Strict Bearer wrapper

**Files:**
- Create: `src/lib/auth/withBearerAuth.ts`
- Modify: `src/lib/auth/withBearerOrCookieAuth.ts` (extract the shared bearer-validation+context pipeline into an exported internal helper so both wrappers use ONE pipeline — no logic duplication)
- Test: `tests/unit/auth/withBearerAuth.test.ts`

**Interfaces — Produces:** `withBearerAuth(handler)` — identical context/GUC/membership behaviour to the Bearer branch of `withBearerOrCookieAuth`, but **absent/invalid Bearer → 401 with `WWW-Authenticate: Bearer realm="IsaFlow MCP", resource_metadata="<origin>/.well-known/oauth-protected-resource"`. Never falls back to cookies.** (The challenge header is how Claude clients discover they must run the OAuth flow.)

- [x] **Step 1: Failing tests:** no header → 401 + `WWW-Authenticate` present; valid cookie but no Bearer → still 401 (cookies ignored); valid `pat_`/`oat_` → handler runs with scopes attached; Phase-0 membership-revoked case holds here too.
- [x] **Steps 2–5:** red → green (refactor-extract, don't duplicate) → commit `feat(auth): strict Bearer-only wrapper for MCP endpoint`. — done: `4c1ba0d9`; pipeline extracted to src/lib/auth/bearerPipeline.ts (both wrappers share it); 7 new tests; existing dual-wrapper suites pass unchanged (refactor proof); auth dir all green, tsc clean

### Task 2.4: JSON-RPC transport route

**Files:**
- Create: `pages/api/mcp/index.ts`, `src/lib/mcp/clientMetadata.ts`
- Test: `src/lib/mcp/__tests__/transport.test.ts`
- Read first: ApexGEO `/home/hein/Workspace/ApexGEO/src/app/api/v1/mcp/route.ts` (the pattern — adapt App Router → pages router `req/res`).

**Interfaces — Consumes:** `withBearerAuth` (2.3), `McpRegistry` (2.2), `hasFeature` from `src/modules/admin/services/featureFlagService.ts:178` (verify exact signature), `checkRateLimit` from `src/lib/rateLimit.ts`.

- [x] **Step 1: Failing tests:** `initialize` → `{protocolVersion: "2025-06-18", serverInfo: {name: "isaflow"}, capabilities: {tools: {listChanged: false}}}`; `notifications/initialized` and `ping` handled; `tools/list` → registry manifest; `tools/call` dispatches with ctx built from `req` (companyId/userId/scopes/jti — **never from params**); unknown method → JSON-RPC `-32601`; malformed body → `-32700`; batch array supported; company without `mcp_connector` feature → every method returns `-32001` "MCP connector not enabled for this company"; per-company rate limit (120 req/min) → `-32000` when exceeded; GET → unauthenticated server-info JSON (name, endpoint, auth discovery URLs, tool names from `clientMetadata.ts`); OPTIONS → 204 + CORS headers (`Authorization, Content-Type` / `GET, POST, OPTIONS`).
- [x] **Step 2:** FAIL. **Step 3:** Implement. `clientMetadata.ts` = ZERO imports (ApexGEO bundle-safety pattern): `MCP_PATH = '/api/mcp'`, prod origin, `CLIENT_MCP_TOOL_NAMES`, with a drift-guard test vs `toolIndex.ts` (`src/lib/mcp/__tests__/clientMetadata.test.ts`). Wrap: `export default withBearerAuth(withErrorHandler(handler as any))`. Respect the 300-line cap — JSON-RPC helpers into `src/lib/mcp/jsonrpc.ts` if needed. **Step 4:** PASS. **Step 5:** Commit `feat(mcp): JSON-RPC transport at /api/mcp (Bearer-only, flag-gated, rate-limited)`. — done: `ef994e9b`, 13/13 transport tests, tsc clean. DEVIATIONS: only POST wrapped in withBearerAuth (GET server-info + OPTIONS preflight must be unauthenticated for discovery); drift-guard test lands with toolIndex registrations in 2.6; plan says 14 read tools but its own table lists 15 — implementing all 15.

### Task 2.5: Scope additions (read)

**Files:** Modify `src/lib/auth/personalAccessTokens.ts:18` (`PAT_SCOPES`) and `src/lib/auth/oauth.ts:23` (`OAUTH_SCOPES`): add `'read:contacts'`, `'read:vat'`. Test: extend Phase-0 scope tests (minting with new scopes valid; consent screen at `pages/oauth/authorize.tsx` renders them — verify how it sources the scope list; if hardcoded, point it at the exported consts).

- [x] Red → green → commit `feat(auth): read:contacts + read:vat scopes`. — done: `28047f8c`, 220 tests green, tsc clean. Consent screen WAS hardcoded → now Record<OAuthScope,…> (tsc-exhaustive); PAT-mint UI now builds from PAT_SCOPE_META; PAT_SCOPES moved to zero-import patScopes.ts for bundle safety.

### Task 2.6: Read tools (14)

**Files:** Create `src/lib/mcp/tools/{company,reports,invoices,contacts,bank,vat}.ts`, `src/lib/mcp/toolIndex.ts`. Test: `src/lib/mcp/__tests__/tools-read.test.ts`.

**Method:** Every tool calls the **same service function its REST route uses** — locate the route file listed as anchor, read which `src/modules/accounting/services/*` function it calls, call that function. Tools never write SQL. Full exemplar (write every other tool to this exact shape):

```typescript
// src/lib/mcp/tools/reports.ts (exemplar — trial_balance)
import type { McpTool, McpToolContext, McpToolResult } from '../types';
// import the SAME service the reports-trial-balance route uses, e.g.:
// import { getTrialBalance } from '@/modules/accounting/services/reports/trialBalanceService';

function ok(data: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export const trialBalanceTool: McpTool = {
  name: 'trial_balance',
  description: 'Trial balance for the connected company as at a date (defaults to today). Amounts in ZAR.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: { as_at: { type: 'string', format: 'date', description: 'YYYY-MM-DD; defaults to today' } },
    additionalProperties: false,
  },
  handler: async (args, ctx: McpToolContext) => {
    const asAt = typeof args.as_at === 'string' ? args.as_at : undefined;
    const rows = await getTrialBalance(ctx.companyId, asAt);   // companyId from ctx ONLY
    return ok(rows);
  },
};
```

Tool table (name → scope → REST-route anchor under `pages/api/accounting/`):

| Tool | Scope | Route anchor (find its service, reuse it) |
|---|---|---|
| `company_profile` | null | company/settings route (name, VAT no, fiscal year, base currency) |
| `trial_balance` | read:reports | `reports-trial-balance*` |
| `profit_and_loss` | read:reports | `reports-profit-loss*` / income-statement report |
| `balance_sheet` | read:reports | `reports-balance-sheet*` |
| `aged_debtors` | read:reports | debtors age-analysis report |
| `aged_creditors` | read:reports | creditors age-analysis report |
| `search_gl` | read:reports | GL / journal-lines listing (params: account, date range, text; cap 200 rows) |
| `list_invoices` | read:invoices | `customer-invoices` index GET (params: status, date range, customer; cap 100) |
| `get_invoice` | read:invoices | `customer-invoices/[id]` GET (remember `COALESCE(ci.client_id, ci.customer_id)` quirk lives in the service) |
| `list_quotes` | read:invoices | quotes index GET |
| `list_customers` | read:contacts | customers index GET (incl. balances if the service returns them) |
| `list_suppliers` | read:contacts | suppliers index GET |
| `bank_accounts_status` | read:bank-tx | bank accounts index (balances + unreconciled counts) |
| `list_bank_transactions` | read:bank-tx | bank transactions listing (params: account_id, allocated/unallocated, date range; cap 200) |
| `vat_status` | read:vat | VAT201/VAT-return current-period summary route |

- [x] **Step 1: Failing tests per tool** (mock the service): happy path returns `ok(data)`; service args receive `ctx.companyId`; a `not found` from the service → generic "Not found" text (no tenant hints). Plus suite-wide: **token-scan test** (stringify every tool's mocked result envelope + manifest; assert no `pat_|oat_|ort_|Bearer |apikey`), and **manifest test** (14 tools registered, all `write: false`, every `inputSchema.additionalProperties === false`).
- [x] **Step 2:** FAIL. **Step 3:** Implement tools + `toolIndex.ts` (register all; keep per-file ≤300 lines). Dates: pg returns `Date` objects — serialize with the project's `fmtDate` from `src/lib/neon.ts` (NEVER `toISODate` — UTC+2 rollback pitfall). **Step 4:** PASS. **Step 5:** Commit per tool file: `feat(mcp): read tools — reports`, `… — invoices/contacts/bank/vat/company`. — done: `ecf03c71` (verbatim extraction of 5 inline-SQL routes into shared read services — the plan's "call the same service" assumption didn't hold for 8 anchors) + `b438c0be` (15 tools — plan's table has 15 not 14; aged_* reuse existing ar/ap aging services; bank-tx cap 100 per service reality; trial_balance fiscal-period keyed with today default). Full suite 4810 green, tsc clean, drift guard live.

### Task 2.7: PR 3

- [x] `bun run ci` → migration order re-verified vs master → push → PR `feat(mcp): MCP server — transport + 14 read-only tools (dark)` → blind `/review` → merge. — done: PR #226 merged `41659686`. 3 blind reviewers (security APPROVED, correctness APPROVED — all 5 SQL extractions verified identical vs master, quality REQUEST_CHANGES); fixes `71157a47` (audit result data-minimisation, oauth.ts trimmed 600→593, audit-catch tests, apiResponse-deviation doc, magic-number). Deferred+documented: oauth.ts full split (programme review), supplier cache boundary (LOW), batch-on-shared-client + idempotency TOCTOU (Phase 3 concerns). CI green, 65 MCP tests.

---

# Phase 3 — Write + post tools (branch `feat/mcp-p3-writes`, PR 4)

### Task 3.1: `write:post` scope + consent/mint UI gating

**Files:**
- Modify: `src/lib/auth/personalAccessTokens.ts` + `src/lib/auth/oauth.ts` (add `'write:post'`), `pages/oauth/authorize.tsx`, `pages/developer/personal-tokens.tsx`
- Test: extend `tests/unit/auth/*` + a component/behaviour test matching however the repo currently tests pages (if no page-test precedent exists, cover via the API layer: consent submission granting `write:post` only when explicitly ticked).

**Behaviour (the Hein decision — implement exactly):** `write:post` appears with warning styling ("Allows this app to POST journals and finalize documents — irreversible entries") and is **unchecked by default even when the client requested it**; consent/mint must not include it unless the user ticks it.

- [x] Red (consent submits without tick → granted scopes exclude `write:post`; with tick → included) → green → commit `feat(auth): write:post scope, explicit opt-in on consent + PAT mint`. — done: `c30cd401`, 250 auth/mcp tests green, tsc clean. Gating logic in zero-import consentScopes.ts (partitionRequestedScopes/buildGrantedScopes, unit-tested); consent screen splits write:post into an unchecked amber checkbox even when requested; PAT mint renders it amber, default set = read:reports only. No page-test precedent → covered via the pure helper (per plan).

### Task 3.2: Draft-write tools

**Files:** Create `src/lib/mcp/tools/{writeInvoices,writeJournals,writeBank}.ts`; modify `toolIndex.ts`. Test: `src/lib/mcp/__tests__/tools-write.test.ts`.

| Tool | Scope | write | requiresPost | Behaviour (reuse the service the REST route uses) |
|---|---|---|---|---|
| `create_draft_invoice` | write:invoices | ✓ | — | Creates customer invoice in **draft** status. Args: customer_id, line items (description, qty, unit_price, vat treatment), dates. Returns id + totals incl. VAT. |
| `create_draft_quote` | write:invoices | ✓ | — | Same shape, quotes service. |
| `create_draft_journal` | write:journals | ✓ | — | Creates **unposted** journal. Args: date, memo, lines[{account_code, debit, credit}]. Validates balanced (service does; assert error path). |
| `suggest_bank_allocation` | write:bank-tx | ✓ | — | Records an allocation **suggestion** for a bank tx (existing suggestion state from bank-rules work — reuse it; do NOT auto-apply). |
| `post_journal` | write:journals | ✓ | ✓ | Posts an existing draft journal by id via the same service the UI post action uses. |
| `finalize_invoice` | write:invoices | ✓ | ✓ | Moves draft invoice → approved/final via the existing approval service (whatever status transition the UI uses — mirror it exactly, including numbering). |

Hard rules: every handler passes `args.idempotency_key` through registry (already enforced by 2.2); no tool deletes anything; no tool touches posted records except via the service's own reversal/approval flows; `post_journal`/`finalize_invoice` return the service's validation errors verbatim-but-generic (no SQL).

- [x] **Step 1: Failing tests:** per tool happy path (mock service, assert ctx.companyId + draft/unposted status requested); `post_journal` without `write:post` in ctx → rejected pre-handler (already proven generically in 2.2 — here assert the specific tool declares `requiresPost: true` via a manifest test: `expect(tools.filter(t => t.requiresPost).map(t => t.name)).toEqual(['post_journal','finalize_invoice'])`); replay test with a real-ish flow (same idempotency_key twice → single service call). Token-scan + `additionalProperties: false` suite tests extended to write tools.
- [x] **Steps 2–5:** red → green → commits per file → PR 4 `feat(mcp): write tools — drafts for all, posting behind write:post` → blind `/review` → merge. — DONE: PR #227 merged `a093b681`. Blind review (2 reviewers): security APPROVED; correctness REQUEST_CHANGES (HIGH: write:post opt-in was client-only → made consent.ts server-authoritative via explicit optInConfirmed; MEDIUM: safeErrorText generic-ifies pg errors; MEDIUM: added untested catch-branch tests), fixes `a00e103b`, both reconfirmed APPROVED (271/271 tests, tsc clean). DEVIATIONS: create_draft_invoice + finalize_invoice had no service → extracted verbatim (customerInvoiceCreate/ApprovalService); create_draft_journal lines use account_id (UUID) not account_code; folded a Task-3.1 rules-of-hooks fix.

---

# Phase 4 — Connect UX, docs, smoke (branch `feat/mcp-p4-connect-ux`, PR 5)

### Task 4.1: Settings panel

**Files:** Create `pages/accounting/settings/integrations-mcp.tsx`; modify `src/components/accounting/accountingNavConfig.ts` (nav rule). Gate visibility with the same `mcp_connector` feature check the transport uses (client-side via whatever features endpoint the admin platform exposes to tenants — find how other flag-gated pages do it and mirror).

Content: endpoint URL (`https://app.isaflow.co.za/api/mcp`), "Connect Claude" instructions (Claude Code: `claude mcp add --transport http isaflow https://app.isaflow.co.za/api/mcp`; claude.ai: Settings → Connectors → Add custom connector; Codex: PAT bearer config snippet), link to existing PAT mint page (`/developer/personal-tokens`) as the no-OAuth fallback, link to connected-apps revoke page (`/accounting/settings/connected-apps`). Reuse `McpTokenReveal`-style UX from FibreFlow's `CortexConnectPanel.tsx` as a design reference only.

- [x] Implement (frontend-design plugin conventions) → nav entry → commit `feat(mcp): connect panel in settings (flag-gated)`. — done: type-check + lint clean. Gated via existing /api/features/check?code=mcp_connector (reads json.data.enabled — the tenant-facing feature endpoint FeatureGate uses); reuses clientMetadata (MCP_PROD_ENDPOINT + CLIENT_MCP_TOOL_NAMES); nav entry in navSections/settings.ts (the real source imported by accountingNavConfig.ts).

### Task 4.2: User doc + smoke script

**Files:** Create `docs/mcp-connect.md` (tools table, scopes, write:post explanation, client setup per client — mirror structure of `/home/hein/Workspace/Cortex/docs/cortex-mcp-connect.md`); create `scripts/mcp-smoke.sh`:

```bash
#!/usr/bin/env bash
# Usage: ISAFLOW_MCP_TOKEN=pat_xxx bash scripts/mcp-smoke.sh https://dev-host
set -euo pipefail
BASE="${1:?base url}"; AUTH="Authorization: Bearer ${ISAFLOW_MCP_TOKEN:?token}"
curl -sf "$BASE/.well-known/oauth-authorization-server" | grep -q authorization_endpoint
curl -sf -X POST "$BASE/api/mcp" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | grep -q '"isaflow"'
curl -sf -X POST "$BASE/api/mcp" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | grep -q trial_balance
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/mcp" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list"}')" = "401" ]  # no auth → 401 + WWW-Authenticate challenge
echo "MCP smoke OK"
```

- [x] Commit → PR 5 `feat(mcp): connect UX + docs + smoke` → blind `/review` → merge. — done: PR #228 merged `fdbc0b96`. Blind review APPROVED (verified feature-gate unwrap, fail-closed, no XSS, doc↔code cross-check, smoke 401 assertion); 2 LOW script nits (trailing-slash, failure-message) fixed `75c164d1`.

---

# Phase 5 — Programme review & verification gate (no new features)

Run AFTER PR 5 merges. All four gates must pass before Hein is asked to flip any flag or approve prod deploy.

### Gate A — Blind full-programme review
- [x] Invoke `/review` on the full range `master..<first-phase-base>` equivalent (the union diff of PRs 1–5). Reviewer gets diff + CLAUDE.md only — no session context. Findings verbatim; fix P0/P1 via TDD on a fix branch. — DONE: 2 blind full-programme reviewers (security + correctness) over the 8464-line union diff. Findings: 2 P1 (commit-before-flush lost in bearerPipeline extraction; idempotency ignored args_hash) + 3 P2 (audit ON CONFLICT/batch concurrency; batch rate-limit bypass; authorize.tsx >300 lines). All fixed TDD on `fix/mcp-p5-gate-a` → PR #229 merged `d900b5a2`; blind re-review APPROVED incl. a self-initiated savepoint-wrap of write handlers (closes partial-write-on-throw). 280 tests, CI green, ON CONFLICT DB-verified. Accepted residuals: P3 dead scaffolding (withBearerOrCookieAuth/withScope no prod callers), flag gates only /api/mcp, pre-existing oauth.ts/personal-tokens.tsx size debt.

### Gate B — Targeted pentest
- [x] Invoke `/pentest` **targeted** at: `/api/mcp`, `/api/oauth/register|token|metadata|resource-metadata`, `pages/oauth/authorize.tsx`, `src/lib/auth/{withBearerAuth,withBearerOrCookieAuth,withScope,personalAccessTokens,oauth}.ts`, `src/lib/mcp/**`. Explicit checks: cross-tenant probes via every tool; scope escalation (read token calling writes; write token calling post); cookie-CSRF against `/api/mcp`; DCR abuse (open-redirect via redirect_uris, registration flooding); idempotency-replay integrity; token leakage in responses/logs. — DONE: 3 adversarial agents; rating **2 CRIT / 0 HIGH / 4 MEDIUM / 3 LOW**. Both CRIT (concurrent double-post via unlocked replay-check; client_secret/refresh_token logged plaintext) + the exploitable MEDIUM (FK-linkage args not company-validated) + a LOW (body cap) FIXED in PR #230 (`34091636`), blind-review APPROVED. Report: `~/.claude/scratchpad/2026-07-19_pentest-isaflow-mcp/report.md`. The 4 MEDIUM/LOW hardening residuals (DCR global flood cap, reserved brand-name filter, company-scoped shared read joins, pre-auth IP throttle on /api/mcp) were subsequently CLOSED in PR #231 (`8072f6e0`), blind-review APPROVED — join-scoping verified to drop only the 1 known-corrupt Britech line, 0 legit rows.

### Gate C — Live E2E from a real client (dev) — **VALIDATED live (Hein-authorised 2026-07-19)**; browser-OAuth click-through remains for a real client
> Ran on a fresh dev server (isolated git worktree at current master `0dca5e36`, port 3210, `MCP_DCR_ENABLED=true`, `NEXT_PUBLIC_APP_URL=localhost:3210`) against the real `isaflow_dev` DB with the `mcp_connector` flag armed for the Demo company. Drove the full flow with two minted PATs (the plan's no-OAuth path) — one with `write:post`, one without. All assertions passed; teardown clean (server stopped, worktree/DCR-client removed, PATs revoked, flag returned to dark). The one piece a PAT can't exercise is the **browser OAuth consent UI** (`claude mcp add` → login → tick `write:post`) — everything it gates is proven below via PAT scopes.
- [x] Deploy to dev + run `scripts/mcp-smoke.sh` → **`MCP smoke OK`** (discovery, authed initialize=`isaflow`, tools/list, unauth tools/call → 401 challenge).
- [x] Live tool flow (PAT-driven, = what the OAuth token would carry): `tools/list` = **21 tools**; `trial_balance` → 18 rows for the open period (no error); `create_draft_journal` (write:journals) → **draft** id `a7150db3`; `post_journal` **without** write:post → **rejected** ("requires the write:post permission"); `post_journal` **with** write:post → **posted** (DB: status=posted, posted_at set, balanced 100=100); audit rows in `mcp_tool_calls` carry the correct token jti per call (incl. the rejection audited `rejected`).
- [x] Cross-tenant proof on live dev: Demo token → `get_invoice` with a company-B (d27bac33) invoice id → **generic "Not found"** (no leak).
- [x] BONUS (Gate A/B fixes verified live): FK-ownership — `create_draft_journal` with a foreign `account_id` → rejected; `create_draft_invoice` with a foreign `customer_id` → Not found. Idempotency — repeat `post_journal` with the same key → **replayed stored result, no double-post** (DB: exactly 1 journal). DCR — `POST /api/oauth/register` → **201 public client** (auth_method none, no secret).
- [ ] **Remaining for Hein / a real client:** the browser OAuth consent click-through (`claude mcp add --transport http isaflow <dev-url>/api/mcp` → login as admin@isaflow.co.za → tick `write:post`) — validates the consent UI + oat_ token path end-to-end (the scope enforcement it produces is already proven above via PAT).

### Gate D — Regression + integrity
- [~] `bun run ci` green; golden E2E 12/12 vs Demo; integrity checks 15/15 UNWAIVED; Bugsink shows no new issues from dev traffic. — PARTIAL (automated parts done): `bun run ci` GREEN on merged master; full unit suite 4844 pass; `tsc` clean. Integrity check LOCAL = **12/15** — the 3 failures (530 reconciled-txn mismatches, 6 fiscal-period mismatches, 1 cross-tenant GL line) are ALL pre-existing test-company data artifacts (the cross-tenant line was created 2026-04-13 via `auto_supplier_invoice`, three months before this session); the MCP programme added only schema migrations 506/507 + dark, DB-mocked code and created none of them (prod Demo is 15/15 per deployment history). Golden E2E 12/12 vs Demo + Bugsink-no-new-issues need a fresh golden-session + Bugsink wiring (the 12-day-old `golden-session.json` is expired and local dev traffic doesn't reach prod Bugsink) — standard dev-deploy steps for Hein; MCP is dark and touches no golden path, so `bun run ci` green is the authoritative regression signal.

**Exit:** Report to Hein with evidence links (test output, pentest report path, smoke output, audit rows). Hein-owned next steps: flip `mcp_connector` for pilots, prod deploy after hours.

---

## Handoff prompt (paste to the implementing agent)

> Implement `docs/superpowers/plans/2026-07-18-mcp-connector.md` in /home/hein/Workspace/IsaFlow. Read the plan fully, then CLAUDE.md, then execute phase by phase with superpowers:subagent-driven-development. Non-negotiables: branch per phase (never master), TDD (red before green, no stubs), verify migration numbers against master at execution time, blind `/review` on every PR before merge, stop and report — do not proceed to Phase 5 Gate C's dev deploy — if any CI/golden/integrity gate fails. The plan's "Decisions already made" section is settled; do not re-open it. If the code contradicts an assumption in the plan (a named function/route/table doesn't exist), investigate and adapt to reality, note the deviation in the PR description — never build a parallel version of something that already exists.
