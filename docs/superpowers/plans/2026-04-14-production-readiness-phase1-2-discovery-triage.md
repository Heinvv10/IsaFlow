# Production-Readiness Sprint — Phase 1 & 2 (Discovery + Triage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run four parallel read-only audit streams against dev, consolidate findings into a single prioritized backlog, and stop at the user-gated cut line before any code changes.

**Architecture:** Phase 1 dispatches four specialized agents in parallel (functional E2E, pentest, perf, code quality) — each writes a markdown report to `docs/audits/2026-04-14/`. Phase 2 merges those four reports into `05-backlog.md` scored Severity × Effort, then stops for user cut-line approval.

**Tech Stack:** Next.js 14 / TypeScript / Neon Postgres. Tools: `browser-qa` agent (Playwright MCP), `/pentest` skill, `autocannon` + Neon `EXPLAIN ANALYZE`, `autoresearch` skill. Parallel dispatch via `superpowers:dispatching-parallel-agents`.

**Spec:** `docs/superpowers/specs/2026-04-14-production-readiness-sprint-design.md`

**Autonomy envelope:** Phases 1 & 2 run unattended. Hard stop before Phase 3. No code changes at any point in this plan.

---

## File Structure

```
docs/audits/2026-04-14/
  00-preflight.md           (Task 0 output — env state snapshot)
  01-functional-bugs.md     (Task 1A output)
  02-security-findings.md   (Task 1B output)
  03-perf-findings.md       (Task 1C output)
  04-code-quality.md        (Task 1D output)
  05-backlog.md             (Task 2 output — consolidated & ranked)
scripts/
  audit-2026-04-14/
    mint-admin-token.sh     (Task 0 — shell wrapper around mint-for-admin-qa.ts)
    perf-autocannon.sh      (Task 1C — load-test driver)
    perf-explain.mjs        (Task 1C — pulls slow queries & EXPLAIN ANALYZE)
```

No production code is created or modified in this plan. Only docs and audit helper scripts.

---

## Task 0: Pre-flight

**Goal:** Verify the dev environment is clean, migrations are applied, tools are installed, and a fresh JWT is available for the browser-qa agent. Snapshot environment state for reproducibility.

**Files:**
- Create: `docs/audits/2026-04-14/00-preflight.md`
- Create: `scripts/audit-2026-04-14/mint-admin-token.sh`

- [ ] **Step 0.1: Confirm dev DB and env are pointed at dev (NOT prod)**

Run:
```bash
grep -E "^DATABASE_URL|^NEXT_PUBLIC_APP_URL" .env.local | sed 's/=.*/=<redacted>/'
```
Expected: `DATABASE_URL` and `NEXT_PUBLIC_APP_URL` both present, URL clearly NOT prod.

If the URL looks like prod, STOP and escalate to Hein before proceeding.

- [ ] **Step 0.2: Apply any pending migrations to dev**

Run:
```bash
bun run migrate 2>&1 | tail -20
```
(If `bun run migrate` is not wired, use the project's migration script — check `package.json` scripts.)

Expected: "No pending migrations" or a list of applied migrations ending in success. Capture the output.

- [ ] **Step 0.3: Type check baseline**

Run:
```bash
bunx tsc --noEmit 2>&1 | tail -30
```
Expected: zero errors. If errors exist, capture them — they belong in `04-code-quality.md`, not as a blocker.

- [ ] **Step 0.4: Install audit-only tools (autocannon)**

Run:
```bash
bun add -d autocannon
```
Expected: autocannon appears in `devDependencies` in `package.json`.

- [ ] **Step 0.5: Create the mint-admin-token wrapper**

Create `scripts/audit-2026-04-14/mint-admin-token.sh`:
```bash
#!/usr/bin/env bash
# Mints a fresh 2-hour JWT for admin@isaflow.co.za against dev DB.
# Usage: bash scripts/audit-2026-04-14/mint-admin-token.sh
# Prints: TOKEN=<jwt>\nSESSION_ID=<id>
set -euo pipefail
cd "$(dirname "$0")/../.."
export $(grep -E '^(DATABASE_URL|JWT_SECRET)=' .env.local | xargs)
bunx tsx scripts/mint-for-admin-qa.ts
```

Then:
```bash
chmod +x scripts/audit-2026-04-14/mint-admin-token.sh
bash scripts/audit-2026-04-14/mint-admin-token.sh > /tmp/isaflow-admin-token.env
cat /tmp/isaflow-admin-token.env | head -2
```
Expected: `TOKEN=eyJ...` and `SESSION_ID=<number>` printed.

- [ ] **Step 0.6: Confirm dev server is reachable**

In a separate terminal (or background):
```bash
bun run dev
```
Then:
```bash
curl -sf http://localhost:3000/api/health 2>&1 | head -5 || curl -sI http://localhost:3000/ 2>&1 | head -3
```
Expected: HTTP 200 or a JSON health payload. If no `/api/health`, the root HTML response is acceptable signal that the server is up.

- [ ] **Step 0.7: Write `00-preflight.md`**

Create `docs/audits/2026-04-14/00-preflight.md` with sections:
```markdown
# Pre-flight Snapshot — 2026-04-14

## Environment
- Branch: <output of `git rev-parse --abbrev-ref HEAD`>
- HEAD: <output of `git rev-parse HEAD`>
- Node: <output of `node --version`>
- Bun: <output of `bun --version`>
- DATABASE_URL target: dev (verified, not prod)
- NEXT_PUBLIC_APP_URL: <value>

## Migrations
<paste tail of Step 0.2 output>

## Baseline type-check
<paste Step 0.3 output>

## Demo data counts (both companies)
| Company | CI | SI | Bank Tx | Customers | Suppliers |
|---|---|---|---|---|---|
| ISAFlow Demo (Pty) Ltd (...001) | 606 | 577 | 877 | 61 | 35 |
| Brightsphere Technologies (d27bac33...) | 132 | 17 | 8,114 | 7 | 5 |

## Admin QA token
Generated at <ISO timestamp>, expires in 2 hours. Stored at `/tmp/isaflow-admin-token.env` (gitignored).

## Dev server
Reachable at http://localhost:3000 — health check <OK | root 200>
```

- [ ] **Step 0.8: Commit**

```bash
git add docs/audits/2026-04-14/00-preflight.md scripts/audit-2026-04-14/ package.json bun.lockb 2>/dev/null || true
git commit -m "chore(audit): preflight snapshot for 2026-04-14 readiness sprint

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Tasks 1A–1D: Parallel Discovery (DISPATCH IN A SINGLE MESSAGE)

All four tasks below are dispatched as separate agents via `superpowers:dispatching-parallel-agents`. They MUST be launched in a single message with four concurrent `Agent` tool calls. They do not share state and have no sequential dependency on each other.

Each agent is read-only. None writes to the DB, none modifies source code, none touches git outside of adding its own audit `.md` file.

Each agent is briefed to:
1. Work in the main worktree at `/home/hein/Workspace/IsaFlow`.
2. Write its findings to the exact path listed below.
3. Rank every finding as P0 / P1 / P2 / P3 using the spec's severity definitions.
4. Include file:line references for every code-level finding.
5. Stop when its report is written; do NOT commit (the parent commits after Task 2).

---

### Task 1A: Functional E2E audit

**Agent:** `browser-qa`
**Output:** `docs/audits/2026-04-14/01-functional-bugs.md`

- [ ] **Step 1A.1: Dispatch agent**

Brief:
> Run a full functional end-to-end audit of ISAFlow Accounting on dev (`http://localhost:3000`) as `admin@isaflow.co.za`. Use the token at `/tmp/isaflow-admin-token.env` (set cookie `isaflow_auth=<TOKEN>`). Walk both companies (`00000000-0000-0000-0000-000000000001` ISAFlow Demo, `d27bac33-cdc0-4e58-bf6b-709c1597d41c` Brightsphere).
>
> Coverage checklist (must exercise every item, not just view):
> - Dashboard: every widget loads, totals match underlying data
> - Bank transactions: filter, categorize single, bulk categorize, create rule from tx, apply rule, match suggestion, reconcile
> - Customer invoices: list filter, create, edit, send (simulated), receipt allocation, credit note, AR aging
> - Supplier invoices: list filter, create, pay, AP aging
> - Journals: manual journal (balanced and unbalanced), recurring journal, reversal
> - Reports: Trial Balance, Balance Sheet, Income Statement, Cash Flow, General Ledger, AR/AP Aging, VAT return. For each: load, change date range, export (PDF/Excel if offered).
> - Fixed assets, payroll, inventory, budget-vs-actual (if routes exist)
> - Settings: users, roles, company info, tax codes, chart of accounts, bank accounts
>
> For every defect, bad UX, confusing error, broken link, or data mismatch, write one row to `docs/audits/2026-04-14/01-functional-bugs.md` in this format:
>
> ```markdown
> ### F-<NNN>: <short title>
> - **Severity:** P0 | P1 | P2 | P3
> - **URL:** <path>
> - **Company:** ISAFlow Demo | Brightsphere
> - **Action:** <steps to reproduce>
> - **Expected:** <what should happen>
> - **Actual:** <what happened>
> - **Screenshot:** docs/audits/2026-04-14/screenshots/F-<NNN>.png (if captured)
> ```
>
> Severity rubric: P0 = data loss / auth bypass / core workflow totally broken. P1 = significant bug or wrong number. P2 = minor UX / cosmetic with impact. P3 = nice-to-have.
>
> Begin the file with a one-paragraph executive summary (counts by severity, top 3 concerns). Do not commit. Do not modify source code.

Expected output file: `docs/audits/2026-04-14/01-functional-bugs.md` with exec summary + numbered findings.

---

### Task 1B: Security audit

**Skill:** `/pentest`
**Output:** `docs/audits/2026-04-14/02-security-findings.md`

- [ ] **Step 1B.1: Dispatch pentest**

Brief:
> Run the full `/pentest` 8-agent parallel scan on the current dev codebase (`/home/hein/Workspace/IsaFlow`). In addition to the standard scan, specifically verify:
>
> 1. **IDOR sweep — live probe:** using the admin token at `/tmp/isaflow-admin-token.env`, pick 20 write endpoints under `pages/api/accounting/` and attempt to submit bodies referencing resource IDs from the opposite company (company A token, company B resource id). Log every endpoint that returns 2xx without scoping.
> 2. **`gl_journal_lines` scoping:** this table has no `company_id` column — verify every read/write path scopes via `gl_journal_entries.company_id` and there is no query that joins lines without the parent entry's company filter. File:line references required.
> 3. **Authz on admin-platform routes:** `pages/api/admin/**` — confirm every handler enforces `super_admin` role or tenant-ownership.
> 4. **Secrets scan:** `git log -p` for the last 200 commits looking for accidentally committed tokens, keys, or passwords.
> 5. **CSP & headers:** check `next.config.js` and `middleware.ts` for current CSP, missing `HSTS`, `X-Content-Type-Options`, `Referrer-Policy`.
>
> Write to `docs/audits/2026-04-14/02-security-findings.md` in this format:
>
> ```markdown
> ### S-<NNN>: <title>
> - **Severity:** P0 | P1 | P2 | P3 (with CVSS-style justification)
> - **Category:** IDOR | AuthZ | Injection | Secrets | Headers | Rate-limit | Other
> - **File:line:** <path:line>
> - **Evidence:** <code snippet or request/response>
> - **Impact:** <what an attacker can do>
> - **Fix sketch:** <one-paragraph proposed fix>
> ```
>
> Begin with executive summary. Do not commit. Do not modify source code.

Expected output: `docs/audits/2026-04-14/02-security-findings.md`.

---

### Task 1C: Performance & load

**Agent:** `general-purpose` (follows explicit runbook)
**Output:** `docs/audits/2026-04-14/03-perf-findings.md`

- [ ] **Step 1C.1: Dispatch perf agent**

Brief:
> Measure ISAFlow dev performance under realistic load. Use the Brightsphere company (`d27bac33-cdc0-4e58-bf6b-709c1597d41c`) for read-heavy tests — it has 8,114 bank transactions — and ISAFlow Demo for write tests. Token at `/tmp/isaflow-admin-token.env`.
>
> **Setup — create `scripts/audit-2026-04-14/perf-autocannon.sh`:**
> ```bash
> #!/usr/bin/env bash
> set -euo pipefail
> source /tmp/isaflow-admin-token.env
> BASE="${BASE:-http://localhost:3000}"
> HDR="Cookie: isaflow_auth=$TOKEN"
> MS=30000   # 30 second run
> C=10       # 10 concurrent connections
>
> run() {
>   local name="$1"; local path="$2"; local method="${3:-GET}"
>   echo "=== $name ==="
>   bunx autocannon -d $((MS/1000)) -c $C -m "$method" -H "$HDR" "$BASE$path" 2>&1 | tail -25
>   echo
> }
>
> run "bank-tx-list"        "/api/accounting/bank-transactions?limit=50"
> run "customer-invoices"   "/api/accounting/customer-invoices?limit=50"
> run "supplier-invoices"   "/api/accounting/supplier-invoices?limit=50"
> run "chart-of-accounts"   "/api/accounting/chart-of-accounts"
> run "dashboard-summary"   "/api/accounting/dashboard-summary"
> run "ar-aging"            "/api/accounting/reports/ar-aging"  2>/dev/null || true
> run "ap-aging"            "/api/accounting/reports/ap-aging"  2>/dev/null || true
> ```
> Run it. If a path returns 404, remove it and add the correct path by reading `pages/api/accounting/`.
>
> **Setup — create `scripts/audit-2026-04-14/perf-explain.mjs`:**
> Pulls the top 20 slowest statements for the current DB from `pg_stat_statements` if available; otherwise runs `EXPLAIN (ANALYZE, BUFFERS)` on each endpoint's primary query (inferred from the service layer). The script should output a markdown table: query, calls, total_time_ms, mean_time_ms, rows.
>
> **Capture:** for every endpoint tested, record p50, p95, p99, throughput (req/s), error rate. For every query >100ms mean, capture EXPLAIN plan.
>
> **Write to `docs/audits/2026-04-14/03-perf-findings.md`** in this format:
>
> ```markdown
> ### P-<NNN>: <endpoint or query>
> - **Severity:** P0 (>5s p95) | P1 (>2s p95) | P2 (>1s p95) | P3
> - **Measured:** p50 <ms>, p95 <ms>, p99 <ms>, <req/s>, <err %>
> - **Suspected cause:** N+1 | missing index | unbounded query | heavy JSON | other
> - **Evidence:** <EXPLAIN plan excerpt or service file:line>
> - **Proposed fix:** <specific, e.g., "add composite index on bank_transactions(company_id, date DESC)">
> ```
>
> Begin with executive summary (p95 budget: <800ms for list, <2s for reports). Do not commit. Do not modify source code.

Expected output: `docs/audits/2026-04-14/03-perf-findings.md`.

---

### Task 1D: Code quality audit

**Skill:** `autoresearch` (or `general-purpose` agent if skill not available)
**Output:** `docs/audits/2026-04-14/04-code-quality.md`

- [ ] **Step 1D.1: Dispatch code-quality agent**

Brief:
> Static and architectural audit of `/home/hein/Workspace/IsaFlow`. Scope: `src/`, `pages/api/accounting/`, `pages/accounting/`. Out of scope: generated files, migrations, tests, docs, scripts.
>
> Produce findings in these categories:
>
> 1. **CLAUDE.md rule violations:**
>    - Files > 300 lines
>    - `any` types (count per file, show top 20 offenders)
>    - `console.log` / `console.error` usage (should be `log` from `@/lib/logger`)
>    - Empty `catch {}` or `catch (e) {}` with no handling
>    - API handlers NOT wrapped with `withCompany(withErrorHandler(...))`
>    - SQL without the `sql` tagged template
>    - SQL queries missing `company_id` scoping
>    - Responses not using `apiResponse.*` helpers
>
> 2. **Architecture smells:**
>    - Duplicate logic across services
>    - Services > 500 lines
>    - Circular imports
>    - Response-shape inconsistencies (e.g., some endpoints return `{ data: [] }`, others return `[]`)
>    - Dead code (unexported functions with no callers, unreferenced files)
>
> 3. **Test coverage gaps:**
>    - Services in `src/modules/accounting/services/` with zero tests in `tests/unit/services/`
>    - API routes without an integration test
>
> **Write to `docs/audits/2026-04-14/04-code-quality.md`:**
>
> ```markdown
> ## CLAUDE.md violations
> | Rule | Count | Top offenders (file:line) |
> |---|---|---|
> | Files > 300 lines | <n> | <list top 10> |
> | `any` types | <n> | <list top 10> |
> | `console.log` | <n> | <list all> |
> | Empty catches | <n> | <list all> |
> | Handlers missing `withCompany` | <n> | <list all> |
> | Missing `company_id` in SQL | <n> | <list all — CRITICAL> |
> | Non-`apiResponse` returns | <n> | <list top 10> |
>
> ## Architecture smells
> ### Q-<NNN>: <title>
> - **Severity:** P1 | P2 | P3
> - **Where:** <file:line or module>
> - **Issue:** <description>
> - **Refactor cost:** S (<1h) | M (1-4h) | L (>4h)
> - **Recommended action:** <concrete>
>
> ## Test coverage gaps
> | Service / Route | Lines | Tests? |
> |---|---|---|
> ```
>
> Begin with executive summary. Do not commit. Do not modify source code.

Expected output: `docs/audits/2026-04-14/04-code-quality.md`.

---

### Synchronization gate after 1A–1D

- [ ] **Step 1.X: Confirm all four reports exist and are non-empty**

Run:
```bash
for f in 01-functional-bugs.md 02-security-findings.md 03-perf-findings.md 04-code-quality.md; do
  path="docs/audits/2026-04-14/$f"
  if [[ -s "$path" ]]; then
    printf "OK   %-30s %6d bytes\n" "$f" "$(wc -c < "$path")"
  else
    printf "FAIL %-30s MISSING OR EMPTY\n" "$f"
  fi
done
```
Expected: four `OK` lines. If any `FAIL`, re-dispatch that stream with an explicit error note in the brief.

- [ ] **Step 1.Y: Commit the four reports**

```bash
git add docs/audits/2026-04-14/01-functional-bugs.md \
        docs/audits/2026-04-14/02-security-findings.md \
        docs/audits/2026-04-14/03-perf-findings.md \
        docs/audits/2026-04-14/04-code-quality.md \
        docs/audits/2026-04-14/screenshots/ 2>/dev/null || true
git commit -m "audit(2026-04-14): phase 1 discovery reports

- Functional E2E (browser-qa, both companies)
- Pentest (/pentest 8-agent scan + IDOR probe)
- Performance (autocannon + EXPLAIN)
- Code quality (CLAUDE.md + architecture + coverage)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Consolidate into ranked backlog — USER GATE

**Goal:** Merge the four Phase 1 reports into a single ranked backlog, score every item Severity × Effort, and HARD STOP for Hein's cut-line approval.

**Files:**
- Create: `docs/audits/2026-04-14/05-backlog.md`

- [ ] **Step 2.1: Read all four reports**

Read in full:
- `docs/audits/2026-04-14/01-functional-bugs.md`
- `docs/audits/2026-04-14/02-security-findings.md`
- `docs/audits/2026-04-14/03-perf-findings.md`
- `docs/audits/2026-04-14/04-code-quality.md`

- [ ] **Step 2.2: Write `05-backlog.md`**

Structure:
```markdown
# Production-Readiness Backlog — 2026-04-14

## Executive summary
- Total findings: <n>   (P0: <n>  P1: <n>  P2: <n>  P3: <n>)
- By stream: Functional <n> | Security <n> | Perf <n> | CodeQuality <n>
- Top 5 risks: <bullets>
- Recommended cut line: <P0+P1 | P0+P1+P2 | other — with reasoning>

## Ranked items

### Item <ID>: <title>
- **Source:** F-<NNN> | S-<NNN> | P-<NNN> | Q-<NNN>
- **Severity:** P0 | P1 | P2 | P3
- **Effort:** S (<1h) | M (1-4h) | L (>4h) | XL (>1 day)
- **Score:** <Severity × Effort, 1-16>
- **Wave:** A (parallel, isolated) | B (sequential, cross-cutting) | C (UX polish)
- **Fix spec:** <one paragraph — what to change, which files, acceptance criteria>
- **Tests:** <what test(s) to write>
- **Risk if deferred:** <bullet>

## Deferred to separate backlog
Items intentionally out of scope for this sprint (e.g., new feature requests surfaced during audit).
```

**Scoring rubric:**
- Severity: P0=4, P1=3, P2=2, P3=1
- Effort: S=4, M=3, L=2, XL=1
- Score = Severity × Effort (1–16). Higher = better ROI. Ties broken by severity.

**Wave assignment rules:**
- Wave A (parallel, isolated): ≤3 files, no migration, no middleware, no response-shape change
- Wave B (sequential, cross-cutting): migration, `withCompany`, `apiResponse`, `sql`, auth, cookie, CSP
- Wave C (parallel, UX polish): error messages, loading states, empty states, copy, date formatting

- [ ] **Step 2.3: Commit the backlog**

```bash
git add docs/audits/2026-04-14/05-backlog.md
git commit -m "audit(2026-04-14): phase 2 consolidated backlog

<n> findings ranked Severity × Effort. Recommended cut line: <P0+P1>.
See docs/audits/2026-04-14/05-backlog.md for full list.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 2.4: HARD STOP — report to Hein**

Emit a summary message containing:
1. Path to the backlog: `docs/audits/2026-04-14/05-backlog.md`
2. One-line executive summary (counts, top 3 risks)
3. Recommended cut line
4. Explicit ask: "Approve the cut line (or adjust), and I will write the Phase 3 fix-sprint plan next."

Do NOT:
- Start Phase 3.
- Write any fix code.
- Invoke any other skill.
- Schedule a wake-up.

Wait for Hein's explicit response.

---

## Self-Review Checklist (completed during plan writing)

- [x] **Spec coverage:** Every Phase 1 / Phase 2 item in the spec maps to a task (0 preflight, 1A functional, 1B security, 1C perf, 1D code-quality, 2 triage + gate). Phases 3/4/5 explicitly excluded per autonomy envelope.
- [x] **Placeholder scan:** No "TBD" / "TODO". Every agent brief is complete inline. Every command is concrete.
- [x] **Type consistency:** File paths (`docs/audits/2026-04-14/*`), severity labels (P0/P1/P2/P3), wave labels (A/B/C), ID prefixes (F-/S-/P-/Q-) used consistently across tasks.
- [x] **Autonomy boundary:** Task 2.4 is an explicit hard stop with no continuation hook.
- [x] **Read-only:** No task modifies source code. Only adds files under `docs/audits/2026-04-14/` and `scripts/audit-2026-04-14/`.
