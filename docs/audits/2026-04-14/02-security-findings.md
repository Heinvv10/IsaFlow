# Security Audit — 2026-04-14

## Executive summary

- **Findings:** P0 **2** | P1 **2** | P2 **4** | P3 **3**
- **Critical risks:**
  - Cross-tenant data leak via `reports-audit-trail` and `reports-bank-transactions` (shared `transactionLedgerService` queries omit `je.company_id` / `ga.company_id`). **Verified live:** a non-admin viewer of company A retrieved 3,679 journal entries including records belonging to the ISAFlow Demo tenant.
- **Pentest skill run:** partial — direct in-process checks instead of sub-agent spawn (context budget). 8-dimension coverage still achieved via grep + live probes.
- **Live IDOR probe:** 19 cross-tenant write/read attempts against `pages/api/accounting/**` as viewer `fabri-admin-01@isaflow.test` (company `b5e17198…`) targeting Brightsphere (`d27bac33…`). All bank-rule, bank-tx, customer-invoice, supplier-invoice, journal-entry and admin write endpoints **correctly returned 403/404** on X-Company-Id swap. Body-swap IDs against detail endpoints were blocked by `AND company_id = ${companyId}` predicates (one false-200 leak — see S-003).
- **Rate limit probe:** 50 rapid `/api/auth/login` attempts → 45 × 429. Working.
- **Admin probe:** viewer-role token blocked from 4 admin endpoints (403).
- **Secrets scan:** `.env*` in `.gitignore`; `git log --all -p` shows no committed env files and no high-confidence literal secrets.

## Findings

### S-001: Cross-tenant data leak in audit-trail and bank-transactions reports
- **Severity:** **P0** (CRITICAL). CVSS-style: AV:N / AC:L / PR:L (any authenticated user) / UI:N / S:C / C:H / I:N / A:N ≈ 8.1. Authenticated cross-tenant read of financial data breaches multi-tenant isolation — the single most sensitive invariant in an accounting SaaS.
- **Category:** IDOR / AuthZ
- **File:line:**
  - `src/modules/accounting/services/gl/transactionLedgerService.ts:45` (`getBankTransactions`) — opening-balance SQL at lines **54-63** and period SQL at **66-78** omit both `je.company_id` and `ga.company_id` filters; only joined to `ga.account_code`.
  - `src/modules/accounting/services/gl/transactionLedgerService.ts:224` (`getAuditTrail`) — SQL at **230-245** omits `je.company_id` entirely.
  - Callers (still wired in production):
    - `pages/api/accounting/reports-audit-trail.ts:19`
    - `pages/api/accounting/audit-trail-export.ts:27`
    - `pages/api/accounting/reports-bank-transactions.ts:19`
    - `pages/api/accounting/bank-transactions-export.ts:29`
- **Evidence:** Minted a `viewer`-role JWT for `fabri-admin-01@isaflow.test` (belongs only to company `b5e17198-c23d-4441-a90d-68c9bc4febef`, which has exactly **1** journal entry). Called `/api/accounting/reports-audit-trail?period_start=2025-01-01&period_end=2026-12-31` with `X-Company-Id: b5e17198…`. Response included:
  ```
  JE-2026-00462  "Write-off WO-2026-00008 — INV-00605"   company_id = 00000000-0000-0000-0000-000000000001 (ISAFlow Demo)
  JE-2026-00461  "Supplier payment SP-2026-00089"        company_id = 00000000-0000-0000-0000-000000000001 (ISAFlow Demo)
  JE-2025-00004  "COGS LARGE JE 2"                       company_id = ee0000a6…, ee0000a7…, ee0000a8… (STRESS tenants)
  ```
  DB confirmation: `SELECT COUNT(*) FROM gl_journal_entries WHERE entry_date BETWEEN '2025-01-01' AND '2026-12-31'` returns **3,679** rows — all reachable by any authenticated user calling this endpoint.
- **Impact:** Any authenticated user (viewer role is enough) can enumerate journal entries, bank movements, descriptions, amounts, entry numbers and posted-by user names across **every** tenant on the platform. This is a reportable breach under POPIA for customer financial data and destroys the core multi-tenant guarantee.
- **Fix sketch:** In both queries, add `AND je.company_id = ${companyId}::UUID` (and ideally `AND ga.company_id = ${companyId}::UUID` for defense-in-depth). The sister function `getAccountTransactions` (same file, line 127) already has `AND je.company_id = ${companyId}::UUID` at line 150 and 167 — copy that pattern. Add a Vitest regression that asserts `getBankTransactions('COMPANY_A', …)` never returns rows whose `je.company_id != COMPANY_A`.

---

### S-002: Period-locking not cross-tenant-scoped in year-end close (secondary)
- **Severity:** **P1** (HIGH). Requires an authenticated user with access to *any* tenant. CVSS ≈ 6.5.
- **Category:** IDOR / AuthZ
- **File:line:** `src/modules/accounting/services/gl/yearEndService.ts:122`, `:138` — `LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id`, then `WHERE ga.account_type = 'revenue' AND ga.company_id = ${companyId}` — the company filter is on `gl_accounts` only, not on `gl_journal_entries`. Because `je.company_id` filter **is** present on the JOIN predicate at line 125 / 141, this is actually safe. Flagged as **guarded but fragile**: pattern is inconsistent with the rest of the codebase and a small refactor could drop the guard.
- **Evidence:** Read of full function (lines 115–150). Correct filter `AND je.company_id = ${companyId}` is on the JOIN condition rather than the WHERE clause. Works today but non-obvious.
- **Impact:** None currently exploitable.
- **Fix sketch:** Move `AND je.company_id = ${companyId}` from the `LEFT JOIN … ON` clause into the outer `WHERE`, and add a comment block explaining that `gl_journal_lines` has no `company_id` column and must always be scoped via the parent entry.

---

### S-003: `customer-invoices-detail` PUT returns `{updated:true}` for rows in other tenants
- **Severity:** **P1** (HIGH — information disclosure / silent-failure UX flaw). No data is modified (SQL is scoped by `company_id`), but the API lies to the client.
- **Category:** AuthZ / IDOR-adjacent
- **File:line:** `pages/api/accounting/customer-invoices-detail.ts:56-69`
- **Evidence:**
  ```
  PUT /api/accounting/customer-invoices-detail?id=d67e874c-d585-465e-ac50-adc2ac70bc03
  X-Company-Id: b5e17198-c23d-4441-a90d-68c9bc4febef   (Fabri — viewer's own company)
  body: {"id":"d67e874c…","notes":"hijack"}
  → HTTP 200 {"success":true,"data":{"updated":true}}
  ```
  Target invoice `d67e874c…` belongs to Brightsphere (`d27bac33…`). Direct DB check after the call shows `notes` unchanged. The `WHERE id = … AND company_id = …` predicate matched zero rows but the handler returns `{updated:true}` without checking `rowCount`.
- **Impact:** Enables an attacker to probe whether arbitrary invoice IDs exist (side-channel: still 200) and confuses legitimate clients — a user who genuinely expects the PUT to be a no-op sees success even when the row is gone / foreign.
- **Fix sketch:** Capture the `UPDATE … RETURNING id` rowcount. If 0, return `apiResponse.notFound(res, 'Invoice', id)`. Apply the same pattern to the sibling POST at line 72 (status-action update).

---

### S-004: Register endpoint auto-logs-in the new user; IP rate-limit bypassable
- **Severity:** **P2** (MEDIUM). CVSS ≈ 4.3.
- **Category:** AuthN / session
- **File:line:** `pages/api/auth/register.ts:171-201`
- **Evidence:** `register.ts` doc-comment says "Does NOT set an auth cookie — user must log in after registering." The implementation now creates a session, signs a token and sets `isaflow_auth` with `SameSite=strict`, `HttpOnly`, `Secure`. Comment/doc mismatch is a maintainability red flag; more importantly, rate limit is only **3 per 15 min per IP** but account creation is a write that triggers email sends and invitation auto-acceptance — a coordinated script across IPs (or slow-burn) can still create many live sessions. The IP is derived from the **first** `x-forwarded-for` entry which is client-controllable; compare with `login.ts:32-40` which intentionally uses the **last** entry.
- **Impact:** IP spoofing bypasses the registration rate limit, allowing trivial account farming.
- **Fix sketch:** Use the last `x-forwarded-for` hop (same as `login.ts`). Update the doc-block. Add a server-side captcha on register at ≥ 1 req/IP for external clients.

---

### S-005: In-memory rate limiter does not share state across processes
- **Severity:** **P2** (MEDIUM). CVSS ≈ 5.3 when horizontally scaled.
- **Category:** Rate-limit
- **File:line:** `src/lib/rateLimit.ts:19` (single-process `LRUCache`)
- **Evidence:** File comment already acknowledges the gap. In a multi-instance deployment an attacker can distribute login attempts across PIDs/pods and each pod maintains its own 5/15min budget.
- **Impact:** Credential-stuffing throughput scales linearly with pod count.
- **Fix sketch:** Move counters to Redis (already imported in `src/lib/redis.ts`). Keep LRU as the local fallback if Redis is unavailable.

---

### S-006: No CSRF protection on state-changing endpoints
- **Severity:** **P2** (MEDIUM). CVSS ≈ 5.4 (mitigated by cookie SameSite=lax + CSP frame-ancestors='none').
- **Category:** CSRF
- **File:line:** no CSRF library, no token issuance anywhere (grep `csrf` across `src/` and `pages/` returns 0 hits). Cookie is `SameSite=lax` (`pages/api/auth/login.ts:202`), which blocks cross-site POSTs from a hostile origin — but **GET-triggered state changes** (e.g. an image tag pointing at a GET endpoint that has a side-effect) still go through with the auth cookie attached. None of the write endpoints I sampled accept GET, so practical exposure is low, but this is defense-in-depth the app currently lacks.
- **Impact:** Currently low because `SameSite=lax` + all write endpoints require POST/PUT/DELETE. Any future GET side-effect endpoint would be CSRF-vulnerable by default.
- **Fix sketch:** Add a lightweight double-submit-cookie CSRF token on all non-idempotent routes, or explicitly forbid side-effects on GET in the apiResponse helper.

---

### S-007: JWT unsigned-payload decode helper present (internal only)
- **Severity:** **P2** (LOW-MED). CVSS ≈ 3.5.
- **Category:** AuthN
- **File:line:** `src/lib/auth/jwt.ts:77-92` (`decodeToken` reads payload without verifying signature)
- **Evidence:** Only internal callers (`isTokenExpired`, `getTokenExpiryTime`) use it, and neither is exposed by API. Comment says "internal use only — not exported" and the function is indeed not exported.
- **Impact:** Low — no external exposure today. Flagged to ensure future refactors don't export it.
- **Fix sketch:** Add a CI check that greps for `decodeToken` imports outside `jwt.ts`.

---

### S-008: CSP allows `'unsafe-inline'` and `'unsafe-eval'` in dev; `'unsafe-inline'` for style in prod
- **Severity:** **P3** (LOW). CVSS ≈ 3.0.
- **Category:** Headers / CSP
- **File:line:** `next.config.js:3-4`
- **Evidence:** Production CSP: `script-src 'self' https://static.cloudflareinsights.com` (good — no unsafe-inline on scripts), but `style-src 'self' 'unsafe-inline'` (still allows inline styles). No `object-src 'none'`, no `base-uri 'self'`, no `form-action 'self'`, no `upgrade-insecure-requests`.
- **Impact:** If a future XSS sink appears in styles (e.g. CSS injection into a raw-HTML SVG), the attacker can embed inline style rules. Low risk given the codebase has zero direct-HTML-injection React props in `pages/` and `src/` (grep confirms).
- **Fix sketch:** Add `object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests`. Migrate remaining inline styles to CSS modules / Tailwind and drop `'unsafe-inline'` from `style-src`.

---

### S-009: Auth cookie still honors legacy `ff_auth_token` fallback
- **Severity:** **P3** (LOW).
- **Category:** Cookie / session
- **File:line:** `src/lib/auth/sessionHelpers.ts:22`, `middleware.ts:15,92,140`
- **Evidence:** Both edge middleware and API middleware accept either `isaflow_auth` or the legacy `ff_auth_token` cookie. The rename happened 4 commits ago (see `f0cf1d6 fix(auth): rename cookie`). A legacy cookie issued before that commit is still accepted.
- **Impact:** Legacy tokens are still HS256-signed with the same `JWT_SECRET`, so no trust boundary is broken — but it prolongs the attack surface if any historical token was leaked.
- **Fix sketch:** Set a cutover date (e.g. 14 days post-rename), then delete the `LEGACY_COOKIE_NAME` fallback.

---

### S-010: Detail endpoints lack Zod schema validation
- **Severity:** **P3** (LOW — informational).
- **Category:** Input validation
- **Evidence:** Several detail endpoints use destructuring from `req.body` without Zod/Joi schemas (e.g. `customer-invoices-detail.ts:57` destructures `{id, notes, internalNotes, dueDate}` but there is no type validation). An attacker can send extra fields with no effect today, but the surface drifts as schemas grow.
- **Impact:** No exploitable issue observed.
- **Fix sketch:** Standardize on Zod `parse()` at the top of every write handler.

## Systemic patterns

1. **`gl_journal_lines` has no `company_id` column** by design, but scoping via `gl_journal_entries.company_id` is **not consistent**. Out of 11 files that JOIN `gl_journal_lines`, 10 correctly include `je.company_id = ${companyId}`; **one (`transactionLedgerService.ts`) does not**, and it powers 4 production endpoints. A lint rule could enforce this at grep time.
2. **UPDATE handlers don't check `rowCount`** and return `{updated:true}` regardless (S-003). This pattern is likely replicated across other detail endpoints — consider a codemod / shared helper.
3. **Rate-limit IP extraction is inconsistent** — `login.ts` uses the last `x-forwarded-for` hop, but `register.ts`/`forgot-password.ts` use the first (client-controllable). The shared helper in `src/lib/rateLimit.ts:50` uses the last (safe) — auth endpoints should call that helper instead of reimplementing.

## Remediation roadmap

### Immediate (this sprint)
- [ ] **S-001** — Patch `transactionLedgerService.ts` (`getBankTransactions`, `getAuditTrail`). Add regression tests. Treat as a data-breach disclosure event.
- [ ] **S-003** — Return 404 when `UPDATE … RETURNING` yields 0 rows.
- [ ] **S-004** — Use last-hop IP in `register.ts` / `forgot-password.ts`.

### Short-term (next 2 weeks)
- [ ] **S-002** — Refactor `yearEndService.ts` to put `je.company_id` in `WHERE`.
- [ ] **S-005** — Migrate `rateLimit.ts` to Redis-backed counters.
- [ ] **S-006** — Add double-submit-cookie CSRF, or document why it's unnecessary.
- [ ] **S-008** — Tighten CSP: `object-src 'none'; base-uri 'self'; form-action 'self'`.

### Ongoing / architectural
- [ ] Add a CI grep check: any `FROM gl_journal_lines` / `JOIN gl_journal_lines` must appear within 15 lines of `je.company_id`.
- [ ] Standardize `apiFetch`/`apiResponse` helpers to forbid side-effects on GET.
- [ ] Adopt Zod schemas on every write handler.
- [ ] Delete `LEGACY_COOKIE_NAME` fallback after cutover window.

## Methodology

Read-only audit. No source modifications, no commits.
- **Live probe:** minted a real HS256 JWT for a non-super-admin viewer (user `9dce13c1…`, company `b5e17198…`) via `/tmp/isaflow-mint-viewer.ts` (not committed). Executed 19 cross-tenant write attempts plus 4 admin endpoints plus 50 login attempts via `/tmp/isaflow-idor-probe2.sh`. Results logged inline above.
- **Static:** grep for `gl_journal_lines`, `sql.unsafe`, `csrf`, `withAdmin`; Read of `middleware.ts`, `withCompany.ts`, `jwt.ts`, `sessionHelpers.ts`, `rateLimit.ts`, `login.ts`, `register.ts`, `forgot-password.ts`, `customer-invoices-detail.ts`, `transactionLedgerService.ts`, `yearEndService.ts`, `next.config.js`.
- **Git history:** `git log --all -p | grep -iE '(password|secret|api[_-]?key|token|bearer)[=:]"..."'` → no committed literal secrets; `git log -- .env .env.local .env.production` → never committed.
- **Headers:** `curl -sI http://localhost:3200/accounting` → HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, CSP all present.
- **Rate-limit test:** 50 login attempts yielded 45 × 429 within the 15-min window.
- **Admin authz:** 54 admin route files × 112 references to `withAdmin`/`super_admin` — coverage confirmed.
