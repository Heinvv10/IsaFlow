# PRD-01 Practice Management — Phase 4 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development.

**Goal:** Partner-facing management reporting across Practice Management data — staff utilisation, client profitability, WIP aging, revenue pipeline, time-entry compliance, service mix. All data is already in master (Phases 1-3 shipped); Phase 4 is pure aggregation + presentation.

**Architecture:** One aggregation service (`practiceReportsService.ts`) with six functions, one API endpoint per report, six thin UI pages with tables + optional Recharts visualisations. No new schema.

**Tech stack:** Same as Phases 1-3.

---

## Context & Pre-conditions

Master at commit `bf7324a`. Available:
- Full practice module: clients, contacts, groups, categories, work items, staff rates, time entries (with approved/billed/write-off workflow), templates, jobs, tasks, WIP invoice generation.
- `time_entries` columns include: `hours`, `applied_rate`, `line_total`, `status`, `billable`, `billed_at`, `approved_at`, `write_off_reason`, `practice_client_id`, `job_category_id`, `work_item_id`, `user_id`, `job_id`.

**No migrations needed.** All reports are SELECT aggregations.

**Worktree:** `.worktrees/prd-01-practice-phase4` on `feature/prd-01-practice-phase4` from `origin/master`.

---

## Report Specs

### 1. Staff Utilisation
Input: `{ dateFrom, dateTo, userId? }`. Output: per-user bucket `{ userId, totalHours, billableHours, nonBillableHours, billableValue, utilisationPct }`. `utilisationPct = billableHours / totalHours * 100`.

### 2. Client Profitability
Input: `{ dateFrom, dateTo, practiceClientId? }`. Output: per-client `{ practiceClientId, legalName, revenue, timeCost, hours, margin, marginPct }`. `revenue = sum(line_total WHERE status='billed')`. `timeCost = sum(hours * staff_rate)` where `staff_rate` is resolved per entry from `practice_staff_rates` (effective at entry_date). For MVP: use `applied_rate * 0.5` as a rough cost proxy (a production system would need actual staff cost rate; note this as a limitation). Simpler path: just report `revenue` and `hours` for Phase 4 and defer true cost calculation.

**Decision:** MVP reports revenue and hours only. `timeCost` and `margin` are marked "coming soon" in the UI. Service returns null for those fields.

### 3. WIP Aging
Input: `{ asOfDate? }` (defaults today). Output: per-client buckets `{ practiceClientId, legalName, total, bucket_0_7, bucket_8_14, bucket_15_30, bucket_31_plus }` based on `approved_at::DATE` vs asOfDate. Only entries with `status='approved' AND billed_at IS NULL`.

### 4. Revenue Pipeline
Input: `{ asOfDate? }`. Output: `{ totalApproved, totalInvoicedThisPeriod, forecast30d }`. `totalApproved` = sum of `line_total` from all approved+unbilled. `totalInvoicedThisPeriod` = sum of `line_total` from entries billed in last 30 days. `forecast30d` = `totalApproved * 0.8` (rough heuristic — 80% of approved WIP likely to bill in next 30 days). Simple summary; not a per-client breakdown.

### 5. Time-Entry Compliance
Input: `{ periodStart, periodEnd }`. Output: per-user `{ userId, expectedDays, submittedDays, missingDays[], status: 'compliant' | 'partial' | 'missing' }`. `expectedDays` = working days (Mon-Fri) in period. `submittedDays` = distinct `entry_date` for that user in period where `status != 'draft'`. `missingDays` = weekday dates in the period with no non-draft entry from that user.

**Scope:** Lists ALL users who have EVER submitted a time entry in that company (to know who's expected). Don't require a users table — derive from distinct `user_id` in `time_entries`.

### 6. Service Mix
Input: `{ dateFrom, dateTo }`. Output: per-category `{ jobCategoryId, name, hours, value, pct }`. Grouped by `job_category_id`, summed over `hours` and `line_total`.

---

## File Structure

### New files

**Service:**
- `src/modules/accounting/services/practice/practiceReportsService.ts` — 6 functions, ≤ 300 lines

**APIs:**
- `pages/api/accounting/practice/reports/utilisation.ts`
- `pages/api/accounting/practice/reports/profitability.ts`
- `pages/api/accounting/practice/reports/wip-aging.ts`
- `pages/api/accounting/practice/reports/revenue-pipeline.ts`
- `pages/api/accounting/practice/reports/compliance.ts`
- `pages/api/accounting/practice/reports/service-mix.ts`

**UI pages** (all under `pages/accounting/practice/reports/`):
- `utilisation.tsx`
- `profitability.tsx`
- `wip-aging.tsx` — existing href in nav already points here
- `revenue-pipeline.tsx` — new nav entry
- `compliance.tsx` — new nav entry
- `service-mix.tsx` — new nav entry

**Tests:**
- `tests/unit/services/practice/practiceReportsService.test.ts`

### Modified

- `src/components/accounting/navSections/practice.ts` — add Revenue Pipeline, Compliance, Service Mix under Reports section

---

## Task 1: `practiceReportsService.ts` (TDD)

**File:** `src/modules/accounting/services/practice/practiceReportsService.ts`
**Test:** `tests/unit/services/practice/practiceReportsService.test.ts`

### Exports

```typescript
export interface UtilisationRow {
  userId: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  billableValue: number;
  utilisationPct: number;  // 0-100
}
export async function getStaffUtilisation(
  companyId: string,
  input: { dateFrom: string; dateTo: string; userId?: string },
): Promise<UtilisationRow[]>;

export interface ProfitabilityRow {
  practiceClientId: string;
  legalName: string;
  revenue: number;
  hours: number;
  timeCost: number | null;  // null in MVP
  margin: number | null;    // null in MVP
  marginPct: number | null; // null in MVP
}
export async function getClientProfitability(
  companyId: string,
  input: { dateFrom: string; dateTo: string; practiceClientId?: string },
): Promise<ProfitabilityRow[]>;

export interface WipAgingRow {
  practiceClientId: string;
  legalName: string;
  total: number;
  bucket0to7: number;
  bucket8to14: number;
  bucket15to30: number;
  bucket31plus: number;
}
export async function getWipAging(
  companyId: string,
  input: { asOfDate?: string },
): Promise<WipAgingRow[]>;

export interface PipelineSummary {
  totalApproved: number;
  totalInvoicedLast30d: number;
  forecast30d: number;
  asOfDate: string;
}
export async function getRevenuePipeline(
  companyId: string,
  input: { asOfDate?: string },
): Promise<PipelineSummary>;

export interface ComplianceRow {
  userId: string;
  expectedDays: number;
  submittedDays: number;
  missingDays: string[];  // 'YYYY-MM-DD'
  status: 'compliant' | 'partial' | 'missing';
}
export async function getComplianceReport(
  companyId: string,
  input: { periodStart: string; periodEnd: string },
): Promise<ComplianceRow[]>;

export interface ServiceMixRow {
  jobCategoryId: string;
  name: string;
  hours: number;
  value: number;
  pct: number;  // 0-100, relative to total value
}
export async function getServiceMix(
  companyId: string,
  input: { dateFrom: string; dateTo: string },
): Promise<ServiceMixRow[]>;
```

### Key SQL snippets

**Utilisation:**
```sql
SELECT te.user_id,
       SUM(te.hours)::NUMERIC AS total_hours,
       SUM(CASE WHEN te.billable THEN te.hours ELSE 0 END)::NUMERIC AS billable_hours,
       SUM(CASE WHEN te.billable THEN COALESCE(te.line_total, 0) ELSE 0 END)::NUMERIC AS billable_value
FROM time_entries te
WHERE te.company_id = ${companyId}::UUID
  AND te.entry_date BETWEEN ${dateFrom}::DATE AND ${dateTo}::DATE
  AND te.practice_client_id IS NOT NULL
  AND (${userId}::UUID IS NULL OR te.user_id = ${userId}::UUID)
GROUP BY te.user_id
```
Compute `nonBillable` and `utilisationPct` in JS post-query.

**Profitability:**
```sql
SELECT te.practice_client_id,
       pc.legal_name,
       SUM(CASE WHEN te.status = 'billed' THEN COALESCE(te.line_total, 0) ELSE 0 END)::NUMERIC AS revenue,
       SUM(te.hours)::NUMERIC AS hours
FROM time_entries te
JOIN practice_clients pc ON pc.id = te.practice_client_id
WHERE te.company_id = ${companyId}::UUID
  AND te.entry_date BETWEEN ${dateFrom}::DATE AND ${dateTo}::DATE
  AND (${clientId}::UUID IS NULL OR te.practice_client_id = ${clientId}::UUID)
GROUP BY te.practice_client_id, pc.legal_name
ORDER BY revenue DESC
```

**WIP aging:**
```sql
SELECT te.practice_client_id,
       pc.legal_name,
       SUM(te.line_total)::NUMERIC AS total,
       SUM(CASE WHEN ${asOfDate}::DATE - te.approved_at::DATE BETWEEN 0 AND 7 THEN te.line_total ELSE 0 END)::NUMERIC AS bucket_0_7,
       SUM(CASE WHEN ${asOfDate}::DATE - te.approved_at::DATE BETWEEN 8 AND 14 THEN te.line_total ELSE 0 END)::NUMERIC AS bucket_8_14,
       SUM(CASE WHEN ${asOfDate}::DATE - te.approved_at::DATE BETWEEN 15 AND 30 THEN te.line_total ELSE 0 END)::NUMERIC AS bucket_15_30,
       SUM(CASE WHEN ${asOfDate}::DATE - te.approved_at::DATE > 30 THEN te.line_total ELSE 0 END)::NUMERIC AS bucket_31_plus
FROM time_entries te
JOIN practice_clients pc ON pc.id = te.practice_client_id
WHERE te.company_id = ${companyId}::UUID
  AND te.status = 'approved'
  AND te.billed_at IS NULL
  AND te.billable = true
  AND te.line_total IS NOT NULL
GROUP BY te.practice_client_id, pc.legal_name
ORDER BY total DESC
```

**Revenue pipeline:**
Three scalar queries (totalApproved, totalInvoicedLast30d). Forecast computed in JS.

**Compliance:**
1. Query distinct users: `SELECT DISTINCT user_id FROM time_entries WHERE company_id=? AND practice_client_id IS NOT NULL`.
2. For each user: query `SELECT DISTINCT entry_date FROM time_entries WHERE user_id=? AND entry_date BETWEEN ? AND ? AND status != 'draft'`.
3. Compute weekday list in JS; diff against submitted; classify status.

Keep the per-user loop — for practice sizes this is fine. If this becomes slow, revisit.

**Service mix:**
```sql
SELECT te.job_category_id,
       pjc.name,
       SUM(te.hours)::NUMERIC AS hours,
       SUM(COALESCE(te.line_total, 0))::NUMERIC AS value
FROM time_entries te
JOIN practice_job_categories pjc ON pjc.id = te.job_category_id
WHERE te.company_id = ${companyId}::UUID
  AND te.entry_date BETWEEN ${dateFrom}::DATE AND ${dateTo}::DATE
  AND te.practice_client_id IS NOT NULL
GROUP BY te.job_category_id, pjc.name
ORDER BY value DESC
```
Compute `pct` in JS = `value / totalValue * 100`.

### Tests (≥10 required)

Test each function at minimum with a happy path and one edge case:

1. `getStaffUtilisation returns mapped rows with utilisationPct`
2. `getStaffUtilisation returns zero utilisationPct when totalHours is 0 (no divide-by-zero)`
3. `getClientProfitability returns mapped rows ordered by revenue desc`
4. `getWipAging returns buckets correctly`
5. `getRevenuePipeline returns scalar summary with forecast`
6. `getComplianceReport classifies user as compliant when all weekdays submitted`
7. `getComplianceReport classifies user as missing when no submissions`
8. `getComplianceReport classifies user as partial when some weekdays missing`
9. `getServiceMix returns mapped rows with pct normalised to 100`
10. `getServiceMix pct rounds to 2 decimals`

- [ ] **Step 1:** Write failing tests
- [ ] **Step 2:** Run tests (fail)
- [ ] **Step 3:** Implement service
- [ ] **Step 4:** Tests pass
- [ ] **Step 5:** `bunx tsc --noEmit` clean
- [ ] **Step 6:** Commit `feat(practice): practiceReportsService — 6 aggregation functions`

---

## Task 2: 6 API routes

All read-only — just `withAuth(withErrorHandler(handler))`, no write middleware.

Each route parses query params, calls the matching service function, returns `apiResponse.success(res, result)`.

Example for `utilisation.ts`:
```typescript
async function handler(req, res) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const { dateFrom, dateTo, userId } = req.query;
  if (!dateFrom || !dateTo) return apiResponse.badRequest(res, 'dateFrom and dateTo are required');
  const rows = await getStaffUtilisation(companyId, {
    dateFrom: dateFrom as string,
    dateTo: dateTo as string,
    userId: userId as string | undefined,
  });
  return apiResponse.success(res, rows);
}
export default withAuth(withErrorHandler(handler));
```

All 6 routes ≤ 40 lines each.

- [ ] **Step 1:** Create all 6 route files
- [ ] **Step 2:** `bunx tsc --noEmit` clean
- [ ] **Step 3:** Commit `feat(practice): 6 report API routes`

---

## Task 3: 6 UI pages + nav update

Each page:
- `AppLayout`
- Period picker (date range) at top — except `wip-aging.tsx` / `revenue-pipeline.tsx` which take `asOfDate` only
- Optional filter (staff, client)
- Table of results
- Optional chart (use existing Recharts integration if present — check `src/components/` for prior art; if not, table-only is fine for this phase)

File size ceiling: 220 lines each.

Specific tables per page:

**utilisation.tsx:** user | total hrs | billable hrs | non-billable hrs | value | utilisation %

**profitability.tsx:** client | hours | revenue | (margin fields "coming soon" — show as "—")

**wip-aging.tsx:** client | 0-7d | 8-14d | 15-30d | 31d+ | total

**revenue-pipeline.tsx:** summary cards (totalApproved, totalInvoicedLast30d, forecast30d)

**compliance.tsx:** user | expected | submitted | missing days (first 3 listed, "+N more" if longer) | status badge

**service-mix.tsx:** category | hours | value | %

### Nav update

`src/components/accounting/navSections/practice.ts` — add 3 new items under Reports:
```typescript
{ label: 'Revenue Pipeline', href: '/accounting/practice/reports/revenue-pipeline' },
{ label: 'Compliance', href: '/accounting/practice/reports/compliance' },
{ label: 'Service Mix', href: '/accounting/practice/reports/service-mix' },
```

- [ ] Create all 6 pages + nav change
- [ ] `bunx tsc --noEmit` clean
- [ ] Commit `feat(practice): 6 report pages + nav additions`

---

## Task 4: Self-review + finish

- [ ] File-size audit (every new file ≤ 300)
- [ ] `bun run test:unit` — all Phase 4 tests green; practice count grows to ~137 (127 + ~10)
- [ ] `bunx tsc --noEmit` clean (ignoring pre-existing decimal.js)
- [ ] `grep -rn console\.log src/modules/accounting/services/practice/practiceReportsService.ts pages/accounting/practice/reports pages/api/accounting/practice/reports` — none
- [ ] Use `superpowers:finishing-a-development-branch`

---

## Self-Review (plan-author checklist)

**Spec coverage:**

| PRD requirement | Task |
|---|---|
| Staff utilisation | Task 1 + 2 + 3 utilisation |
| Client profitability | Task 1 + 2 + 3 profitability (margin fields stubbed) |
| WIP aging | Task 1 + 2 + 3 wip-aging |
| Revenue pipeline (from open WIP) | Task 1 + 2 + 3 revenue-pipeline |
| Compliance (who hasn't submitted) | Task 1 + 2 + 3 compliance |
| Service mix | Task 1 + 2 + 3 service-mix |
| All filterable by period/staff/client/category | Period filter on all; staff filter on utilisation; client filter on profitability. Category filter on service-mix is intrinsic. |

**Known deferrals:**

1. **True staff cost rate → margin calculation**: requires a staff-cost-rate table (different from the billing rate). MVP returns `null` for `timeCost` and `margin`; UI shows "—".
2. **Period presets** (this month / last month / YTD / custom): Phase 4 uses a bare date range picker. Presets are a small UX enhancement.
3. **CSV export**: all reports are view-only in Phase 4. CSV/PDF export deferred.
4. **Scheduled email reports**: outbound notifications remain out of scope (deferred to future phase).
5. **Charts**: table-first; charts added opportunistically if existing Recharts integration makes it trivial. Otherwise deferred.

All placeholders explicit. All types match between service signatures and UI consumption.

---

## Execution notes

- **No new migrations.**
- **Worktree:** `.worktrees/prd-01-practice-phase4` on `feature/prd-01-practice-phase4` from `origin/master`.
- **Expected commits:** 4 (service, APIs, pages+nav, potentially a polish commit).
- **Expected tests:** ~10 new practice tests.
