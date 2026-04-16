# Plan 8 — IFRS Compliance Layer & PIS Calculator

**Date:** 2026-04-16
**Status:** Ready for implementation
**Depends on:** Plan 1 (afsTypes), Plan 2 (Note Engine / AfsDocument DB)
**Spec ref:** `docs/superpowers/specs/2026-04-16-financial-reporting-afs-design.md` §8

---

## Overview

Plan 8 adds the real-time IFRS compliance intelligence layer to the AFS engine. It introduces four services and four API routes that together provide: automatic Public Interest Score (PIS) computation, structural/mathematical/disclosure-quality checks against a live document, a CIPC filing guide, and a compliance alerts system.

The existing `compliance-alerts.ts` route (statutory document expiry checks via `statutoryDocService`) is extended — not replaced. New AFS-specific alert types are added alongside it.

---

## Prerequisites

| Item | Path | Notes |
|------|------|-------|
| Types | `@/modules/accounting/services/afs/afsTypes.ts` | Plan 1 output |
| DB tables | `afs_documents`, `afs_sections`, `note_templates` | Plan 1 migrations |
| GL service | `@/modules/accounting/services/reports/balanceSheetService.ts` | Read only |
| Auth pattern | `@/lib/auth` (`withCompany`, `CompanyApiRequest`, `withWriteAccess`) | Existing |
| API helpers | `@/lib/apiResponse.ts` | Existing |
| Logger | `@/lib/logger.ts` | Existing |
| DB client | `@/lib/neon.ts` | Existing |
| Existing alerts | `pages/api/accounting/compliance-alerts.ts` | Extend, not replace |

---

## Deliverables

### Services (4)

```
src/modules/accounting/services/afs/
  pisCalculatorService.ts
  complianceCheckerService.ts
  cipcFilingGuideService.ts
  complianceAlertService.ts
```

### API Routes (4)

```
pages/api/accounting/afs/[documentId]/compliance.ts   GET
pages/api/accounting/afs/pis-score.ts                 GET
pages/api/accounting/afs/[documentId]/cipc-guide.ts   GET
pages/api/accounting/compliance-alerts.ts              GET + POST (extend existing)
```

### Tests (3)

```
tests/unit/services/afs/
  pisCalculatorService.test.ts
  complianceCheckerService.test.ts
  cipcFilingGuideService.test.ts
```

---

## Types

All types live in `@/modules/accounting/services/afs/afsTypes.ts` (Plan 1). Add the following exports there during this plan.

```typescript
// ── PIS ─────────────────────────────────────────────────────────────────────

export interface PisScore {
  turnoverPoints: number;       // GL revenue total ÷ 1_000_000, rounded to 2 dp
  employeePoints: number;       // headcount from company settings
  shareholderPoints: number;    // shareholder count from company settings
  liabilityPoints: number;      // third-party liabilities ÷ 1_000_000, rounded to 2 dp
  total: number;                // sum of all four
  requiredFramework: 'ifrs_smes' | 'full_ifrs';
  requiredAudit: 'voluntary' | 'independent_review' | 'mandatory_audit';
  requiredCipcFiling: 'fas_only' | 'afs_required';
  calculatedAt: string;         // ISO timestamp
}

// ── Compliance checker ───────────────────────────────────────────────────────

export type CheckSeverity = 'blocker' | 'warning' | 'info';

export interface ComplianceIssue {
  checkId: string;              // e.g. 'structural.directors_report_missing'
  category: 'structural' | 'mathematical' | 'disclosure_quality';
  severity: CheckSeverity;
  message: string;
  sectionType?: string;         // SectionType from Plan 1 — which section to jump to
  detail?: string;              // optional extra context for the UI tooltip
}

export interface ComplianceResult {
  score: number;                // 0–100 integer
  passedCount: number;
  warningCount: number;
  blockerCount: number;
  issues: ComplianceIssue[];
  checkedAt: string;            // ISO timestamp
}

// ── CIPC Guide ───────────────────────────────────────────────────────────────

export interface CipcFilingGuide {
  companyName: string;
  registrationNumber: string;
  yearEnd: string;              // ISO date (YYYY-MM-DD)
  filingDeadline: string;       // yearEnd + 6 months (ISO date)
  pisScore: number;
  requiredFilings: string[];    // human-readable list, e.g. ['AFS', 'Independent Review Report']
  documentsReady: Array<{
    label: string;
    ready: boolean;
    detail?: string;
  }>;
  nextStep: string;             // single most important action the accountant must take
}

// ── Compliance Alerts ────────────────────────────────────────────────────────

export type AfsAlertType =
  | 'pis_threshold_100'
  | 'pis_threshold_350'
  | 'afs_filing_deadline_30'
  | 'afs_filing_deadline_14'
  | 'afs_filing_deadline_7'
  | 'cipc_overdue'
  | 'bank_unreconciled_30d';

export interface AfsComplianceAlert {
  id: string;
  companyId: string;
  alertType: AfsAlertType;
  message: string;
  detail?: string;
  firedAt: string;             // ISO timestamp
  dismissedAt: string | null;
  dismissedBy: string | null;
}
```

---

## Service 1 — `pisCalculatorService.ts`

**Path:** `src/modules/accounting/services/afs/pisCalculatorService.ts`
**Max lines:** 220

### Responsibility

Query live GL for revenue and third-party liabilities. Read employee count and shareholder count from company settings. Compute PIS total. Derive the required framework, audit level, and CIPC filing obligation.

### PIS Thresholds (Companies Act)

| PIS total | Framework | Audit requirement | CIPC filing |
|-----------|-----------|-------------------|-------------|
| < 100 (all shareholders = directors) | `ifrs_smes` | `voluntary` | `fas_only` |
| < 100 (external shareholders present) | `ifrs_smes` | `independent_review` | `afs_required` |
| 100–349 | `ifrs_smes` | `independent_review` | `afs_required` |
| ≥ 350 | `full_ifrs` | `mandatory_audit` | `afs_required` |

> Implementation simplification: treat all entities with PIS < 100 as having external shareholders (conservative default) unless `all_shareholders_are_directors = true` is set in company settings. This avoids a complex shareholder registry query.

### GL Queries

**Revenue (turnover points):**
```sql
SELECT COALESCE(SUM(je.credit - je.debit), 0) AS total_revenue
FROM journal_entries je
JOIN accounts a ON a.id = je.account_id
WHERE je.company_id = $1
  AND a.account_type = 'revenue'
  AND je.entry_date >= $2   -- fiscal year start
  AND je.entry_date <= $3   -- fiscal year end (or today if ongoing)
```

**Third-party liabilities (liability points):**
```sql
SELECT COALESCE(SUM(je.credit - je.debit), 0) AS total_liabilities
FROM journal_entries je
JOIN accounts a ON a.id = je.account_id
WHERE je.company_id = $1
  AND a.account_type = 'liability'
  AND a.account_subtype NOT IN ('equity_loan', 'shareholder_loan')
  AND je.entry_date <= $2   -- as-at date
```

**Company settings:**
```sql
SELECT
  COALESCE((settings->>'employee_count')::int, 0)      AS employee_count,
  COALESCE((settings->>'shareholder_count')::int, 0)   AS shareholder_count,
  COALESCE((settings->>'all_shareholders_are_directors')::boolean, false) AS all_directors
FROM companies
WHERE id = $1::uuid
```

### Exported functions

```typescript
export async function computePisScore(
  companyId: string,
  fiscalYearStart: string,  // ISO date
  fiscalYearEnd: string     // ISO date
): Promise<PisScore>

// Convenience: reads fiscal year from afs_documents for a given documentId
export async function computePisScoreForDocument(
  companyId: string,
  documentId: string
): Promise<PisScore>
```

### Internal helpers

```typescript
function deriveRequirements(total: number, allDirectors: boolean): {
  requiredFramework: PisScore['requiredFramework'];
  requiredAudit: PisScore['requiredAudit'];
  requiredCipcFiling: PisScore['requiredCipcFiling'];
}
```

---

## Service 2 — `complianceCheckerService.ts`

**Path:** `src/modules/accounting/services/afs/complianceCheckerService.ts`
**Max lines:** 300

### Responsibility

Accept a `documentId` + `companyId`. Fetch all `AfsSection` records and `NoteTemplate` records. Run all three check categories in parallel. Compute a composite score. Return a `ComplianceResult`.

### Score calculation

```
score = Math.round((passedChecks / totalChecks) * 100)
```

A blocker reduces `passedChecks` by the full weight of that check (weight 1 each). Warnings reduce by 0.5. Info issues do not reduce the score.

### Structural Checks (category: `'structural'`)

| checkId | Severity | Description |
|---------|----------|-------------|
| `structural.mandatory_notes_present` | `blocker` | Every `NoteTemplate` record where `is_mandatory = true` AND `framework` matches the document's `reporting_framework` must have a corresponding `AfsSection` for this `document_id`. |
| `structural.no_mandatory_note_pending` | `blocker` | No mandatory note's `AfsSection.status` is `'pending'` — must be at least `'auto_generated'`. |
| `structural.directors_report_present` | `blocker` | An `AfsSection` with `section_type = 'directors_report'` exists for the document. |
| `structural.auditors_remuneration_present` | `blocker` | An `AfsSection` with `section_type = 'note_24'` exists — required regardless of framework. |
| `structural.comparative_figures_present` | `warning` | For every statement section (`balance_sheet`, `income_statement`, `cash_flow`, `changes_in_equity`), `content` JSONB contains a key `comparativePeriod` or at least one table with a column header matching prior year. Check: `section.content?.comparativePeriod != null`. |

### Mathematical Checks (category: `'mathematical'`)

All figures pulled from `AfsSection.data_snapshot` JSONB — do **not** re-query the GL.

| checkId | Severity | Description |
|---------|----------|-------------|
| `mathematical.balance_sheet_balances` | `blocker` | `abs(totalAssets - (totalLiabilities + totalEquity)) <= 0.01`. Read from `balance_sheet` section's `data_snapshot.totals`. |
| `mathematical.cash_flow_closing_balance` | `blocker` | `abs(cashFlowClosingBalance - balanceSheetCashBalance) <= 0.01`. Compare `cash_flow.data_snapshot.closingBalance` vs `balance_sheet.data_snapshot.cashAccountBalance`. |
| `mathematical.equity_closing_balance` | `blocker` | `abs(changesInEquityClosing - balanceSheetTotalEquity) <= 0.01`. Compare `changes_in_equity.data_snapshot.closingTotalEquity` vs `balance_sheet.data_snapshot.totals.totalEquity`. |
| `mathematical.income_tax_effective_rate` | `warning` | From `note_17.data_snapshot`: `effectiveRate = taxExpense / profitBeforeTax`. Flag if `effectiveRate > 0.35` or `effectiveRate < 0` (but not if `profitBeforeTax === 0` — skip the check). Provide `detail` with the computed rate. |

> For documents where `changes_in_equity` or `cash_flow` sections do not yet exist (status `pending`), skip those checks and log them as `info` with message "Section not yet generated — check deferred."

### Disclosure Quality Checks (category: `'disclosure_quality'`)

| checkId | Severity | Description |
|---------|----------|-------------|
| `disclosure.note1_covers_material_types` | `warning` | Fetch distinct `account_type` values in `data_snapshot` of the `balance_sheet` section. For each of `revenue`, `ppe`, `inventory` that appear: verify `note_1.content.blocks` contains a block whose `text` includes the keyword (case-insensitive). |
| `disclosure.note23_covers_directors` | `warning` | Extract director names from `directors_report.content`. Verify each name appears (case-insensitive) in `note_23.content.blocks` text. If `note_23` does not exist, severity is `blocker`. |
| `disclosure.note26_events_declared` | `warning` | `note_26.content` must exist AND (`content.blocks` has at least one non-empty block OR `overrides.suppressReason === 'nil'`). |
| `disclosure.note27_going_concern` | `warning` | Compute current ratio from `balance_sheet.data_snapshot`. If `currentRatio < 1.0` OR `netLoss` in `income_statement.data_snapshot` is positive (loss), then `note_27` section must exist and must not be `pending`. If the condition is not met, this check passes automatically. |

### Exported functions

```typescript
export async function runComplianceCheck(
  companyId: string,
  documentId: string
): Promise<ComplianceResult>
```

### Internal helpers

```typescript
async function fetchDocumentSections(
  companyId: string,
  documentId: string
): Promise<{ doc: AfsDocumentRow; sections: AfsSectionRow[]; templates: NoteTemplateRow[] }>

function runStructuralChecks(
  doc: AfsDocumentRow,
  sections: AfsSectionRow[],
  templates: NoteTemplateRow[]
): ComplianceIssue[]

function runMathematicalChecks(
  sections: AfsSectionRow[]
): ComplianceIssue[]

function runDisclosureQualityChecks(
  sections: AfsSectionRow[]
): ComplianceIssue[]

function computeScore(issues: ComplianceIssue[], totalChecks: number): number
```

---

## Service 3 — `cipcFilingGuideService.ts`

**Path:** `src/modules/accounting/services/afs/cipcFilingGuideService.ts`
**Max lines:** 180

### Responsibility

Given a `documentId` and `companyId`, fetch company details and the document's PIS score, then produce a structured filing checklist.

### Filing deadline

```typescript
const filingDeadline = addMonths(parseISO(yearEnd), 6); // date-fns
```

### Required filings by PIS + audit level

| Condition | Required filings |
|-----------|-----------------|
| `requiredCipcFiling === 'fas_only'` | `['Financial Accountability Supplement (FAS)']` |
| `requiredAudit === 'independent_review'` | `['Annual Financial Statements (AFS)', 'Independent Reviewer\'s Report']` |
| `requiredAudit === 'mandatory_audit'` | `['Annual Financial Statements (AFS)', 'Auditor\'s Report', 'XBRL/iXBRL filing']` |

### Documents ready checklist items

| Label | Ready condition |
|-------|----------------|
| `AFS signed off` | `afs_documents.status === 'signed_off'` OR `'filed'` |
| `All sections reviewed` | All mandatory `AfsSection.status` >= `'reviewed'` |
| `Reviewer/Auditor report uploaded` | An `AfsSection` with `section_type = 'auditor_report'` exists and is not `pending` |
| `CIPC annual return submitted` | Boolean flag `companies.cipc_annual_return_submitted` (if column exists; else `false`) |

### Exported functions

```typescript
export async function generateCipcFilingGuide(
  companyId: string,
  documentId: string
): Promise<CipcFilingGuide>
```

---

## Service 4 — `complianceAlertService.ts`

**Path:** `src/modules/accounting/services/afs/complianceAlertService.ts`
**Max lines:** 250

### Responsibility

Detect and fire AFS-specific compliance alerts. Stored in the existing `compliance_alerts` table. The existing `statutoryDocService.checkComplianceAlerts()` handles document expiry alerts — this service handles AFS/PIS alerts only. They are combined at the API layer.

### `compliance_alerts` table schema (existing)

The plan assumes the table already has at minimum:

```sql
id            UUID PRIMARY KEY DEFAULT gen_random_uuid()
company_id    UUID NOT NULL
alert_type    TEXT NOT NULL
message       TEXT NOT NULL
detail        TEXT
fired_at      TIMESTAMPTZ NOT NULL DEFAULT now()
dismissed_at  TIMESTAMPTZ
dismissed_by  UUID REFERENCES users(id)
```

If it does not exist, add migration `292-create-compliance-alerts.sql` with `CREATE TABLE IF NOT EXISTS compliance_alerts (...)`.

### Alert logic

```typescript
export async function detectAndFireAfsAlerts(companyId: string): Promise<void>
```

Runs all detectors below. For each, check whether an un-dismissed alert of that type already exists today (to avoid duplicates). If not, insert.

**Detector 1 — PIS threshold crossings**

```sql
-- Has PIS crossed 100 since last check?
SELECT pis_score FROM afs_documents
WHERE company_id = $1
ORDER BY created_at DESC LIMIT 2
```

If the most recent PIS >= 100 AND the prior one < 100: fire `pis_threshold_100`.
If the most recent PIS >= 350 AND the prior one < 350: fire `pis_threshold_350`.

**Detector 2 — Filing deadline approaching**

```sql
SELECT id, fiscal_year, filing_deadline
FROM afs_documents
WHERE company_id = $1
  AND status NOT IN ('signed_off', 'filed')
  AND filing_deadline IS NOT NULL
```

For each: compute `daysUntil = differenceInDays(filingDeadline, today)`.
- `daysUntil <= 30`: fire `afs_filing_deadline_30`
- `daysUntil <= 14`: fire `afs_filing_deadline_14`
- `daysUntil <= 7`: fire `afs_filing_deadline_7`

**Detector 3 — CIPC overdue**

```sql
SELECT cipc_annual_return_due
FROM companies
WHERE id = $1::uuid
```

If `cipc_annual_return_due` < today AND column exists: fire `cipc_overdue`.

**Detector 4 — Bank unreconciled 30+ days**

```sql
SELECT id FROM bank_accounts
WHERE company_id = $1::uuid
  AND (last_reconciled_at IS NULL OR last_reconciled_at < now() - interval '30 days')
LIMIT 1
```

If any row returned: fire `bank_unreconciled_30d`.

### Dismiss function

```typescript
export async function dismissAfsAlert(
  companyId: string,
  alertId: string,
  userId: string
): Promise<void>
```

```sql
UPDATE compliance_alerts
SET dismissed_at = now(), dismissed_by = $3::uuid
WHERE id = $2::uuid AND company_id = $1::uuid
```

### Fetch function

```typescript
export async function getActiveAfsAlerts(
  companyId: string
): Promise<AfsComplianceAlert[]>
```

```sql
SELECT id, company_id, alert_type, message, detail, fired_at, dismissed_at, dismissed_by
FROM compliance_alerts
WHERE company_id = $1::uuid
  AND dismissed_at IS NULL
ORDER BY fired_at DESC
```

---

## API Routes

### `GET /api/accounting/afs/[documentId]/compliance`

**File:** `pages/api/accounting/afs/[documentId]/compliance.ts`
**Max lines:** 80

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { runComplianceCheck } from '@/modules/accounting/services/afs/complianceCheckerService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { documentId } = req.query;

  if (typeof documentId !== 'string') {
    return apiResponse.badRequest(res, 'documentId is required');
  }

  const result = await runComplianceCheck(companyId, documentId);
  return apiResponse.success(res, result);
}

export default withCompany(withErrorHandler(handler as any));
```

### `GET /api/accounting/afs/pis-score`

**File:** `pages/api/accounting/afs/pis-score.ts`
**Max lines:** 80

Query params: `fiscalYearStart` (ISO date), `fiscalYearEnd` (ISO date). Both required.

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { computePisScore } from '@/modules/accounting/services/afs/pisCalculatorService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { fiscalYearStart, fiscalYearEnd } = req.query;

  if (typeof fiscalYearStart !== 'string' || typeof fiscalYearEnd !== 'string') {
    return apiResponse.badRequest(res, 'fiscalYearStart and fiscalYearEnd are required');
  }

  const pisScore = await computePisScore(companyId, fiscalYearStart, fiscalYearEnd);
  return apiResponse.success(res, pisScore);
}

export default withCompany(withErrorHandler(handler as any));
```

### `GET /api/accounting/afs/[documentId]/cipc-guide`

**File:** `pages/api/accounting/afs/[documentId]/cipc-guide.ts`
**Max lines:** 70

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { generateCipcFilingGuide } from '@/modules/accounting/services/afs/cipcFilingGuideService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const { documentId } = req.query;

  if (typeof documentId !== 'string') {
    return apiResponse.badRequest(res, 'documentId is required');
  }

  const guide = await generateCipcFilingGuide(companyId, documentId);
  return apiResponse.success(res, guide);
}

export default withCompany(withErrorHandler(handler as any));
```

### `GET + POST /api/accounting/compliance-alerts` (extend existing)

**File:** `pages/api/accounting/compliance-alerts.ts` — **extend, do not replace**

The existing handler only supports `GET` and delegates to `statutoryDocService.checkComplianceAlerts()`. Extend it to:

1. Also call `getActiveAfsAlerts(companyId)` and merge into the response.
2. Handle `POST` for dismissing an alert (`{ alertId: string }`).

```typescript
// GET: merge statutory alerts + AFS alerts
const [statutoryAlerts, afsAlerts] = await Promise.all([
  checkComplianceAlerts(companyId),
  getActiveAfsAlerts(companyId),
]);
return apiResponse.success(res, { alerts: [...statutoryAlerts, ...afsAlerts] });

// POST body: { alertId: string }
// Calls: dismissAfsAlert(companyId, alertId, userId)
```

Import the two new functions from `complianceAlertService`. The `userId` comes from `(req as CompanyApiRequest & { user: { id: string } }).user.id`.

The `withWriteAccess` guard stays on `POST` only — wrap using a method branch rather than wrapping the whole handler again.

---

## Tests

### Pattern (from `balanceSheetService.test.ts`)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
type SqlFn = ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as SqlFn;

beforeEach(() => { vi.clearAllMocks(); });
```

### `pisCalculatorService.test.ts`

**File:** `tests/unit/services/afs/pisCalculatorService.test.ts`

Test cases:

1. **Computes PIS correctly** — mock sql: revenue = 5_000_000 (5 pts), liabilities = 2_000_000 (2 pts), employee_count = 30, shareholder_count = 5. Expected total = 42. Expected `requiredFramework: 'ifrs_smes'`, `requiredAudit: 'independent_review'`, `requiredCipcFiling: 'afs_required'`.

2. **PIS ≥ 350 triggers full IFRS** — mock revenue = 200_000_000, liabilities = 150_000_000, employees = 100, shareholders = 10. Total = 460. Expected `requiredFramework: 'full_ifrs'`, `requiredAudit: 'mandatory_audit'`.

3. **PIS < 100 with all_shareholders_are_directors = true** — Expected `requiredAudit: 'voluntary'`, `requiredCipcFiling: 'fas_only'`.

4. **Rounds GL figures to 2 dp** — revenue = 1_500_500 → turnoverPoints = 1.5 (rounded).

5. **Returns zero points when GL is empty** — all sql calls return `[{ total_revenue: 0, total_liabilities: 0, employee_count: 0, shareholder_count: 0 }]`. Total = 0.

### `complianceCheckerService.test.ts`

**File:** `tests/unit/services/afs/complianceCheckerService.test.ts`

Test cases:

1. **Returns score 100 when all checks pass** — mock complete document with all mandatory sections at `'reviewed'`, balanced balance sheet, equity closing = balance sheet equity, note_26 with content, note_27 not triggered.

2. **Blocker: balance sheet does not balance** — `totalAssets = 100_000`, `totalLiabilities = 60_000`, `totalEquity = 30_000` (gap = 10_000). Expect issue `mathematical.balance_sheet_balances` with severity `blocker`. Score < 100.

3. **Blocker: mandatory note missing** — mock `note_templates` with 3 mandatory notes but `afs_sections` only has 2. Expect `structural.mandatory_notes_present` blocker.

4. **Warning: comparative figures absent** — `balance_sheet.content` has no `comparativePeriod` key. Expect `structural.comparative_figures_present` warning.

5. **Disclosure: note_26 missing content and no suppressReason** — Expect `disclosure.note26_events_declared` warning.

6. **Going concern triggered correctly** — `balance_sheet.data_snapshot.currentRatio = 0.8`. `note_27` section is `pending`. Expect `disclosure.note27_going_concern` warning.

7. **Income tax rate flag** — `note_17.data_snapshot.effectiveRate = 0.40`. Expect `mathematical.income_tax_effective_rate` warning with detail containing "40%".

8. **Skips cash flow check when section is pending** — `cash_flow` section has `status: 'pending'`. Expect `info` issue "Section not yet generated" instead of blocker.

### `cipcFilingGuideService.test.ts`

**File:** `tests/unit/services/afs/cipcFilingGuideService.test.ts`

Test cases:

1. **Filing deadline is exactly 6 months after year-end** — `yearEnd = '2025-02-28'`, expected `filingDeadline = '2025-08-28'`.

2. **Required filings for mandatory_audit** — PIS score mocked at 400 → `requiredFilings` includes `'Auditor\'s Report'` and `'XBRL/iXBRL filing'`.

3. **Required filings for independent_review** — PIS score mocked at 150 → `requiredFilings` includes `'Independent Reviewer\'s Report'` but not `'XBRL/iXBRL filing'`.

4. **AFS signed off shows ready** — document status `'signed_off'` → `documentsReady.find(d => d.label === 'AFS signed off').ready === true`.

5. **nextStep reflects outstanding item** — If AFS not signed off: `nextStep` contains "sign off" (case-insensitive).

---

## DB Migration (if needed)

**File:** `scripts/migrations/sql/292-create-compliance-alerts.sql`

Only create if the `compliance_alerts` table does not yet exist. Inspect the DB first with:

```bash
bun run tsx scripts/migrations/check-table.ts compliance_alerts
```

If it does not exist:

```sql
CREATE TABLE IF NOT EXISTS compliance_alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alert_type    TEXT NOT NULL,
  message       TEXT NOT NULL,
  detail        TEXT,
  fired_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_at  TIMESTAMPTZ,
  dismissed_by  UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_compliance_alerts_company_id
  ON compliance_alerts (company_id);

CREATE INDEX IF NOT EXISTS idx_compliance_alerts_undismissed
  ON compliance_alerts (company_id, dismissed_at)
  WHERE dismissed_at IS NULL;
```

---

## Implementation Order

1. **Add types** to `afsTypes.ts` (15 min)
2. **DB migration** if table absent (10 min)
3. **`pisCalculatorService.ts`** — GL queries + threshold logic (45 min)
4. **`pisCalculatorService.test.ts`** — 5 tests, TDD first (30 min)
5. **`complianceCheckerService.ts`** — all 12 checks (90 min)
6. **`complianceCheckerService.test.ts`** — 8 tests, TDD first (60 min)
7. **`cipcFilingGuideService.ts`** — guide builder (40 min)
8. **`cipcFilingGuideService.test.ts`** — 5 tests, TDD first (30 min)
9. **`complianceAlertService.ts`** — 4 detectors + dismiss + fetch (50 min)
10. **API routes** — 4 routes (45 min)
11. **Extend `compliance-alerts.ts`** — merge + POST dismiss (20 min)
12. **`bun run test:unit`** — all tests green (15 min)
13. **`bunx tsc --noEmit`** — no type errors (10 min)

**Estimated total:** ~7.5 hours

---

## Patterns Checklist

Every file must pass this before PR:

- [ ] `sql` tagged template only — zero string concatenation in queries
- [ ] `company_id` in every DB query that touches tenant data
- [ ] API routes wrapped: `withCompany(withErrorHandler(handler as any))`
- [ ] Responses via `apiResponse.success()` / `.badRequest()` / `.notFound()`
- [ ] `log` from `@/lib/logger` — no `console.log`
- [ ] No empty `catch` blocks
- [ ] 100% TypeScript — no implicit `any`
- [ ] File length ≤ 300 lines
- [ ] All `CREATE TABLE` / `CREATE INDEX` in migrations use `IF NOT EXISTS`
- [ ] Tests mock both `@/lib/neon` and `@/lib/logger`
- [ ] `vi.clearAllMocks()` in `beforeEach`

---

## Edge Cases to Handle

| Scenario | Handling |
|----------|----------|
| Document not found or wrong tenant | Return `apiResponse.notFound(res, 'AFS document', documentId)` |
| `afs_sections` empty (no generation yet) | Structural checks all fail; mathematical checks return `info` deferral |
| `note_17` has `profitBeforeTax === 0` | Skip effective rate check entirely (avoid division by zero) |
| `currentRatio` field absent from `data_snapshot` | Skip going concern trigger; log `warn` |
| `companies.cipc_annual_return_due` column absent | Catch column-not-exist error in detector 3; treat as skip |
| Alert already fired today (duplicate guard) | `INSERT ... ON CONFLICT DO NOTHING` with a partial unique index on `(company_id, alert_type)` WHERE `dismissed_at IS NULL` — or a pre-insert SELECT check |
| PIS detector: only one document (no prior) | Skip threshold-crossing check — can't compare to prior |
