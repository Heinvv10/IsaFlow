# ISAFlow Production-Readiness Sprint — Design

**Date:** 2026-04-14
**Owner:** Hein
**Target environment:** dev (never prod for writes/load)
**Demo accounts:** `admin@isaflow.co.za` against both companies:
- `ISAFlow Demo (Pty) Ltd` — `00000000-0000-0000-0000-000000000001` (seeded, 3 FYs, 606 CI / 577 SI / 877 bank tx)
- `Brightsphere Technologies (Pty) Ltd` — `d27bac33-cdc0-4e58-bf6b-709c1597d41c` (Sage import, 8,114 bank tx — perf realism)

## Goal

Push ISAFlow from "works on good days" to "production-ready for paying accountants." Produce a prioritized backlog of bugs, security issues, performance problems, and code-quality gaps; fix the P0/P1 items in a controlled sprint; harden the platform; verify with a final scorecard.

## Non-goals

- No production writes or load tests.
- No unrelated refactors. Only touch code the discovery phase flags.
- No new features. If discovery surfaces a missing feature, it goes on a separate backlog, not this sprint.

## Success criteria

- Consolidated backlog (`docs/audits/2026-04-14/05-backlog.md`) with every finding ranked by severity × effort.
- All P0 items fixed, tested, and merged.
- All P1 items either fixed or explicitly deferred with a written reason.
- Production-readiness scorecard (`docs/audits/2026-04-14/99-scorecard.md`) signed off go/no-go per pillar (functional, security, performance, UX, ops).
- Zero new regressions vs. current `main` (verified by re-running Phase 1 streams).

## Architecture: five phases, gated

```
Phase 1 Discovery (parallel, read-only)
  ├─ 1A Functional E2E     →  01-functional-bugs.md
  ├─ 1B Pentest            →  02-security-findings.md
  ├─ 1C Stress / Perf      →  03-perf-findings.md
  └─ 1D Code Quality       →  04-code-quality.md
       │
       ▼
Phase 2 Triage (sequential)
  └─ Consolidate + rank    →  05-backlog.md   [USER GATE — cut line]
       │
       ▼
Phase 3 Fix Sprint
  ├─ Wave A parallel (worktrees)  — isolated bugs
  ├─ Wave B sequential            — cross-cutting / schema
  └─ Wave C parallel              — UX polish
       │
       ▼
Phase 4 Hardening (sequential)
  └─ Rate limits, observability, backups, rollback drill, CSP, secrets
       │
       ▼
Phase 5 Verification (parallel)
  └─ Re-run 1A–1D          →  99-scorecard.md
```

All audit outputs land in `docs/audits/2026-04-14/`.

## Phase 1 — Discovery (parallel, ~tonight)

Dispatched via `superpowers:dispatching-parallel-agents`. All four streams are read-only against dev. No writes, no code changes.

### 1A Functional E2E — `browser-qa` agent

- Auth: `scripts/mint-for-admin-qa.ts` mints a fresh token for `admin@isaflow.co.za`.
- Walk both companies through the full accountant workflow:
  - Dashboard widgets load and match underlying data
  - Bank transactions: filter, categorize, create rule, match suggestion, bulk actions
  - Customer invoices: create, edit, send, receipt, credit note, age analysis
  - Supplier invoices: create, pay, age analysis
  - Journals: manual journal, recurring, reversal
  - Reports: Trial Balance, Balance Sheet, P&L, Cashflow, GL detail, VAT return
  - Fixed assets, payroll, inventory (if present)
  - Settings: users, roles, company info, tax codes, chart of accounts
- Every broken element → one row in `01-functional-bugs.md` with: URL, action, expected, actual, severity (P0/P1/P2/P3), screenshot path.

### 1B Pentest — `/pentest` skill

- Run the 8-agent parallel scan against the dev codebase.
- Focus diff since last scan; include the `gl_journal_lines` no-`company_id` finding for manual verification.
- Probe write endpoints as `admin@isaflow.co.za` with company A token against company B IDs (IDOR sweep).
- Output: `02-security-findings.md` with CVSS-style severity.

### 1C Stress / Perf — ad-hoc `autocannon` + Neon `EXPLAIN ANALYZE`

- Warm dev, then hammer the heavy endpoints with Brightsphere's 8,114 bank tx as realistic volume:
  - `GET /api/accounting/bank-transactions` (paginated list)
  - `GET /api/accounting/reports/trial-balance`
  - `GET /api/accounting/reports/balance-sheet`
  - `GET /api/accounting/customer-invoices` (with filters)
  - `POST /api/accounting/bank-rules-action` (matching)
- Capture p50/p95/p99, error rate, DB time vs. app time.
- Pull Neon slow-query log for the test window; `EXPLAIN ANALYZE` the top 20.
- Output: `03-perf-findings.md` with each slow path: current p95, suspected cause, proposed fix (index / query rewrite / N+1 fix / caching).

### 1D Code Quality — `autoresearch` skill

- Static sweep: files > 300 lines, `any` types, empty catches, `console.log` usage, services not behind `withCompany`, missing `company_id` in SQL, N+1 patterns, dead code.
- Architecture pass: service layer boundaries, duplicated logic, inconsistent response shapes.
- Output: `04-code-quality.md` with file:line references and refactor cost estimates.

## Phase 2 — Triage (sequential, ~30 min)

- Consolidate 1A–1D into `05-backlog.md`.
- Score each finding: **Severity (P0–P3) × Effort (S/M/L)**.
  - P0 = data loss, security breach, totally broken core workflow
  - P1 = significant UX or accuracy bug, auth weakness, >2s p95 on core page
  - P2 = minor UX, moderate perf, code smell with real impact
  - P3 = nice-to-have
- Hein approves the cut line (expected: "fix all P0 + P1, defer P2/P3").
- For each accepted item I write a one-paragraph fix spec inline in `05-backlog.md`.

**This is the hard gate before any code is written.** Phase 3 does not start until Hein approves the cut.

## Phase 3 — Fix Sprint

### Wave A — parallel isolated fixes

- Each fix gets its own worktree via `superpowers:using-git-worktrees`.
- Criteria for Wave A: change touches ≤ 3 files, no schema migration, no shared middleware, no response-shape change.
- Per fix: TDD (RED → GREEN) → `/code-review` → squash PR → merge to master.
- Typical Wave A items: missing `company_id`, broken nav link, null handling, empty state, validation gap, missing index.

### Wave B — sequential cross-cutting

- Anything that touches: migrations, `withCompany`, `apiResponse`, `sql` helper, auth flow, session cookie, CSP.
- One at a time, full test suite + E2E smoke + deploy to dev between each.
- Each migration uses `IF NOT EXISTS` and is reversible.

### Wave C — parallel UX polish

- Error messages, loading skeletons, empty states, form validation copy, consistent date formats.
- Run after Wave A/B so we polish finished surfaces.

Every wave ends with a dev smoke test before moving on.

## Phase 4 — Hardening (sequential)

Only starts after Phase 3 merges clean and dev smoke passes.

1. **Rate limiting** — auth endpoints, password reset, write-heavy APIs. Use Neon-backed or in-memory token bucket.
2. **Observability** — structured logging audit (no `console.log` leaks), error-tracking integration, slow-query alert on Neon.
3. **Backups** — verify Neon PITR window, document restore procedure, run a restore drill to a scratch branch.
4. **Rollback rehearsal** — tag current prod, deploy dev build to prod-shaped staging, roll back, verify.
5. **CSP / headers** — audit `next.config` headers, tighten CSP, add HSTS, X-Content-Type-Options, Referrer-Policy review.
6. **Secrets** — rotate `JWT_SECRET`, audit `.env.local` vs. Vercel/host env, ensure no secrets in git history.

Each item: short checklist, executed, marked done in `docs/audits/2026-04-14/40-hardening.md`.

## Phase 5 — Verification (parallel)

- Re-run 1A, 1B, 1C, 1D against fixed code.
- Diff against original findings: every P0/P1 must be closed.
- Produce `99-scorecard.md` with go/no-go per pillar:
  - Functional ✅/❌
  - Security ✅/❌
  - Performance ✅/❌
  - UX ✅/❌
  - Ops/Hardening ✅/❌
- If all green → ISAFlow is production-ready to onboard paying accountants.
- If any red → cycle back to Phase 3 for that pillar only.

## Tooling

| Purpose | Tool |
|---|---|
| Browser walkthrough | `browser-qa` agent, Playwright MCP |
| Pentest | `/pentest` skill |
| Load test | `autocannon` (npm), `k6` if installed |
| Slow queries | Neon console + `EXPLAIN ANALYZE` |
| Code quality | `autoresearch` skill, `bunx tsc --noEmit`, `bun run lint` |
| Parallel fixes | `superpowers:dispatching-parallel-agents` + `superpowers:using-git-worktrees` |
| TDD | `superpowers:test-driven-development` |
| Code review | `/code-review` plugin |
| Debug | `superpowers:systematic-debugging` |

## Risks

- **Dev DB divergence from prod schema** — mitigate by running migrations on dev before Phase 1.
- **Flaky E2E masking bugs** — mitigate by running each failing step twice before logging as bug.
- **Phase 3 scope creep** — hard rule: if a finding wasn't in `05-backlog.md` approved cut, it's deferred.
- **Hardening surprises** — mitigate by running Phase 4 in the same dev environment before any prod touch.

## Artifacts

```
docs/audits/2026-04-14/
  01-functional-bugs.md
  02-security-findings.md
  03-perf-findings.md
  04-code-quality.md
  05-backlog.md
  40-hardening.md
  99-scorecard.md
```

```
docs/superpowers/specs/
  2026-04-14-production-readiness-sprint-design.md   ← this file
  2026-04-14-production-readiness-sprint-plan.md     ← to be written by writing-plans skill
```

## Autonomy envelope

- **Phase 1 & 2:** run unattended. Read-only. Stop at end of Phase 2.
- **Phase 3+:** require Hein's explicit approval of the cut line first.
