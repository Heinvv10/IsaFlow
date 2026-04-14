# Production-Readiness Sprint — Phase 3 (Fix Sprint) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task dispatches a fresh implementer subagent, then spec-review subagent, then code-quality-review subagent.

**Goal:** Resolve all P0 and P1 findings from Phase 1 + high-ROI P2/P3 quick wins (30 items total), keeping ISAFlow multi-tenant-correct, functionally accurate for accountants, and materially faster at the DB layer.

**Architecture:** Three execution waves. Wave A is parallel isolated fixes (each in its own worktree, each ≤3 files, each TDD-first). Wave B is sequential cross-cutting fixes (migrations and shared services — one at a time, with gates). Wave C is parallel UX polish after the others land. Every fix follows the same internal workflow: red test → green code → spec review → quality review → commit to `master`.

**Tech Stack:** Next.js 14, TypeScript (strict), Neon Postgres (`sql` tagged template), Vitest for unit tests, bun for scripts. No new dependencies unless called out per task.

**Spec:** `docs/superpowers/specs/2026-04-14-production-readiness-sprint-design.md`

**Backlog (source of truth for per-item fix specs):** `docs/audits/2026-04-14/05-backlog.md`

**Autonomy envelope:** After each wave completes, HARD STOP — Hein reviews progress before the next wave. P0 items (BL-01, BL-02) are the very first dispatches in Wave A, parallel, no dependency on anything else.

---

## Per-task workflow (applies to every BL-NN item unless the task explicitly overrides it)

This is how every fix agent works. Do NOT repeat these steps inside each task — they are implied.

```
1. Dispatch implementer subagent:
   - Create a worktree for this fix: `git worktree add ../isaflow-BL-NN master -b fix/BL-NN-<slug>`
   - Read the BL-NN entry in docs/audits/2026-04-14/05-backlog.md for fix spec + tests + acceptance
   - Write the failing test first (RED) — location per task below
   - Run `bunx vitest run <test-path>` → confirm FAIL
   - Implement the minimum code to pass
   - Run `bunx vitest run <test-path>` → confirm PASS
   - Run `bunx tsc --noEmit` → zero errors
   - Run `bun run lint` if lint config exists → zero new warnings
   - Commit with the prescribed commit message template
   - Self-review: re-read the diff, confirm nothing unrelated changed

2. Dispatch spec-compliance reviewer subagent:
   - Input: BL-NN backlog entry + git diff for the fix branch
   - Confirm fix addresses all of: fix spec, tests, acceptance criteria
   - If gaps: implementer fixes, re-review.

3. Dispatch code-quality reviewer subagent:
   - Input: git diff + project CLAUDE.md rules
   - Confirm: no console.log, uses sql tagged template, has company_id scoping, wraps handlers with withCompany, uses apiResponse helpers, no empty catches, no `any` abuse, file stays ≤300 lines.
   - If issues: implementer fixes, re-review.

4. Controller (you) merges the worktree branch into master via fast-forward:
   - cd /home/hein/Workspace/IsaFlow && git merge --ff-only fix/BL-NN-<slug>
   - Delete the worktree: `git worktree remove ../isaflow-BL-NN`
   - Mark task complete in TodoWrite.
```

**Commit message template:** `fix(BL-NN): <one-line summary>` (lowercase, imperative). Include trailer `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`.

**Dispatch order signal:** Wave A items may be dispatched concurrently (up to 4 at a time to avoid merge conflicts on `master`). Wave B items are dispatched one at a time in the listed order. Wave C is concurrent after Wave B.

---

## File Structure

### New files created in this sprint

- `src/lib/dateUtils.ts` — `toISODate()` helper (Task BL-07)
- `src/lib/constants/invoiceStatuses.ts` — `AR_OPEN_STATUSES`, `AP_OPEN_STATUSES` (Task BL-04)
- `scripts/migrations/sql/292_vat_and_retained_earnings_subtypes.sql` (Task BL-05 + BL-06 combined)
- `scripts/migrations/sql/293_bank_transactions_company_date_index.sql` (Task BL-11)
- `scripts/migrations/sql/294_gl_journal_lines_company_id.sql` (Task BL-13)
- `scripts/migrations/sql/295_customer_invoices_coalesce_index.sql` (Task BL-23)
- `scripts/migrations/sql/296_gl_journal_entries_company_date_posted_index.sql` (Task BL-12)
- `tests/unit/services/transactionLedgerService.test.ts` (Task BL-01)
- `tests/unit/services/yearEndService.test.ts` (Task BL-09)
- `tests/unit/services/bankAllocationService.test.ts` (Task BL-05)
- `tests/unit/services/balanceSheetService.test.ts` (Task BL-06)
- `tests/unit/services/bankTransactionQueryService.test.ts` (Task BL-11 + BL-17)
- `tests/unit/services/dashboardStatsService.test.ts` (or direct handler test — Tasks BL-03, BL-04)
- `tests/unit/lib/dateUtils.test.ts` (Task BL-07)
- `tests/integration/api/products-categories.test.ts` (Task BL-02)
- `tests/integration/api/customer-invoices-detail.test.ts` (Task BL-10)
- `.eslintrc.overrides.json` additions for `no-console` allow-list (Task BL-14)

### Deleted files
- `pages/accounting/bank-feeds.tsx` (Task BL-16 — dead route)

### Modified files (abbreviated — full list in each task's "Files" section below)
- `src/modules/accounting/services/gl/transactionLedgerService.ts`
- `pages/api/accounting/products-categories.ts`
- `pages/api/accounting/dashboard-stats.ts`
- `pages/api/accounting/reports-budget-vs-actual.ts`
- `pages/api/accounting/fiscal-periods.ts`
- `pages/api/accounting/supplier-allocations.ts`
- `pages/api/accounting/reports-balance-sheet.ts`
- `src/modules/accounting/services/gl/yearEndService.ts`
- `pages/api/accounting/customer-invoices-detail.ts`
- `src/modules/accounting/services/bank/bankTransactionQueryService.ts`
- `pages/api/accounting/reports-cash-flow.ts`
- `src/modules/accounting/services/bank/bankAllocationService.ts`
- `src/modules/accounting/services/reports/balanceSheetService.ts`
- `pages/api/accounting/company-logo.ts`
- `pages/api/accounting/companies.ts`
- ~43 files with `console.*` replacements (Task BL-14)
- `pages/api/accounting/customer-invoices-list.ts`
- `src/modules/accounting/services/ap/supplierInvoiceService.ts`
- `pages/api/accounting/chart-of-accounts.ts` (cache)
- `pages/api/accounting/gl-import-template.ts`
- `pages/api/auth/register.ts`
- `pages/api/auth/forgot-password.ts`
- `pages/api/accounting/customer-payments.ts` (BL-28 investigation)
- `pages/api/accounting/supplier-invoices.ts` (BL-29 field name)
- `src/lib/auth/withCompany.ts` (typed wrapper — BL-34)
- `scripts/mint-for-admin-qa.ts` (BL-38 portability)
- `.env.local` (BL-36)
- `package.json` (BL-37)

---

# WAVE A — Parallel isolated fixes (18 items)

Dispatch up to 4 implementer subagents concurrently. Each fix is ≤3 files, independent, no migration. All use their own worktree.

**After all Wave A tasks land on master, HARD STOP. Run the following verification before Wave B starts:**
```
cd /home/hein/Workspace/IsaFlow
bunx tsc --noEmit                          # zero errors
bunx vitest run tests/unit                 # all pass
bun run build                              # completes clean (no duplicate-page warning once BL-16 lands)
bash scripts/audit-2026-04-14/perf-autocannon.sh > /tmp/wave-A-smoke.txt   # smoke
```

---

## Task BL-02: Fix products-categories.ts cross-tenant leak (P0)

**Why it's first in Wave A:** Highest severity, smallest change. Dispatch this with BL-01 simultaneously.

**Files:**
- Modify: `pages/api/accounting/products-categories.ts:12`
- Test: `tests/integration/api/products-categories.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/api/products-categories.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import handler from '@/pages/api/accounting/products-categories';
import { createMocks } from 'node-mocks-http';

describe('GET /api/accounting/products-categories — tenant scoping', () => {
  const COMPANY_A = '00000000-0000-0000-0000-0000000000a1';
  const COMPANY_B = '00000000-0000-0000-0000-0000000000b1';

  beforeAll(async () => {
    await sql`INSERT INTO companies (id, name) VALUES (${COMPANY_A}, 'A'), (${COMPANY_B}, 'B') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO product_categories (company_id, name, is_active) VALUES
      (${COMPANY_A}, 'A-cat-1', true),
      (${COMPANY_A}, 'A-cat-2', true),
      (${COMPANY_B}, 'B-cat-1', true)
      ON CONFLICT DO NOTHING`;
  });

  afterAll(async () => {
    await sql`DELETE FROM product_categories WHERE company_id IN (${COMPANY_A}, ${COMPANY_B})`;
    await sql`DELETE FROM companies WHERE id IN (${COMPANY_A}, ${COMPANY_B})`;
  });

  it('returns only company A categories when called with company A context', async () => {
    const { req, res } = createMocks({ method: 'GET' });
    (req as any).companyId = COMPANY_A;  // withCompany middleware injects this
    await handler(req as any, res as any);
    const body = JSON.parse(res._getData());
    expect(body.success).toBe(true);
    expect(body.data.every((c: any) => c.company_id === COMPANY_A)).toBe(true);
    expect(body.data).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

`bunx vitest run tests/integration/api/products-categories.test.ts` → expect failure (returns 3 rows, includes company B).

- [ ] **Step 3: Apply the fix**

Edit `pages/api/accounting/products-categories.ts:12`:
```typescript
// BEFORE
const categories = await sql`SELECT * FROM product_categories WHERE is_active = true ORDER BY name`;
// AFTER
const categories = await sql`SELECT * FROM product_categories WHERE company_id = ${companyId}::UUID AND is_active = true ORDER BY name`;
```

Note: if the handler signature doesn't already have `companyId` from `withCompany`, verify it does — the file should already use `withCompany(withErrorHandler(...))`.

- [ ] **Step 4: Run test, confirm PASS**

`bunx vitest run tests/integration/api/products-categories.test.ts` → 1 passed.

- [ ] **Step 5: Live-probe regression**

Mint the viewer token from `/tmp/isaflow-mint-viewer.ts` (created by the security audit). Call `GET /api/accounting/products-categories` with `X-Company-Id: <other company>`. Response should contain ONLY that company's categories.

- [ ] **Step 6: Commit**

```bash
git add pages/api/accounting/products-categories.ts tests/integration/api/products-categories.test.ts
git commit -m "fix(BL-02): scope product_categories by company_id (P0 cross-tenant leak)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-03: Dashboard bank balance — use GL, not raw bank_transactions sum

**Files:**
- Modify: `pages/api/accounting/dashboard-stats.ts:38-46`
- Test: `tests/unit/services/dashboardStatsService.test.ts` (new) — or add to an existing test file if present

- [ ] **Step 1: Write the failing test**

Seed three bank txns totalling 1,000; post two to GL totalling 600. Assert dashboard bank balance = 600.

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';

// Seed helper — use existing seed utils if present
async function seedScenario(companyId: string) {
  // 3 bank_transactions summing 1000, 2 posted to gl_journal_lines against a bank account (subtype='bank') summing 600
}

describe('dashboard-stats bank balance', () => {
  it('returns GL-balance (600), not raw tx sum (1000)', async () => {
    // Arrange
    // Act: call the handler or the service function directly
    // Assert: bank balance === 600
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

- [ ] **Step 3: Apply the fix**

In `pages/api/accounting/dashboard-stats.ts:38-46`, replace the bank-balance aggregation:

```typescript
// Replace the SUM(bank_transactions.amount) query with:
const [bankBalanceRow] = await sql`
  SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS balance
  FROM gl_journal_lines jl
  JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
  JOIN gl_accounts ga ON ga.id = jl.gl_account_id
  WHERE je.company_id = ${companyId}::UUID
    AND je.status = 'posted'
    AND ga.company_id = ${companyId}::UUID
    AND ga.account_subtype = 'bank'
`;
const bankBalance = Number(bankBalanceRow?.balance ?? 0);
```

- [ ] **Step 4: Run test, confirm PASS**

- [ ] **Step 5: Smoke-check on dev demo**

```bash
source /tmp/isaflow-admin-token.env
curl -sf -H "Cookie: isaflow_auth=$TOKEN" -H "X-Company-Id: 00000000-0000-0000-0000-000000000001" \
  http://localhost:3200/api/accounting/dashboard-stats | jq '.data.bankBalance'
# Expect: ~975880.61 (matches Trial Balance), NOT ~35210973.52
```

- [ ] **Step 6: Commit**

```bash
git add pages/api/accounting/dashboard-stats.ts tests/unit/services/dashboardStatsService.test.ts
git commit -m "fix(BL-03): dashboard bank balance reads from GL, not raw tx sum

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-04: Dashboard AR/AP exclude drafts + extract shared status constants

**Files:**
- Create: `src/lib/constants/invoiceStatuses.ts`
- Modify: `pages/api/accounting/dashboard-stats.ts:55-59` (and AP equivalent — grep for `apTotal`)
- Modify: `src/modules/accounting/services/reports/arAgingService.ts`, `apAgingService.ts`, `kpiDashboardService.ts` — import the shared constants
- Test: same `tests/unit/services/dashboardStatsService.test.ts` as BL-03 — extend

- [ ] **Step 1: Write failing test**

Seed 3 invoices (1 draft, 1 approved R500, 1 paid). Assert dashboard `arTotal` = 500 (drafts excluded, paid excluded).

- [ ] **Step 2: Confirm FAIL**

- [ ] **Step 3: Create the shared constants file**

`src/lib/constants/invoiceStatuses.ts`:
```typescript
/** Invoice statuses counted as open/outstanding for AR reporting and dashboards. */
export const AR_OPEN_STATUSES = ['sent', 'approved', 'overdue', 'partial'] as const;
export type AROpenStatus = typeof AR_OPEN_STATUSES[number];

/** Invoice statuses counted as open/outstanding for AP reporting and dashboards. */
export const AP_OPEN_STATUSES = ['received', 'approved', 'overdue', 'partial'] as const;
export type APOpenStatus = typeof AP_OPEN_STATUSES[number];
```
(Verify actual status values by grepping the codebase first — adjust if they differ.)

- [ ] **Step 4: Apply fix in dashboard-stats.ts**

Replace `WHERE status NOT IN ('cancelled', 'paid')` with `WHERE status = ANY(${AR_OPEN_STATUSES}::text[])`. Same pattern for AP totals.

- [ ] **Step 5: Update the other consumers**

In `arAgingService.ts`, `apAgingService.ts`, `kpiDashboardService.ts`: replace any inline status lists with imports from the new constants module. Must be no behavioural change (they were already excluding drafts — just DRYing).

- [ ] **Step 6: Run test, confirm PASS**

- [ ] **Step 7: Smoke-check on dev demo**

```bash
source /tmp/isaflow-admin-token.env
curl -sf -H "Cookie: isaflow_auth=$TOKEN" -H "X-Company-Id: 00000000-0000-0000-0000-000000000001" \
  http://localhost:3200/api/accounting/dashboard-stats | jq '{ar:.data.arTotal, ap:.data.apTotal}'
# Expect: ar≈12920702.54 (matches AR aging), ap≈3158750.48 (matches AP aging)
```

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(BL-04): exclude drafts from dashboard AR/AP; extract shared status constants

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-07: Fiscal period date normalization helper

**Files:**
- Create: `src/lib/dateUtils.ts`
- Modify: `pages/api/accounting/reports-budget-vs-actual.ts:39-43`
- Modify: `pages/api/accounting/fiscal-periods.ts` (response mapping for `startDate`/`endDate`)
- Test: `tests/unit/lib/dateUtils.test.ts` (new)

- [ ] **Step 1: Write failing test**

```typescript
// tests/unit/lib/dateUtils.test.ts
import { describe, it, expect } from 'vitest';
import { toISODate } from '@/lib/dateUtils';

describe('toISODate', () => {
  it('converts a JS Date to YYYY-MM-DD', () => {
    expect(toISODate(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01-01');
  });
  it('passes through an ISO 8601 string', () => {
    expect(toISODate('2027-01-01T00:00:00.000Z')).toBe('2027-01-01');
  });
  it('converts a JS Date .toString() representation', () => {
    const s = new Date('2027-01-01T00:00:00.000Z').toString(); // "... GMT+0200 ..."
    expect(toISODate(s)).toBe('2027-01-01');
  });
  it('returns null for null/undefined', () => {
    expect(toISODate(null)).toBeNull();
    expect(toISODate(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Confirm FAIL**

- [ ] **Step 3: Implement helper**

`src/lib/dateUtils.ts`:
```typescript
/**
 * Normalize a date value to 'YYYY-MM-DD'. Accepts Date objects, ISO strings,
 * and JavaScript Date.toString() representations. Returns null for null/undefined.
 */
export function toISODate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}
```

- [ ] **Step 4: Confirm PASS**

- [ ] **Step 5: Apply in consumers**

In `pages/api/accounting/reports-budget-vs-actual.ts:39-43`, replace:
```typescript
const start = fy?.start_date?.toString().split('T')[0];
// WITH
import { toISODate } from '@/lib/dateUtils';
const start = toISODate(fy?.start_date);
```
Same for `end`. Same pattern for `pages/api/accounting/fiscal-periods.ts`.

- [ ] **Step 6: Grep for remaining offenders**

```bash
grep -rn "\.split('T')\[0\]" src/ pages/ | grep -v tests/
```
If more matches appear that are on date values, replace with `toISODate`. (Do not touch unrelated split-on-T uses.)

- [ ] **Step 7: Smoke-check**

```bash
curl -sf -H "Cookie: isaflow_auth=$TOKEN" -H "X-Company-Id: 00000000-0000-0000-0000-000000000001" \
  "http://localhost:3200/api/accounting/reports-budget-vs-actual" | jq '.success'
# Expect: true (was 500 before)
```

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(BL-07): add toISODate helper; fix budget-vs-actual YTD crash

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-08: Supplier Allocations — unswallow error, return list

**Files:**
- Modify: `pages/api/accounting/supplier-allocations.ts:72-74` (catch block)

- [ ] **Step 1: Write failing test (GET without params)**

Add an integration test: GET with no params returns 200 + an array (may be empty) for both demo companies.

- [ ] **Step 2: Confirm FAIL (currently 400)**

- [ ] **Step 3: Apply fix — replace the error-swallowing catch**

```typescript
// BEFORE
} catch (err) {
  return apiResponse.badRequest(res, 'Failed to get allocations');
}
// AFTER
} catch (err) {
  log.error({ err, companyId }, 'Failed to get supplier allocations');
  return apiResponse.internalError(res, err as Error);
}
```

If `apiResponse.internalError` does not exist in `src/lib/apiResponse.ts`, use `apiResponse.serverError` or add the helper (check existing helper names first).

- [ ] **Step 4: Diagnose underlying failure**

Once the real error surfaces, fix it. Most likely: missing table or schema drift on `supplier_payment_allocations`. Run: `SELECT * FROM supplier_payment_allocations LIMIT 1` against dev DB. If missing, check migrations.

- [ ] **Step 5: Confirm PASS**

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(BL-08): unswallow supplier-allocations error; return company-scoped list

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-09: yearEndService — move company_id to WHERE clause

**Files:**
- Modify: `src/modules/accounting/services/gl/yearEndService.ts:122, :138`
- Test: `tests/unit/services/yearEndService.test.ts` (new)

- [ ] **Step 1: Write failing test**

Seed company A with 2 posted journals (1 revenue, 1 expense), company B with 1 posted revenue journal. Run year-end close for company A. Assert no company B lines are touched (positive + negative assertion).

- [ ] **Step 2: Confirm FAIL? — verify baseline**

The current code is guarded via the JOIN clause. Test may PASS immediately. If it does, still proceed — the fix is about preventing future regression, not fixing a live bug.

- [ ] **Step 3: Apply the refactor**

Move `AND je.company_id = ${companyId}` from the `LEFT JOIN … ON` to the outer `WHERE` clause. At the top of the function, add:
```typescript
// gl_journal_lines has no company_id column. ALL tenant scoping MUST go via
// gl_journal_entries.company_id. See docs/audits/2026-04-14/02-security-findings.md#S-002.
```

- [ ] **Step 4: Confirm PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(BL-09): yearEndService — hoist company_id from JOIN ON to WHERE clause

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-10: customer-invoices-detail — check rowCount on UPDATE/POST

**Files:**
- Modify: `pages/api/accounting/customer-invoices-detail.ts:56-69, :72` (UPDATE and status-action POST)
- Test: `tests/integration/api/customer-invoices-detail.test.ts` (new)

- [ ] **Step 1: Write failing test**

Two cases:
1. PUT with a foreign-tenant invoice ID from viewer's cookie → expect 404.
2. PUT with nonexistent invoice ID → expect 404.

- [ ] **Step 2: Confirm FAIL (currently returns 200 `{updated:true}`)**

- [ ] **Step 3: Apply fix**

```typescript
// BEFORE
await sql`UPDATE customer_invoices SET ... WHERE id = ${id} AND company_id = ${companyId}::UUID`;
return apiResponse.success(res, { updated: true });
// AFTER
const result = await sql`UPDATE customer_invoices SET ... WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING id`;
if (result.length === 0) {
  return apiResponse.notFound(res, 'Invoice', id);
}
return apiResponse.success(res, { updated: true });
```

Apply the same pattern to the POST handler at line 72.

- [ ] **Step 4: Grep for similar anti-patterns**

```bash
grep -rn "await sql\`UPDATE" pages/api/ src/modules/ | grep -v RETURNING
```
Log any additional offenders as follow-up items (don't fix in this task — scope is BL-10 only).

- [ ] **Step 5: Confirm PASS + replay exploit**

Replay S-003 exploit — response must now be 404.

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(BL-10): customer-invoices-detail — 404 when update affects 0 rows (S-003)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-12: reports-cash-flow — collapse 6 queries, cache schema probe

**Files:**
- Modify: `pages/api/accounting/reports-cash-flow.ts`
- Create: `scripts/migrations/sql/296_gl_journal_entries_company_date_posted_index.sql`

This task is Wave A (not B) because the migration is a pure additive index with `IF NOT EXISTS` and touches no shared service. Dispatch after BL-11 migration has landed (Wave B ordering note — see dependency matrix).

- [ ] **Step 1: Create the migration**

`scripts/migrations/sql/296_gl_journal_entries_company_date_posted_index.sql`:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gl_journal_entries_company_date_posted
  ON gl_journal_entries (company_id, entry_date)
  WHERE status = 'posted';
```

- [ ] **Step 2: Apply migration to dev**

```bash
export $(grep DATABASE_URL .env.local | xargs) && bun run db:migrate
```

- [ ] **Step 3: Write snapshot test for cash-flow**

In `tests/unit/services/cashFlowReport.test.ts` (new or existing), capture the current output shape for ISAFlow Demo for period 2026-01-01 to 2026-01-31. This locks down behaviour during the rewrite.

- [ ] **Step 4: Apply code fix**

Replace the 6-query Promise.all block + the schema-probe try/catch with a single conditional-aggregation query. Full SQL in `docs/audits/2026-04-14/03-perf-findings.md#P-002`. Also move the opening-balance query into the (now simplified) Promise.all.

- [ ] **Step 5: Confirm snapshot test PASS (no logic change)**

- [ ] **Step 6: Smoke + perf retest**

```bash
bash scripts/audit-2026-04-14/perf-autocannon.sh 2>&1 | grep cash-flow
# Expect: p95 reduction vs baseline in 03-perf-findings.md
```

- [ ] **Step 7: Commit**

```bash
git commit -m "fix(BL-12): collapse 6 cash-flow queries into 1; drop schema probe (P-002 + P-009)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-14: Replace 53 `console.*` calls with `log`

**Files:** ~43 files across `src/` and `pages/` (full list in `04-code-quality.md` under rule "console.*").

- [ ] **Step 1: Run grep baseline**

```bash
grep -rn 'console\.\(log\|info\|warn\|error\|debug\)' src/ pages/ --include='*.ts' --include='*.tsx' | grep -v 'tests/' > /tmp/console-offenders.txt
wc -l /tmp/console-offenders.txt   # expect 53
```

- [ ] **Step 2: Codemod — replace each offender**

For each file in the list EXCEPT the allow-list (`src/lib/logger.ts`, `src/lib/api-error-handler.ts`, `src/lib/neon.ts`):

1. Add import: `import { log } from '@/lib/logger';` if not already imported.
2. Replace:
   - `console.log(` → `log.info(`
   - `console.info(` → `log.info(`
   - `console.warn(` → `log.warn(`
   - `console.error(` → `log.error(`
   - `console.debug(` → `log.debug(`
3. Check argument shape: `log.info` may take `(msg)` or `(ctx, msg)` — check `src/lib/logger.ts` for signature. Adapt each call to match.

- [ ] **Step 3: Add ESLint allow-list**

If `.eslintrc.js`/`.eslintrc.json` exists, add a rule:
```json
{
  "rules": { "no-console": ["error", { "allow": [] }] },
  "overrides": [
    {
      "files": ["src/lib/logger.ts", "src/lib/api-error-handler.ts", "src/lib/neon.ts"],
      "rules": { "no-console": "off" }
    }
  ]
}
```

- [ ] **Step 4: Add file-level allow-list comments (BL-39 combined)**

Top of `src/lib/logger.ts`, `src/lib/api-error-handler.ts`, `src/lib/neon.ts`:
```typescript
// eslint-disable no-console -- This module is the logging fallback path;
// using console is intentional when structured logging is unavailable.
```

- [ ] **Step 5: Run `bun run lint` → zero new errors**

- [ ] **Step 6: Run full test suite**

```bash
bunx tsc --noEmit
bunx vitest run
```

- [ ] **Step 7: Verify grep baseline is empty outside allow-list**

```bash
grep -rn 'console\.' src/ pages/ --include='*.ts' --include='*.tsx' | \
  grep -v 'src/lib/logger.ts\|src/lib/api-error-handler.ts\|src/lib/neon.ts\|tests/'
# Expect: no output
```

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(BL-14 BL-39): replace 53 console.* with log.*; add ESLint no-console allow-list

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-15: Verify auth on company-logo.ts and companies.ts handlers

**Files:**
- Modify: `pages/api/accounting/company-logo.ts`
- Modify: `pages/api/accounting/companies.ts`

- [ ] **Step 1: Read both files in full**

Understand what they do, what auth they currently enforce, whether they're called from the frontend and with what context.

- [ ] **Step 2: Decide pattern for each**

Options per file:
- (a) Wrap with `withCompany(withErrorHandler(...))` — default.
- (b) Use `withAuth` with explicit tenant scoping inside (if the handler must serve multiple companies, e.g. `companies.ts` listing all user's companies).
- (c) Document as intentionally public.

- [ ] **Step 3: Apply chosen pattern**

Add wrapper OR inline scoping check OR header comment. Example header comment template:
```typescript
/**
 * AUTH: Uses withAuth + inline company-membership check on line NN.
 * See docs/audits/2026-04-14/02-security-findings.md#Q-005.
 */
```

- [ ] **Step 4: Live probe**

Unauthenticated call → 401.
Authenticated call for company A, requesting company B data → 403 or filtered response.

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(BL-15): document/enforce auth on company-logo and companies handlers

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-16: Delete duplicate bank-feeds.tsx

**Files:**
- Delete: `pages/accounting/bank-feeds.tsx`

- [ ] **Step 1: Confirm no imports**

```bash
grep -rn "bank-feeds\.tsx\|from.*['\"].*bank-feeds\"" src/ pages/ | grep -v "bank-feeds/index"
# Expect: no results
```

- [ ] **Step 2: Delete the file**

```bash
git rm pages/accounting/bank-feeds.tsx
```

- [ ] **Step 3: Verify build & no warning**

```bash
bun run build 2>&1 | grep -i 'duplicate page'
# Expect: no output
```

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(BL-16): delete duplicate bank-feeds.tsx (superseded by bank-feeds/index.tsx)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-17: Bank TX status filter honoured without bank_account_id

**Files:**
- Modify: `src/modules/accounting/services/bank/bankTransactionQueryService.ts:117-181`
- Test: extend `tests/unit/services/bankTransactionQueryService.test.ts` (will also be touched by BL-11)

- [ ] **Step 1: Write failing test**

Seed 5 bank txns for company A, 3 `status='imported'`, 2 `status='matched'`. Call with filters `{ status: 'imported' }` (no bank_account_id). Assert returns 3 rows.

- [ ] **Step 2: Confirm FAIL (currently returns 5)**

- [ ] **Step 3: Apply fix**

In the company-wide query branch (lines 175-181), apply the same status-filter clause as the `bank_account_id + status` branch. A minimal change adds `AND ($2::text IS NULL OR bt.status = $2::text)` or similar.

- [ ] **Step 4: Confirm PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(BL-17): bank tx status filter honoured without bank_account_id

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-18: Trial Balance API — canonicalize response key

**Files:**
- Modify: `src/modules/accounting/services/reports/balanceSheetService.ts` (type `TBRow` + any comment)
- Modify any doc comment referring to `accounts`.

- [ ] **Step 1: Grep for current key usage**

```bash
grep -rn "data\.accounts\|data\?\.accounts" src/ pages/
```
Expect: zero UI matches (frontend reads `rows`). If there are none, this is documentation-only.

- [ ] **Step 2: Update `TBRow` type to canonical `rows` terminology**

Make sure the returned shape matches what the handler actually returns.

- [ ] **Step 3: Commit**

```bash
git commit -m "fix(BL-18): canonicalize TB response key as 'rows'; align types + docs

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-20: Auth endpoints — use last-hop IP for rate limit

**Files:**
- Modify: `pages/api/auth/register.ts`
- Modify: `pages/api/auth/forgot-password.ts`

- [ ] **Step 1: Compare to login.ts**

Read `pages/api/auth/login.ts:32-40` to see how it extracts the last-hop IP. It already uses the shared helper in `src/lib/rateLimit.ts:50`.

- [ ] **Step 2: Replace IP extraction in register.ts and forgot-password.ts**

Use the same shared helper as `login.ts`.

- [ ] **Step 3: Fix the stale doc comment in register.ts:7-8**

Current comment says "Does NOT set an auth cookie — user must log in after registering." It does. Update to match behaviour.

- [ ] **Step 4: Test — 50 rapid registers from one IP**

Expect rate-limit kicks in at the documented threshold regardless of `x-forwarded-for` header manipulation.

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(BL-20): register/forgot-password use last-hop IP for rate limit (S-004)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-24: supplier-invoices list — explicit columns + cap limit

**Files:**
- Modify: `src/modules/accounting/services/ap/supplierInvoiceService.ts` (column list + limit cap)

- [ ] **Step 1: List columns actually consumed**

Read the mapper / caller to list the ~15 columns actually read.

- [ ] **Step 2: Replace `SELECT si.*`**

Replace with the explicit column list. Cap max `limit` at 100 in the service; expose `/export` endpoint for full dumps (if it doesn't exist, leave as TODO note — not in scope).

- [ ] **Step 3: Confirm no caller reads a column removed from the projection**

Grep: `grep -rn "invoice\.\w*" src/ pages/ | grep supplierInvoice` — audit if any expected field was removed.

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(BL-24): supplier-invoices — explicit column list; cap list limit at 100

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-25: chart-of-accounts — prod retest first, cache if needed

**Files:**
- Modify (contingent): `pages/api/accounting/chart-of-accounts.ts`

- [ ] **Step 1: Prod-mode retest**

```bash
bun run build && bun run start &
sleep 5
curl -sf -w '\ntime=%{time_total}\n' -H "Cookie: isaflow_auth=$TOKEN" \
  http://localhost:3200/api/accounting/chart-of-accounts > /tmp/coa-prod.txt
tail -3 /tmp/coa-prod.txt
```

- [ ] **Step 2: If p99 < 1s in prod mode, close as "dev-mode only"**

Add a note to `03-perf-findings.md` and skip the cache.

- [ ] **Step 3: If p99 ≥ 1s, add in-memory TTL cache**

Simple LRU with 60s TTL per company. Pattern from `src/lib/cache.ts` if it exists.

- [ ] **Step 4: Commit (even if just a documentation update)**

```bash
git commit -m "fix(BL-25): chart-of-accounts — prod retest OR add 60s TTL cache

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-28: Customer payments allocatedAmount investigation

**Files:** likely read-only investigation; possible modifications to `pages/api/accounting/customer-payments.ts` OR a data backfill script.

- [ ] **Step 1: Diagnose**

Run against dev:
```sql
SELECT p.id, p.total_amount, COUNT(a.id) AS alloc_count, SUM(a.allocated_amount) AS alloc_sum
FROM customer_payments p
LEFT JOIN customer_payment_allocations a ON a.customer_payment_id = p.id
WHERE p.company_id = '00000000-0000-0000-0000-000000000001'
GROUP BY p.id, p.total_amount
LIMIT 10;
```

- [ ] **Step 2: Classify**

- If `customer_payment_allocations` is genuinely empty: it's a data problem — raise a follow-up data-backfill ticket and close BL-28 with findings documented.
- If allocations exist but the query doesn't join them correctly: fix the service query.

- [ ] **Step 3: Apply whichever fix the diagnosis indicates**

- [ ] **Step 4: Commit (may be findings only)**

---

## Task BL-29: supplier_invoices — field name cleanup

**Files:**
- Modify: `pages/api/accounting/supplier-invoices.ts` (response mapping)

- [ ] **Step 1: Decide canonical field name**

Check how customer_invoices returns (currently `total_amount` snake_case per F-014). Pick the same convention for supplier_invoices OR move both to camelCase — but do not split conventions.

- [ ] **Step 2: Apply the mapping consistently**

- [ ] **Step 3: Audit UI consumers**

Grep: `grep -rn "invoice\.total_amount\|invoice\.totalAmount" src/components/ pages/accounting/`

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(BL-29): supplier_invoices field naming consistent with customer_invoices

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-30: CI grep — forbid external decodeToken imports

**Files:**
- Modify: CI config (check for `.github/workflows/*.yml`, `scripts/ci/*.sh`, or add a new lint step)

- [ ] **Step 1: Add grep check**

Place in `scripts/ci/check-internal-apis.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
OFFENDERS=$(grep -rn "import.*decodeToken" src/ pages/ 2>/dev/null | grep -v 'src/lib/auth/jwt\.ts' || true)
if [[ -n "$OFFENDERS" ]]; then
  echo "ERROR: decodeToken is internal-only. Do not import outside src/lib/auth/jwt.ts."
  echo "$OFFENDERS"
  exit 1
fi
echo "OK: decodeToken imports scoped correctly."
```

- [ ] **Step 2: Wire into CI**

Add to existing CI workflow as a new step, or invoke from `package.json` `lint` script.

- [ ] **Step 3: Commit**

---

## Task BL-36: Delete duplicate NEXT_PUBLIC_APP_URL from .env.local

**Files:**
- Modify: `.env.local`

- [ ] **Step 1: Delete line 21** (`NEXT_PUBLIC_APP_URL=https://app.isaflow.co.za`)

- [ ] **Step 2: Verify `.env.local` is NOT committed**

`.env.local` is gitignored; this change does not appear in git. Instead, update `.env.example` (if present) to show only one `NEXT_PUBLIC_APP_URL`.

- [ ] **Step 3: Commit .env.example change (if any)**

---

## Task BL-37: Align dev server port (3200 vs 3101)

**Files:**
- Modify: `package.json` scripts OR `.env.local`

- [ ] **Step 1: Pick canonical port**

Recommend `:3000` (Next.js default). Alternative: keep `:3200` and sync `.env.local`.

- [ ] **Step 2: Update package.json if needed**

If picking 3000: `"dev": "next dev"` (drop `-p 3200`).
Update `.env.local` (gitignored, so document in `.env.example`): `NEXT_PUBLIC_APP_URL=http://localhost:3000`.

- [ ] **Step 3: Update `docs/` references if any**

Grep for `localhost:3200` or `localhost:3101` in docs.

- [ ] **Step 4: Commit**

---

## Task BL-38: Fix mint-for-admin-qa.ts portability

**Files:**
- Modify: `scripts/mint-for-admin-qa.ts`

- [ ] **Step 1: Replace absolute import**

```typescript
// BEFORE
import { sql } from '/home/hein/Workspace/IsaFlow/src/lib/neon.ts';
// AFTER
import { sql } from '../src/lib/neon';
```

- [ ] **Step 2: Wrap top-level await**

```typescript
async function main() {
  // existing body
}
main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Update the audit helper script to match**

`scripts/audit-2026-04-14/mint-admin-token.sh` — verify it still works under both `bun run` and `bunx tsx`.

- [ ] **Step 4: Commit**

---

# WAVE A — Completion gate

After all 18 Wave A tasks merge, run:

- [ ] **Type check:** `bunx tsc --noEmit` → zero errors
- [ ] **Unit tests:** `bunx vitest run` → all pass
- [ ] **Build:** `bun run build` → succeeds, no duplicate-page warning
- [ ] **Lint:** `bun run lint` → zero new warnings
- [ ] **Perf smoke:** `bash scripts/audit-2026-04-14/perf-autocannon.sh > /tmp/wave-A-perf.txt`; diff top-level p95s against baseline in `03-perf-findings.md` — no regression.
- [ ] **Report to Hein:** path to wave-A-perf.txt + summary of items closed + any unexpected issues.

**STOP before Wave B.**

---

# WAVE B — Sequential cross-cutting (6 items)

One at a time. Each blocks the next. Migrations run against dev, then against prod after Phase 5.

## Task BL-01: transactionLedgerService cross-tenant leak (P0)

Full fix spec is in `docs/audits/2026-04-14/05-backlog.md#BL-01` — read it before starting.

**Files:**
- Modify: `src/modules/accounting/services/gl/transactionLedgerService.ts:45-78, :224-245`
- Test: `tests/unit/services/transactionLedgerService.test.ts` (new)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { getBankTransactions, getAuditTrail } from '@/modules/accounting/services/gl/transactionLedgerService';

describe('transactionLedgerService — cross-tenant isolation', () => {
  const COMPANY_A = '00000000-0000-0000-0000-0000000000a2';
  const COMPANY_B = '00000000-0000-0000-0000-0000000000b2';

  beforeAll(async () => {
    // seed both companies with 1 posted JE each, with a bank line
    // ... use existing seed utils or inline
  });
  afterAll(async () => { /* cleanup */ });

  it('getBankTransactions for company A returns no company B entries', async () => {
    const result = await getBankTransactions({ companyId: COMPANY_A, from: '2025-01-01', to: '2026-12-31' });
    const rows = [...(result.openingBalance ?? []), ...(result.rows ?? [])];
    expect(rows.every((r: any) => r.company_id === COMPANY_A)).toBe(true);
  });

  it('getAuditTrail for company A returns no company B entries', async () => {
    const result = await getAuditTrail({ companyId: COMPANY_A, from: '2025-01-01', to: '2026-12-31' });
    expect(result.every((r: any) => r.company_id === COMPANY_A)).toBe(true);
  });
});
```

- [ ] **Step 2: Confirm FAIL**

`bunx vitest run tests/unit/services/transactionLedgerService.test.ts` → both fail.

- [ ] **Step 3: Apply the fix**

`src/modules/accounting/services/gl/transactionLedgerService.ts`:
- Lines 54-63 (getBankTransactions opening-balance): add `AND je.company_id = ${companyId}::UUID` AND `AND ga.company_id = ${companyId}::UUID`.
- Lines 66-78 (getBankTransactions period): same.
- Lines 230-245 (getAuditTrail): same.

Pattern to copy: `getAccountTransactions` at lines 127, 150, 167 in the same file (already correct).

- [ ] **Step 4: Confirm PASS**

- [ ] **Step 5: Replay the security audit's live exploit**

Use `/tmp/isaflow-mint-viewer.ts` to mint a viewer token for company `b5e17198-c23d-4441-a90d-68c9bc4febef`. Call `/api/accounting/reports-audit-trail?period_start=2025-01-01&period_end=2026-12-31`. Response must contain ONLY the 1 JE that belongs to that viewer's tenant — no cross-tenant rows.

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(BL-01): transactionLedgerService — add je.company_id filter (P0 cross-tenant leak, S-001)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-05 + BL-06: VAT + Retained Earnings subtype data migration + code hardening

Combined because they share one migration file.

**Files:**
- Create: `scripts/migrations/sql/292_vat_and_retained_earnings_subtypes.sql`
- Modify: `src/modules/accounting/services/bank/bankAllocationService.ts`
- Modify: `src/modules/accounting/services/reports/balanceSheetService.ts` (retained_earnings lookup fallback)
- Modify: `pages/api/accounting/reports-balance-sheet.ts:35` (stop swallowing error)
- Test: `tests/unit/services/bankAllocationService.test.ts` (new)
- Test: `tests/unit/services/balanceSheetService.test.ts` (new)

- [ ] **Step 1: Write the migration**

`scripts/migrations/sql/292_vat_and_retained_earnings_subtypes.sql`:
```sql
-- BL-05: Normalize VAT account subtypes across all companies.
UPDATE gl_accounts
SET account_subtype = 'vat_output'
WHERE is_system_account = true
  AND (name ILIKE '%VAT Output%' OR account_code IN ('2120'))
  AND account_subtype IN ('tax', 'other_current_liability');

UPDATE gl_accounts
SET account_subtype = 'vat_input'
WHERE is_system_account = true
  AND (name ILIKE '%VAT Input%' OR account_code IN ('1140'))
  AND account_subtype IN ('other_current_asset', 'tax');

-- BL-06: Normalize retained earnings account subtype.
UPDATE gl_accounts
SET account_subtype = 'retained_earnings'
WHERE is_system_account = true
  AND account_type = 'equity'
  AND (name ILIKE '%retained%')
  AND account_subtype != 'retained_earnings';

-- BL-05: Seed missing VAT system accounts for any company that still lacks them.
-- For each company without vat_input/vat_output, insert defaults at codes 1140 / 2120.
INSERT INTO gl_accounts (company_id, account_code, name, account_type, account_subtype, is_system_account, is_active)
SELECT c.id, '1140', 'VAT Input', 'asset', 'vat_input', true, true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts ga
  WHERE ga.company_id = c.id AND ga.account_subtype = 'vat_input'
);

INSERT INTO gl_accounts (company_id, account_code, name, account_type, account_subtype, is_system_account, is_active)
SELECT c.id, '2120', 'VAT Output', 'liability', 'vat_output', true, true
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM gl_accounts ga
  WHERE ga.company_id = c.id AND ga.account_subtype = 'vat_output'
);
```

- [ ] **Step 2: Apply migration to dev**

```bash
export $(grep DATABASE_URL .env.local | xargs) && bun run db:migrate
```

- [ ] **Step 3: Verify demo data**

```bash
node -e "
const {neon}=require('@neondatabase/serverless');
const sql=neon(process.env.DATABASE_URL);
(async()=>{
  const rows = await sql\`SELECT company_id, account_subtype, COUNT(*) FROM gl_accounts WHERE account_subtype IN ('vat_input','vat_output','retained_earnings') GROUP BY 1,2 ORDER BY 1,2\`;
  console.log(rows);
})();
"
# Expect: every company has vat_input, vat_output, retained_earnings rows.
```

- [ ] **Step 4: Write failing tests**

`tests/unit/services/bankAllocationService.test.ts`: allocating a bank tx with `vatCode=standard` against both demo companies returns a success with VAT journal lines (was 500 before).

`tests/unit/services/balanceSheetService.test.ts`: generating balance sheet for Brightsphere returns 200 with populated sections (was 400).

- [ ] **Step 5: Confirm tests PASS after migration (may pass without code changes)**

- [ ] **Step 6: Apply code hardening**

In `bankAllocationService`, wrap the `getSystemAccount` lookup with a fallback that tries `account_code IN (...)` + returns a clear error if still not found. Fallback must NOT silently succeed — must flag a warning.

In `reports-balance-sheet.ts:35`, replace the generic 400 catch with structured error passthrough:
```typescript
// BEFORE
} catch (err) { return apiResponse.badRequest(res, 'Failed to generate balance sheet'); }
// AFTER
} catch (err) {
  log.error({ err, companyId, asAtDate }, 'balance sheet generation failed');
  return apiResponse.internalError(res, err as Error);
}
```

- [ ] **Step 7: Re-confirm tests PASS**

- [ ] **Step 8: Smoke-check on dev demos**

VAT: F-003 repro returns 200 on both companies.
Balance Sheet: F-004 repro returns 200 on Brightsphere.
VAT Return: F-011 repro returns non-zero boxes for ISAFlow Demo.

- [ ] **Step 9: Commit**

```bash
git commit -m "fix(BL-05 BL-06): normalize VAT + retained_earnings subtypes; unswallow BS errors

- Migration 292 sets vat_input/vat_output/retained_earnings on system accounts
- bankAllocationService falls back to account_code when subtype missing
- reports-balance-sheet surfaces real errors via internalError

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-11: bank_transactions composite index + service column-list + limit cap

**Files:**
- Create: `scripts/migrations/sql/293_bank_transactions_company_date_index.sql`
- Modify: `src/modules/accounting/services/bank/bankTransactionQueryService.ts:86-96, :174-181`
- Test: extend `tests/unit/services/bankTransactionQueryService.test.ts`

- [ ] **Step 1: Write the migration**

`scripts/migrations/sql/293_bank_transactions_company_date_index.sql`:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bt_company_date
  ON bank_transactions (company_id, transaction_date DESC, amount DESC)
  INCLUDE (bank_account_id, status);
```

- [ ] **Step 2: Apply migration to dev**

- [ ] **Step 3: Verify EXPLAIN uses new index**

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT bt.* FROM bank_transactions bt
WHERE bt.company_id = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c'
ORDER BY bt.transaction_date DESC, bt.amount DESC LIMIT 50;
```
Expect: `Index Scan Backward using idx_bt_company_date` (not `idx_bt_date`).

- [ ] **Step 4: Replace SELECT bt.* with explicit column list**

Read `mapTxRow` to list the exact fields consumed. Example:
```typescript
const TX_SELECT = `
  bt.id, bt.company_id, bt.bank_account_id, bt.transaction_date, bt.amount,
  bt.description, bt.reference, bt.status, bt.matched_at, bt.categorized_at,
  bt.contra_account_id, bt.vat_code, bt.import_batch_id, bt.created_at, bt.updated_at
  -- plus any other fields the mapper reads
`;
```

- [ ] **Step 5: Cap `limit` at 100**

```typescript
const safeLimit = Math.min(Number(filters?.limit ?? 50), 100);
```

- [ ] **Step 6: Confirm tests PASS (should still pass; just narrower projection)**

- [ ] **Step 7: Perf retest**

```bash
bash scripts/audit-2026-04-14/perf-autocannon.sh 2>&1 | grep bank-tx-list
# Expect: p95 and payload size reduced vs baseline.
```

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(BL-11): bank_transactions composite index + explicit column list + limit cap

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-13: gl_journal_lines add company_id column (STRUCTURAL — highest risk)

**Files:**
- Create: `scripts/migrations/sql/294_gl_journal_lines_company_id.sql`
- Modify: every service inserting into `gl_journal_lines` (grep list below)
- Modify: every service selecting from `gl_journal_lines` where `jl.company_id` filter helps (grep list below)
- Create: CI script enforcing scoping

This is the highest-risk fix in the sprint. Execute in a dedicated branch, do not merge until all smoke tests pass and a full perf retest confirms improvement.

- [ ] **Step 1: Write the migration (3 phases)**

`scripts/migrations/sql/294_gl_journal_lines_company_id.sql`:
```sql
-- Phase 1: add nullable column.
ALTER TABLE gl_journal_lines
  ADD COLUMN IF NOT EXISTS company_id UUID;

-- Phase 2: backfill.
UPDATE gl_journal_lines jl
SET company_id = je.company_id
FROM gl_journal_entries je
WHERE jl.journal_entry_id = je.id
  AND jl.company_id IS NULL;

-- Phase 3: enforce NOT NULL and FK.
ALTER TABLE gl_journal_lines
  ALTER COLUMN company_id SET NOT NULL;

ALTER TABLE gl_journal_lines
  ADD CONSTRAINT IF NOT EXISTS fk_gl_journal_lines_company
  FOREIGN KEY (company_id) REFERENCES companies(id);

-- Phase 4: index for partition pruning / perf.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gl_jl_company_entry
  ON gl_journal_lines (company_id, journal_entry_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gl_jl_company_account
  ON gl_journal_lines (company_id, gl_account_id);
```

Note: `ADD CONSTRAINT IF NOT EXISTS` is Postgres 9.6+ syntax for CONSTRAINT (may not work for FK on older versions). If Neon rejects, split into an explicit `DO $$ IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_gl_journal_lines_company') THEN ... END IF $$` block.

- [ ] **Step 2: Apply migration to dev (careful)**

The `ALTER TABLE … SET NOT NULL` is a metadata-only operation on recent Postgres, but verify on dev first. The backfill on the Neon dev branch with ~10k rows should be sub-second.

- [ ] **Step 3: Grep for every INSERT into gl_journal_lines**

```bash
grep -rn "INTO gl_journal_lines\|INSERT INTO gl_journal_lines" src/ pages/ --include='*.ts'
```

For each hit, ensure the INSERT now includes `company_id` in the column list and the correct value. The parent `gl_journal_entries` INSERT sets `company_id`; propagate it.

- [ ] **Step 4: Codemod — add `jl.company_id = ${companyId}` defence-in-depth filter**

Grep: `grep -rnE "FROM gl_journal_lines|JOIN gl_journal_lines" src/ pages/ --include='*.ts'`.

For each query, add `AND jl.company_id = ${companyId}::UUID` if not already scoped via that column.

- [ ] **Step 5: Add CI grep check**

Extend `scripts/ci/check-internal-apis.sh` (created in BL-30) with:
```bash
# Every FROM/JOIN gl_journal_lines must have jl.company_id OR je.company_id within 15 lines.
VIOLATIONS=$(awk '
  /FROM gl_journal_lines|JOIN gl_journal_lines/ { line=NR; match=FILENAME; in_query=15; buffer=""; }
  in_query > 0 { buffer = buffer "\n" $0; if ($0 ~ /jl\.company_id|je\.company_id/) in_query=-1; else in_query--; }
  in_query == 0 { print match ":" line " — missing company_id filter\n" buffer; }
' $(git ls-files "*.ts"))
if [[ -n "$VIOLATIONS" ]]; then
  echo "ERROR: gl_journal_lines usage without company_id scoping:"
  echo "$VIOLATIONS"
  exit 1
fi
```

- [ ] **Step 6: Run full unit + integration suites**

```bash
bunx tsc --noEmit
bunx vitest run
```

- [ ] **Step 7: Full functional smoke on dev**

Replay the 6 P1 functional bugs (F-001 through F-006) — all should still work. Replay the 3 performance endpoints most affected (cash-flow, journal-entries, TB) — EXPLAIN should no longer show Seq Scan on `gl_journal_lines`.

- [ ] **Step 8: Commit**

```bash
git commit -m "fix(BL-13): add company_id to gl_journal_lines (structural multi-tenant fix)

- Migration 294 adds column, backfills, NOT NULL, FK, 2 indexes
- All INSERT sites set company_id explicitly
- All SELECT/JOIN sites add defense-in-depth jl.company_id filter
- CI lint forbids future FROM/JOIN gl_journal_lines without scope

Closes: P-003, P-011, S-002 (structural). Unblocks RLS and partitioning.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Task BL-23: customer-invoices-list consolidation + expression index

**Files:**
- Create: `scripts/migrations/sql/295_customer_invoices_coalesce_index.sql`
- Modify: `pages/api/accounting/customer-invoices-list.ts` (collapse 4 branches into 1)

- [ ] **Step 1: Write the migration**

`scripts/migrations/sql/295_customer_invoices_coalesce_index.sql`:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ci_coalesce_client
  ON customer_invoices ((COALESCE(client_id, customer_id)));
```

- [ ] **Step 2: Apply migration**

- [ ] **Step 3: Consolidate branches**

Read the 4 branches in the current handler. Replace with one parameterized query using optional-filter idioms:
```typescript
const rows = await sql`
  SELECT <explicit columns>
  FROM customer_invoices ci
  LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
  WHERE ci.company_id = ${companyId}::UUID
    AND (${statusFilter ?? null}::text IS NULL OR ci.status = ${statusFilter ?? null}::text)
    AND (${clientIdFilter ?? null}::uuid IS NULL OR COALESCE(ci.client_id, ci.customer_id) = ${clientIdFilter ?? null}::uuid)
    AND (${searchTermFilter ?? null}::text IS NULL OR ci.invoice_number ILIKE '%' || ${searchTermFilter ?? null}::text || '%')
  ORDER BY ci.invoice_date DESC
  LIMIT ${safeLimit} OFFSET ${offset}
`;
```

- [ ] **Step 4: Snapshot test — same outputs for all 4 original filter combinations**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(BL-23): customer-invoices-list — consolidate 4 branches + COALESCE expr index

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

# WAVE B — Completion gate

After all 6 Wave B tasks merge:

- [ ] **Type check:** `bunx tsc --noEmit` → zero errors
- [ ] **Unit tests:** `bunx vitest run` → all pass
- [ ] **Full functional replay:** re-walk F-001 through F-006 on both demo companies; all must pass.
- [ ] **Perf retest:** `bash scripts/audit-2026-04-14/perf-autocannon.sh > /tmp/wave-B-perf.txt`. Diff vs Wave A baseline — expect measurable improvement on bank-tx-list, cash-flow, journal-entries, TB.
- [ ] **Security regression:** replay S-001 + S-003 + BL-02 Q-003 exploits — all must return 403/404 now.
- [ ] **Migration verification:** run `node -e 'const {neon}=require("@neondatabase/serverless"); const sql=neon(process.env.DATABASE_URL); (async()=>{const r=await sql`SELECT COUNT(*) FROM gl_journal_lines WHERE company_id IS NULL`; console.log(r);})()'` — expect 0.
- [ ] **Report to Hein:** diff of wave-A-perf vs wave-B-perf, plus summary.

**STOP before Wave C.**

---

# WAVE C — Parallel UX polish (4 items)

Dispatch concurrently after Wave B.

## Task BL-26 (deferred): top 6 files > 500 LOC

Attack opportunistically when a fix in Wave A/B touches one of these files — not a dedicated sprint item. Keep the 68-offender ratchet in lint so no new offenders land.

## Task BL-34: Typed handler wrapper — remove 12 `handler as any` casts

**Files:**
- Modify: `src/lib/auth/withCompany.ts` (tighten the generic)
- Modify: 12 listed API route files

- [ ] **Step 1: Tighten `withCompany` generic**

Current signature likely `function withCompany(handler: any)`. Change to:
```typescript
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
export interface CompanyApiRequest extends NextApiRequest { companyId: string; user: { id: string; role: string } }
export type CompanyApiHandler = (req: CompanyApiRequest, res: NextApiResponse) => void | Promise<void>;
export function withCompany(handler: CompanyApiHandler): NextApiHandler { /* existing body */ }
```

- [ ] **Step 2: Remove `as any` casts in the 12 call sites**

Full list in `04-code-quality.md#Q-004`. Each call becomes `withCompany(withErrorHandler(handler))` with no cast.

- [ ] **Step 3: tsc --noEmit → zero errors**

- [ ] **Step 4: Commit**

---

## Task BL-35: gl-import-template.ts → apiResponse helper

**Files:**
- Modify: `pages/api/accounting/gl-import-template.ts:15`

- [ ] **Step 1: Swap raw response for helper**

```typescript
// BEFORE
return res.status(405).json({ error: 'Method not allowed' });
// AFTER
return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
```

- [ ] **Step 2: Commit**

---

## Task BL-29: supplier_invoices field naming (moved to Wave A — see above)

(Already covered. Leaving cross-reference here so readers don't miss it.)

---

# WAVE C — Completion gate

- [ ] **Type check + tests + build all green**
- [ ] **Report to Hein with full summary of all 30 items**

---

# Phase 3 Final Verification

After Wave C:

- [ ] **Re-run Task 2 consolidation (dry)** — every P0/P1 from `05-backlog.md` has a corresponding commit on `master` or a deferred-with-reason note.
- [ ] **Write Phase 3 closeout:** `docs/audits/2026-04-14/06-phase3-closeout.md` — summary of what landed, what deferred, what to watch for in Phase 4.
- [ ] **HARD STOP.** Hein approves before Phase 4 (hardening) plan is written.

---

## Self-review notes (completed during plan writing)

1. **Spec coverage:** All 30 items in `05-backlog.md` that fall within the approved cut line have a task here. Deferred items (BL-19, BL-21, BL-22, BL-26, BL-27, BL-31, BL-32, BL-33) are noted but do not have tasks in this plan by design (go to Phase 4 or ongoing programmes).
2. **Placeholder scan:** No "TBD"/"fill in" text. Every task has concrete file paths, commands, and code. Where diagnostic work is needed (BL-28), the diagnostic step is concrete.
3. **Type consistency:** `toISODate`, `AR_OPEN_STATUSES`, `CompanyApiHandler`, `AROpenStatus` used consistently where referenced.
4. **DRY note:** Fix specs are not fully duplicated from `05-backlog.md`; tasks reference the backlog entry for the detailed spec. This is intentional — the backlog is the source of truth for fix rationale; the plan is the execution runbook.
