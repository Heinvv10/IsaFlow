# Plan 8 — IFRS Compliance Layer & PIS Calculator

**Date:** 2026-04-16
**Status:** Ready for implementation (revised — SQL patterns corrected)
**Depends on:** Plan 1 (afsTypes, afs_documents, afs_sections, note_templates), Plan 2 (Note Engine)
**Spec ref:** `docs/superpowers/specs/2026-04-16-financial-reporting-afs-design.md` §8

---

## Overview

Plan 8 adds the real-time IFRS compliance intelligence layer to the AFS engine. It introduces four services and four API routes that together provide: automatic Public Interest Score (PIS) computation, structural/mathematical/disclosure-quality checks against a live document, a CIPC filing guide, and a compliance alerts system.

The existing `compliance-alerts.ts` route (statutory document expiry checks via `statutoryDocService`) is extended — not replaced. New AFS-specific alert types are added alongside it.

---

## Actual DB Schema Reference

This section documents the REAL table structures used by this plan. All SQL in the plan is verified against these schemas.

### GL Tables (3-table join pattern)

```
gl_journal_entries:  id, company_id, entry_date, status ('draft'|'posted'|'reversed'), ...
gl_journal_lines:   id, company_id, journal_entry_id, gl_account_id, debit, credit, ...
gl_accounts:        id, company_id, account_code, account_name, account_type, account_subtype, ...
```

**Every financial query MUST use the 3-table join:**
```sql
FROM gl_journal_lines jl
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
JOIN gl_accounts ga ON ga.id = jl.gl_account_id
WHERE je.company_id = ${companyId}::UUID
  AND jl.company_id = ${companyId}::UUID
  AND ga.company_id = ${companyId}::UUID
  AND je.status = 'posted'
```

### companies table (from 236_multi_entity.sql)

```
id, name, trading_name, registration_number, vat_number, tax_number,
address_line1..postal_code, country, phone, email, website, logo_url,
bank_name, bank_account_number, bank_branch_code, bank_account_type,
financial_year_start (INTEGER, month 1-12), vat_period, default_currency,
is_active, created_at, updated_at
```

**Columns that DO NOT exist** (and will NOT be added in this plan):
- `settings` (JSONB) — no such column
- `employee_count` — not present
- `shareholder_count` — not present
- `all_shareholders_are_directors` — not present
- `cipc_annual_return_due` — not present
- `cipc_annual_return_submitted` — not present

### afs_documents table (from 333_afs_documents.sql)

```
id, company_id, fiscal_year (INTEGER), period (TEXT),
document_type, reporting_framework, status, locked_at, locked_by,
version, pis_score (NUMERIC(10,2)), created_at, updated_at
```

**Columns that DO NOT exist:**
- `filing_deadline` — not present (computed at runtime as fiscal year-end + 6 months)

### bank_accounts table (from 279_bank_accounts_bank_rules.sql)

```
id, company_id, account_name, account_number, bank_name, branch_code,
account_type, gl_account_id, currency, is_active, opening_balance,
current_balance, created_by, created_at, updated_at
```

**Columns that DO NOT exist:**
- `last_reconciled_at` — not present

---

## Missing Column Strategy

| Missing Column | Decision | Rationale |
|---|---|---|
| `companies.employee_count` | **Stub**: default to 0, return `employeePoints: 0` with a `dataUnavailable` flag | PIS can still compute 3/4 components from GL; employee data can be added later |
| `companies.shareholder_count` | **Stub**: default to 0, return `shareholderPoints: 0` with a `dataUnavailable` flag | Same rationale |
| `companies.all_shareholders_are_directors` | **Stub**: default to `false` (conservative — assumes external shareholders) | Safe default per Companies Act |
| `companies.cipc_annual_return_due` | **Stub**: skip CIPC overdue detector, return no alert | Non-critical alert |
| `companies.cipc_annual_return_submitted` | **Stub**: always show `ready: false` in CIPC guide with detail "Data not available" | Non-critical checklist item |
| `afs_documents.filing_deadline` | **Compute at runtime**: `fiscal_year` year-end + 6 months | No column needed |
| `bank_accounts.last_reconciled_at` | **Stub**: skip bank unreconciled detector, return no alert | Non-critical alert; can query `bank_reconciliations` table later |

---

## Prerequisites

| Item | Path | Notes |
|------|------|-------|
| Types | `@/modules/accounting/services/afs/afsTypes.ts` | Plan 1 output |
| DB tables | `afs_documents` (333), `afs_sections` (334), `note_templates` (335) | Plan 1 migrations |
| GL tables | `gl_journal_entries`, `gl_journal_lines`, `gl_accounts` | 200 + 220 + 329 |
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

### Migration (1)

```
scripts/migrations/sql/342_compliance_alerts.sql
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
  turnoverPoints: number;       // GL revenue total / 1_000_000, rounded to 2 dp
  employeePoints: number;       // 0 (stubbed — no employee_count column yet)
  shareholderPoints: number;    // 0 (stubbed — no shareholder_count column yet)
  liabilityPoints: number;      // third-party liabilities / 1_000_000, rounded to 2 dp
  total: number;                // sum of all four
  requiredFramework: 'ifrs_smes' | 'full_ifrs';
  requiredAudit: 'voluntary' | 'independent_review' | 'mandatory_audit';
  requiredCipcFiling: 'fas_only' | 'afs_required';
  dataUnavailable: string[];    // e.g. ['employee_count', 'shareholder_count']
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
  registrationNumber: string | null;
  yearEnd: string;              // ISO date (YYYY-MM-DD)
  filingDeadline: string;       // yearEnd + 6 months (ISO date)
  pisScore: number;
  requiredFilings: string[];    // human-readable list
  documentsReady: Array<{
    label: string;
    ready: boolean;
    detail?: string;
  }>;
  nextStep: string;             // single most important action
}

// ── Compliance Alerts ────────────────────────────────────────────────────────

export type AfsAlertType =
  | 'pis_threshold_100'
  | 'pis_threshold_350'
  | 'afs_filing_deadline_30'
  | 'afs_filing_deadline_14'
  | 'afs_filing_deadline_7';
  // 'cipc_overdue' and 'bank_unreconciled_30d' removed — columns do not exist

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

## DB Migration

**File:** `scripts/migrations/sql/342_compliance_alerts.sql`

> Migration numbering: 339 is the last existing migration. Plans 5 and 7 may claim 340-341. This plan uses 342 to avoid collisions.

```sql
-- 342_compliance_alerts.sql
-- Stores AFS-specific compliance alerts (PIS threshold crossings, filing deadlines).
-- Existing statutory document alerts come from statutoryDocService — these are separate.

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

-- Prevent duplicate un-dismissed alerts of the same type per company
CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_alerts_active
  ON compliance_alerts (company_id, alert_type)
  WHERE dismissed_at IS NULL;
```

---

## Service 1 — `pisCalculatorService.ts`

**Path:** `src/modules/accounting/services/afs/pisCalculatorService.ts`
**Max lines:** 220

### Responsibility

Query live GL for revenue and third-party liabilities using the correct 3-table join. Employee count and shareholder count are stubbed to 0 (columns do not exist on `companies` yet). Compute PIS total. Derive the required framework, audit level, and CIPC filing obligation.

### PIS Thresholds (Companies Act)

| PIS total | Framework | Audit requirement | CIPC filing |
|-----------|-----------|-------------------|-------------|
| < 100 (all shareholders = directors) | `ifrs_smes` | `voluntary` | `fas_only` |
| < 100 (external shareholders present) | `ifrs_smes` | `independent_review` | `afs_required` |
| 100–349 | `ifrs_smes` | `independent_review` | `afs_required` |
| >= 350 | `full_ifrs` | `mandatory_audit` | `afs_required` |

> Implementation: Since `all_shareholders_are_directors` does not exist on `companies`, default to `false` (conservative — assumes external shareholders). This means PIS < 100 will always recommend `independent_review` unless overridden in the future.

### GL Queries

**Revenue (turnover points):**
```sql
SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total_revenue
FROM gl_journal_lines jl
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
JOIN gl_accounts ga ON ga.id = jl.gl_account_id
WHERE je.company_id = ${companyId}::UUID
  AND jl.company_id = ${companyId}::UUID
  AND ga.company_id = ${companyId}::UUID
  AND je.status = 'posted'
  AND ga.account_type = 'revenue'
  AND je.entry_date >= ${fiscalYearStart}
  AND je.entry_date <= ${fiscalYearEnd}
```

**Third-party liabilities (liability points):**
```sql
SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total_liabilities
FROM gl_journal_lines jl
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
JOIN gl_accounts ga ON ga.id = jl.gl_account_id
WHERE je.company_id = ${companyId}::UUID
  AND jl.company_id = ${companyId}::UUID
  AND ga.company_id = ${companyId}::UUID
  AND je.status = 'posted'
  AND ga.account_type = 'liability'
  AND (ga.account_subtype IS NULL OR ga.account_subtype NOT IN ('equity_loan', 'shareholder_loan'))
  AND je.entry_date <= ${fiscalYearEnd}
```

**Company lookup (for name + year-end):**
```sql
SELECT name, registration_number, financial_year_start
FROM companies
WHERE id = ${companyId}::UUID
```

> No `employee_count`, `shareholder_count`, or `all_shareholders_are_directors` columns exist. These are hardcoded to 0/false and flagged in `dataUnavailable`.

### Exported functions

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PisScore } from './afsTypes';

export async function computePisScore(
  companyId: string,
  fiscalYearStart: string,  // ISO date
  fiscalYearEnd: string     // ISO date
): Promise<PisScore> {
  const [revenueResult, liabilityResult] = await Promise.all([
    sql`
      SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total_revenue
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND ga.account_type = 'revenue'
        AND je.entry_date >= ${fiscalYearStart}
        AND je.entry_date <= ${fiscalYearEnd}
    `,
    sql`
      SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total_liabilities
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND ga.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND ga.account_type = 'liability'
        AND (ga.account_subtype IS NULL
             OR ga.account_subtype NOT IN ('equity_loan', 'shareholder_loan'))
        AND je.entry_date <= ${fiscalYearEnd}
    `,
  ]);

  const totalRevenue = Number(revenueResult[0]?.total_revenue ?? 0);
  const totalLiabilities = Number(liabilityResult[0]?.total_liabilities ?? 0);

  const turnoverPoints = Math.round((totalRevenue / 1_000_000) * 100) / 100;
  const liabilityPoints = Math.round((totalLiabilities / 1_000_000) * 100) / 100;
  const employeePoints = 0;      // Stubbed — companies.employee_count does not exist
  const shareholderPoints = 0;   // Stubbed — companies.shareholder_count does not exist
  const total = turnoverPoints + employeePoints + shareholderPoints + liabilityPoints;

  const allDirectors = false;    // Stubbed — companies.all_shareholders_are_directors does not exist
  const { requiredFramework, requiredAudit, requiredCipcFiling } =
    deriveRequirements(total, allDirectors);

  return {
    turnoverPoints,
    employeePoints,
    shareholderPoints,
    liabilityPoints,
    total,
    requiredFramework,
    requiredAudit,
    requiredCipcFiling,
    dataUnavailable: ['employee_count', 'shareholder_count'],
    calculatedAt: new Date().toISOString(),
  };
}

// Convenience: reads fiscal year from afs_documents for a given documentId
export async function computePisScoreForDocument(
  companyId: string,
  documentId: string
): Promise<PisScore> {
  const rows = await sql`
    SELECT d.fiscal_year, c.financial_year_start
    FROM afs_documents d
    JOIN companies c ON c.id = d.company_id
    WHERE d.id = ${documentId}::UUID
      AND d.company_id = ${companyId}::UUID
  `;

  if (rows.length === 0) {
    throw new Error(`AFS document ${documentId} not found for company ${companyId}`);
  }

  const { fiscal_year, financial_year_start } = rows[0];
  const fyStartMonth = (financial_year_start as number) || 3; // default March
  const year = fiscal_year as number;

  // Fiscal year start: fyStartMonth of (year - 1) if fyStartMonth > 1, else Jan of year
  const startYear = fyStartMonth > 1 ? year - 1 : year;
  const fiscalYearStart = `${startYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  // Fiscal year end: last day of (fyStartMonth - 1) of year, or Dec 31 if fyStartMonth = 1
  let endMonth: number;
  let endYear: number;
  if (fyStartMonth === 1) {
    endMonth = 12;
    endYear = year;
  } else {
    endMonth = fyStartMonth - 1;
    endYear = year;
  }
  const lastDay = new Date(endYear, endMonth, 0).getDate();
  const fiscalYearEnd = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  return computePisScore(companyId, fiscalYearStart, fiscalYearEnd);
}
```

### Internal helpers

```typescript
function deriveRequirements(total: number, allDirectors: boolean): {
  requiredFramework: PisScore['requiredFramework'];
  requiredAudit: PisScore['requiredAudit'];
  requiredCipcFiling: PisScore['requiredCipcFiling'];
} {
  if (total >= 350) {
    return {
      requiredFramework: 'full_ifrs',
      requiredAudit: 'mandatory_audit',
      requiredCipcFiling: 'afs_required',
    };
  }

  if (total >= 100) {
    return {
      requiredFramework: 'ifrs_smes',
      requiredAudit: 'independent_review',
      requiredCipcFiling: 'afs_required',
    };
  }

  // PIS < 100
  if (allDirectors) {
    return {
      requiredFramework: 'ifrs_smes',
      requiredAudit: 'voluntary',
      requiredCipcFiling: 'fas_only',
    };
  }

  return {
    requiredFramework: 'ifrs_smes',
    requiredAudit: 'independent_review',
    requiredCipcFiling: 'afs_required',
  };
}
```

---

## Service 2 — `complianceCheckerService.ts`

**Path:** `src/modules/accounting/services/afs/complianceCheckerService.ts`
**Max lines:** 300

### Responsibility

Accept a `documentId` + `companyId`. Fetch all `afs_sections` rows and `note_templates` rows. Run all three check categories in parallel. Compute a composite score. Return a `ComplianceResult`.

### Score calculation

```
score = Math.round((passedChecks / totalChecks) * 100)
```

A blocker reduces `passedChecks` by the full weight (1.0). Warnings reduce by 0.5. Info issues do not reduce the score.

### Structural Checks (category: `'structural'`)

| checkId | Severity | Description |
|---------|----------|-------------|
| `structural.mandatory_notes_present` | `blocker` | Every `note_templates` row where `is_mandatory = true` AND `framework` matches the document's `reporting_framework` (or `'both'`) must have a corresponding `afs_sections` row for this `document_id`. |
| `structural.no_mandatory_note_pending` | `blocker` | No mandatory note's `afs_sections.status` is `'pending'` — must be at least `'auto_generated'`. |
| `structural.directors_report_present` | `blocker` | An `afs_sections` row with `section_type = 'directors_report'` exists for the document. |
| `structural.auditors_remuneration_present` | `blocker` | An `afs_sections` row with `section_type = 'note_24'` exists — required regardless of framework. |
| `structural.comparative_figures_present` | `warning` | For every statement section (`statement_of_fp`, `income_statement`, `cash_flow`, `changes_in_equity`), the `content` JSONB contains a key `comparativePeriod` or at least one table block with a column header matching prior year. Check: `section.content?.comparativePeriod != null`. |

### Mathematical Checks (category: `'mathematical'`)

All figures pulled from `afs_sections.data_snapshot` JSONB — do **not** re-query the GL.

| checkId | Severity | Description |
|---------|----------|-------------|
| `mathematical.balance_sheet_balances` | `blocker` | `abs(totalAssets - (totalLiabilities + totalEquity)) <= 0.01`. Read from `statement_of_fp` section's `data_snapshot.totals`. |
| `mathematical.cash_flow_closing_balance` | `blocker` | `abs(cashFlowClosingBalance - balanceSheetCashBalance) <= 0.01`. Compare `cash_flow.data_snapshot.closingBalance` vs `statement_of_fp.data_snapshot.cashAccountBalance`. |
| `mathematical.equity_closing_balance` | `blocker` | `abs(changesInEquityClosing - balanceSheetTotalEquity) <= 0.01`. Compare `changes_in_equity.data_snapshot.closingTotalEquity` vs `statement_of_fp.data_snapshot.totals.totalEquity`. |
| `mathematical.income_tax_effective_rate` | `warning` | From `note_17.data_snapshot`: `effectiveRate = taxExpense / profitBeforeTax`. Flag if `effectiveRate > 0.35` or `effectiveRate < 0` (but not if `profitBeforeTax === 0` — skip the check). Provide `detail` with the computed rate. |

> For documents where `changes_in_equity` or `cash_flow` sections do not yet exist (status `pending`), skip those checks and log them as `info` with message "Section not yet generated — check deferred."

### Disclosure Quality Checks (category: `'disclosure_quality'`)

| checkId | Severity | Description |
|---------|----------|-------------|
| `disclosure.note1_covers_material_types` | `warning` | Fetch distinct `account_type` values in `data_snapshot` of the `statement_of_fp` section. For each of `revenue`, `ppe`, `inventory` that appear: verify `note_1.content.blocks` contains a block whose `text` includes the keyword (case-insensitive). |
| `disclosure.note23_covers_directors` | `warning` | Extract director names from `directors_report.content`. Verify each name appears (case-insensitive) in `note_23.content.blocks` text. If `note_23` does not exist, severity is `blocker`. |
| `disclosure.note26_events_declared` | `warning` | `note_26.content` must exist AND (`content.blocks` has at least one non-empty block OR `overrides` JSONB contains `suppressReason === 'nil'`). |
| `disclosure.note27_going_concern` | `warning` | Compute current ratio from `statement_of_fp.data_snapshot`. If `currentRatio < 1.0` OR net loss in `income_statement.data_snapshot` is positive (loss), then `note_27` section must exist and must not be `pending`. If the condition is not met, this check passes automatically. |

### Data fetching

```typescript
async function fetchDocumentSections(
  companyId: string,
  documentId: string
): Promise<{ doc: AfsDocRow; sections: AfsSectionRow[]; templates: NoteTemplateRow[] }> {
  const [docRows, sectionRows, templateRows] = await Promise.all([
    sql`
      SELECT id, company_id, fiscal_year, reporting_framework, status
      FROM afs_documents
      WHERE id = ${documentId}::UUID
        AND company_id = ${companyId}::UUID
    `,
    sql`
      SELECT id, document_id, company_id, section_type, sort_order,
             status, data_snapshot, content, overrides,
             ai_narrative, ai_narrative_accepted
      FROM afs_sections
      WHERE document_id = ${documentId}::UUID
        AND company_id = ${companyId}::UUID
    `,
    sql`
      SELECT id, section_type, framework, title, is_mandatory
      FROM note_templates
    `,
  ]);

  if (docRows.length === 0) {
    throw new Error(`AFS document ${documentId} not found for company ${companyId}`);
  }

  return {
    doc: docRows[0] as AfsDocRow,
    sections: sectionRows as AfsSectionRow[],
    templates: templateRows as NoteTemplateRow[],
  };
}
```

### Exported functions

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ComplianceResult, ComplianceIssue } from './afsTypes';

export async function runComplianceCheck(
  companyId: string,
  documentId: string
): Promise<ComplianceResult> {
  const { doc, sections, templates } = await fetchDocumentSections(companyId, documentId);

  const structuralIssues = runStructuralChecks(doc, sections, templates);
  const mathematicalIssues = runMathematicalChecks(sections);
  const disclosureIssues = runDisclosureQualityChecks(sections);

  const allIssues = [...structuralIssues, ...mathematicalIssues, ...disclosureIssues];
  const totalChecks = 5 + 4 + 4; // structural + mathematical + disclosure
  const score = computeScore(allIssues, totalChecks);

  const blockerCount = allIssues.filter(i => i.severity === 'blocker').length;
  const warningCount = allIssues.filter(i => i.severity === 'warning').length;
  const passedCount = totalChecks - blockerCount - warningCount;

  return {
    score,
    passedCount,
    warningCount,
    blockerCount,
    issues: allIssues,
    checkedAt: new Date().toISOString(),
  };
}
```

### Internal helpers

```typescript
// Internal row types (snake_case from DB)
interface AfsDocRow {
  id: string;
  company_id: string;
  fiscal_year: number | null;
  reporting_framework: string;
  status: string;
}

interface AfsSectionRow {
  id: string;
  document_id: string;
  company_id: string;
  section_type: string;
  sort_order: number;
  status: string;
  data_snapshot: Record<string, unknown> | null;
  content: { title?: string; blocks?: Array<{ type: string; text?: string }> } | null;
  overrides: Record<string, unknown> | null;
}

interface NoteTemplateRow {
  id: string;
  section_type: string;
  framework: string;
  title: string;
  is_mandatory: boolean;
}

function runStructuralChecks(
  doc: AfsDocRow,
  sections: AfsSectionRow[],
  templates: NoteTemplateRow[]
): ComplianceIssue[] { /* ... */ }

function runMathematicalChecks(
  sections: AfsSectionRow[]
): ComplianceIssue[] { /* ... */ }

function runDisclosureQualityChecks(
  sections: AfsSectionRow[]
): ComplianceIssue[] { /* ... */ }

function computeScore(issues: ComplianceIssue[], totalChecks: number): number {
  let deductions = 0;
  for (const issue of issues) {
    if (issue.severity === 'blocker') deductions += 1;
    else if (issue.severity === 'warning') deductions += 0.5;
    // info = no deduction
  }
  const passed = Math.max(0, totalChecks - deductions);
  return Math.round((passed / totalChecks) * 100);
}
```

---

## Service 3 — `cipcFilingGuideService.ts`

**Path:** `src/modules/accounting/services/afs/cipcFilingGuideService.ts`
**Max lines:** 180

### Responsibility

Given a `documentId` and `companyId`, fetch company details and the document's PIS score, then produce a structured filing checklist.

### Filing deadline (computed at runtime)

```typescript
// Compute fiscal year-end from fiscal_year + financial_year_start
// Then add 6 months for CIPC deadline
function computeFilingDeadline(fiscalYear: number, financialYearStartMonth: number): string {
  let endMonth: number;
  let endYear: number;
  if (financialYearStartMonth === 1) {
    endMonth = 12;
    endYear = fiscalYear;
  } else {
    endMonth = financialYearStartMonth - 1;
    endYear = fiscalYear;
  }
  const lastDay = new Date(endYear, endMonth, 0).getDate();
  const yearEnd = new Date(endYear, endMonth - 1, lastDay);
  // Add 6 months
  const deadline = new Date(yearEnd);
  deadline.setMonth(deadline.getMonth() + 6);
  return deadline.toISOString().split('T')[0];
}
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
| `AFS signed off` | `afs_documents.status` is `'signed_off'` or `'filed'` |
| `All sections reviewed` | All mandatory `afs_sections.status` >= `'reviewed'` |
| `Reviewer/Auditor report uploaded` | An `afs_sections` row with `section_type = 'auditors_report'` exists and is not `pending` |
| `CIPC annual return submitted` | Always `false` with detail "Data not available — companies.cipc_annual_return_submitted column not yet added" |

### Data query

```typescript
const rows = await sql`
  SELECT d.id, d.fiscal_year, d.status, d.pis_score, d.reporting_framework,
         c.name, c.registration_number, c.financial_year_start
  FROM afs_documents d
  JOIN companies c ON c.id = d.company_id
  WHERE d.id = ${documentId}::UUID
    AND d.company_id = ${companyId}::UUID
`;
```

### Exported functions

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { computePisScoreForDocument } from './pisCalculatorService';
import type { CipcFilingGuide } from './afsTypes';

export async function generateCipcFilingGuide(
  companyId: string,
  documentId: string
): Promise<CipcFilingGuide> { /* ... */ }
```

---

## Service 4 — `complianceAlertService.ts`

**Path:** `src/modules/accounting/services/afs/complianceAlertService.ts`
**Max lines:** 200

### Responsibility

Detect and fire AFS-specific compliance alerts. Stored in the `compliance_alerts` table (342). The existing `statutoryDocService.checkComplianceAlerts()` handles document expiry alerts — this service handles AFS/PIS alerts only. They are combined at the API layer.

### Alert logic

```typescript
export async function detectAndFireAfsAlerts(companyId: string): Promise<void>
```

Runs all detectors below. For each, the unique index `uq_compliance_alerts_active` on `(company_id, alert_type) WHERE dismissed_at IS NULL` prevents duplicates via `ON CONFLICT DO NOTHING`.

**Detector 1 — PIS threshold crossings**

```sql
SELECT id, pis_score
FROM afs_documents
WHERE company_id = ${companyId}::UUID
  AND pis_score IS NOT NULL
ORDER BY created_at DESC
LIMIT 2
```

If the most recent PIS >= 100 AND the prior one < 100: fire `pis_threshold_100`.
If the most recent PIS >= 350 AND the prior one < 350: fire `pis_threshold_350`.
If only one document exists (no prior), skip threshold-crossing check.

**Detector 2 — Filing deadline approaching**

Filing deadline is computed at runtime (fiscal year-end + 6 months), NOT read from a column.

```sql
SELECT d.id, d.fiscal_year, c.financial_year_start
FROM afs_documents d
JOIN companies c ON c.id = d.company_id
WHERE d.company_id = ${companyId}::UUID
  AND d.status NOT IN ('signed_off', 'filed')
  AND d.document_type = 'afs'
```

For each document: compute the fiscal year-end and add 6 months. Then:
- `daysUntil <= 30`: fire `afs_filing_deadline_30`
- `daysUntil <= 14`: fire `afs_filing_deadline_14`
- `daysUntil <= 7`: fire `afs_filing_deadline_7`

**Detector 3 — CIPC overdue: SKIPPED**

> The `companies.cipc_annual_return_due` column does not exist. This detector is a no-op stub that logs a debug message and returns. Will be activated when the column is added.

**Detector 4 — Bank unreconciled 30+ days: SKIPPED**

> The `bank_accounts.last_reconciled_at` column does not exist. This detector is a no-op stub. A future enhancement could query `bank_reconciliations` for the most recent reconciliation per bank account, but that is out of scope for this plan.

### Insert pattern

```typescript
await sql`
  INSERT INTO compliance_alerts (company_id, alert_type, message, detail)
  VALUES (${companyId}::UUID, ${alertType}, ${message}, ${detail})
  ON CONFLICT (company_id, alert_type) WHERE dismissed_at IS NULL
  DO NOTHING
`;
```

### Dismiss function

```typescript
export async function dismissAfsAlert(
  companyId: string,
  alertId: string,
  userId: string
): Promise<void> {
  await sql`
    UPDATE compliance_alerts
    SET dismissed_at = now(), dismissed_by = ${userId}::UUID
    WHERE id = ${alertId}::UUID
      AND company_id = ${companyId}::UUID
  `;
}
```

### Fetch function

```typescript
export async function getActiveAfsAlerts(
  companyId: string
): Promise<AfsComplianceAlert[]> {
  const rows = await sql`
    SELECT id, company_id, alert_type, message, detail,
           fired_at, dismissed_at, dismissed_by
    FROM compliance_alerts
    WHERE company_id = ${companyId}::UUID
      AND dismissed_at IS NULL
    ORDER BY fired_at DESC
  `;
  return rows.map(r => ({
    id: r.id as string,
    companyId: r.company_id as string,
    alertType: r.alert_type as AfsAlertType,
    message: r.message as string,
    detail: (r.detail as string) ?? undefined,
    firedAt: (r.fired_at as Date).toISOString(),
    dismissedAt: null,
    dismissedBy: null,
  }));
}
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

export default withCompany(withErrorHandler(handler as never));
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

export default withCompany(withErrorHandler(handler as never));
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

export default withCompany(withErrorHandler(handler as never));
```

### `GET + POST /api/accounting/compliance-alerts` (extend existing)

**File:** `pages/api/accounting/compliance-alerts.ts` — **extend, do not replace**

The existing handler wraps everything with `withWriteAccess`. To allow read-only users to view alerts, restructure the handler with method-based branching: GET does NOT require write access, POST (dismiss) does.

```typescript
/**
 * Compliance Alerts API
 * GET  /api/accounting/compliance-alerts  — read alerts (all users)
 * POST /api/accounting/compliance-alerts  — dismiss alert (write access only)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import type { AuthenticatedNextApiRequest } from '@/lib/auth/middleware';
import { checkComplianceAlerts } from '@/modules/accounting/services/reports/statutoryDocService';
import { getActiveAfsAlerts, dismissAfsAlert } from '@/modules/accounting/services/afs/complianceAlertService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const [statutoryAlerts, afsAlerts] = await Promise.all([
      checkComplianceAlerts(companyId),
      getActiveAfsAlerts(companyId),
    ]);
    return apiResponse.success(res, { alerts: [...statutoryAlerts, ...afsAlerts] });
  }

  if (req.method === 'POST') {
    // Write access check is done by wrapping the POST logic
    const { alertId } = req.body as { alertId?: string };
    if (typeof alertId !== 'string') {
      return apiResponse.badRequest(res, 'alertId is required');
    }
    const userId = (req as unknown as AuthenticatedNextApiRequest).user.id;
    await dismissAfsAlert(companyId, alertId, userId);
    return apiResponse.success(res, { dismissed: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

// Note: withWriteAccess wraps the whole handler. GET requests bypass write-access
// checks internally because withWriteAccess only blocks non-GET methods.
// If withWriteAccess blocks GETs too, split into two separate route files instead.
export default withCompany(withErrorHandler(withWriteAccess(handler as never)));
```

> **Implementation note:** Check the actual `withWriteAccess` behavior. If it blocks ALL methods including GET, then split into two files:
> - `pages/api/accounting/compliance-alerts/index.ts` (GET only, no `withWriteAccess`)
> - `pages/api/accounting/compliance-alerts/dismiss.ts` (POST only, with `withWriteAccess`)

---

## Tests

### Pattern (from existing AFS tests)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
type SqlFn = ReturnType<typeof vi.fn>;
const mockSql = sql as unknown as SqlFn;

beforeEach(() => { vi.clearAllMocks(); });
```

### `pisCalculatorService.test.ts`

**File:** `tests/unit/services/afs/pisCalculatorService.test.ts`

Test cases:

1. **Computes PIS correctly from GL data** — mock sql: first call returns `[{ total_revenue: '5000000' }]`, second returns `[{ total_liabilities: '2000000' }]`. Expected: `turnoverPoints: 5`, `liabilityPoints: 2`, `employeePoints: 0`, `shareholderPoints: 0`, `total: 7`. Expected `requiredFramework: 'ifrs_smes'`, `requiredAudit: 'independent_review'` (conservative default since allDirectors = false), `requiredCipcFiling: 'afs_required'`.

2. **PIS >= 350 triggers full IFRS** — mock revenue = 200_000_000, liabilities = 150_000_000. Total = 350. Expected `requiredFramework: 'full_ifrs'`, `requiredAudit: 'mandatory_audit'`.

3. **PIS < 100 defaults to independent_review (conservative)** — mock revenue = 50_000_000, liabilities = 10_000_000. Total = 60. Expected `requiredAudit: 'independent_review'` (not `voluntary`, because `all_shareholders_are_directors` is stubbed to `false`).

4. **Rounds GL figures to 2 dp** — revenue = 1_500_500. Expected `turnoverPoints: 1.5`.

5. **Returns zero points when GL is empty** — all sql calls return `[{ total_revenue: '0' }]` / `[{ total_liabilities: '0' }]`. Total = 0.

6. **dataUnavailable includes stubbed fields** — result always contains `dataUnavailable: ['employee_count', 'shareholder_count']`.

### `complianceCheckerService.test.ts`

**File:** `tests/unit/services/afs/complianceCheckerService.test.ts`

Test cases:

1. **Returns score 100 when all checks pass** — mock complete document with all mandatory sections at `'reviewed'`, balanced balance sheet in `statement_of_fp.data_snapshot`, equity closing matches, note_26 with content, note_27 not triggered.

2. **Blocker: balance sheet does not balance** — `statement_of_fp.data_snapshot.totals`: `totalAssets = 100_000`, `totalLiabilities = 60_000`, `totalEquity = 30_000` (gap = 10_000). Expect issue `mathematical.balance_sheet_balances` with severity `blocker`. Score < 100.

3. **Blocker: mandatory note missing** — mock `note_templates` with 3 mandatory notes but `afs_sections` only has 2. Expect `structural.mandatory_notes_present` blocker.

4. **Warning: comparative figures absent** — `statement_of_fp.content` has no `comparativePeriod` key. Expect `structural.comparative_figures_present` warning.

5. **Disclosure: note_26 missing content and no suppressReason** — Expect `disclosure.note26_events_declared` warning.

6. **Going concern triggered correctly** — `statement_of_fp.data_snapshot.currentRatio = 0.8`. `note_27` section is `pending`. Expect `disclosure.note27_going_concern` warning.

7. **Income tax rate flag** — `note_17.data_snapshot`: `taxExpense = 40_000`, `profitBeforeTax = 100_000`, effectiveRate = 0.40. Expect `mathematical.income_tax_effective_rate` warning with detail containing "40%".

8. **Skips cash flow check when section is pending** — `cash_flow` section has `status: 'pending'`. Expect `info` issue "Section not yet generated" instead of blocker.

### `cipcFilingGuideService.test.ts`

**File:** `tests/unit/services/afs/cipcFilingGuideService.test.ts`

Test cases:

1. **Filing deadline is 6 months after year-end** — fiscal_year = 2025, financial_year_start = 3 (March). Year-end = 2025-02-28. Expected `filingDeadline = '2025-08-28'`.

2. **Required filings for mandatory_audit** — PIS score mocked at 400. `requiredFilings` includes `'Auditor\'s Report'` and `'XBRL/iXBRL filing'`.

3. **Required filings for independent_review** — PIS score mocked at 150. `requiredFilings` includes `'Independent Reviewer\'s Report'` but not `'XBRL/iXBRL filing'`.

4. **AFS signed off shows ready** — document status `'signed_off'`. `documentsReady.find(d => d.label === 'AFS signed off').ready === true`.

5. **CIPC annual return always shows not ready with explanation** — `documentsReady.find(d => d.label === 'CIPC annual return submitted').ready === false` and `detail` contains "not available".

6. **nextStep reflects outstanding item** — If AFS not signed off: `nextStep` contains "sign off" (case-insensitive).

---

## Implementation Order

1. **Add types** to `afsTypes.ts` (15 min)
2. **DB migration** `342_compliance_alerts.sql` (10 min)
3. **`pisCalculatorService.test.ts`** — 6 tests, TDD first (30 min)
4. **`pisCalculatorService.ts`** — GL 3-table join queries + threshold logic (45 min)
5. **`complianceCheckerService.test.ts`** — 8 tests, TDD first (60 min)
6. **`complianceCheckerService.ts`** — all 13 checks (90 min)
7. **`cipcFilingGuideService.test.ts`** — 6 tests, TDD first (30 min)
8. **`cipcFilingGuideService.ts`** — guide builder (40 min)
9. **`complianceAlertService.ts`** — 2 active detectors + 2 stubs + dismiss + fetch (50 min)
10. **API routes** — 3 new routes (30 min)
11. **Extend `compliance-alerts.ts`** — merge GET + POST dismiss (20 min)
12. **`bun run test:unit`** — all tests green (15 min)
13. **`bunx tsc --noEmit`** — no type errors (10 min)

**Estimated total:** ~7.5 hours

---

## Patterns Checklist

Every file must pass this before PR:

- [ ] `sql` tagged template only — zero string concatenation in queries
- [ ] `company_id` in every DB query that touches tenant data (all 3 tables in GL joins)
- [ ] GL queries use 3-table join: `gl_journal_lines` JOIN `gl_journal_entries` JOIN `gl_accounts`
- [ ] GL queries filter `je.status = 'posted'` (NOT `je.is_posted = TRUE`)
- [ ] API routes wrapped: `withCompany(withErrorHandler(handler as never))`
- [ ] Responses via `apiResponse.success()` / `.badRequest()` / `.notFound()`
- [ ] `log` from `@/lib/logger` — no `console.log`
- [ ] No empty `catch` blocks
- [ ] 100% TypeScript — no implicit `any`
- [ ] File length <= 300 lines
- [ ] All `CREATE TABLE` / `CREATE INDEX` in migrations use `IF NOT EXISTS`
- [ ] Tests mock both `@/lib/neon` and `@/lib/logger`
- [ ] `vi.clearAllMocks()` in `beforeEach`
- [ ] Import paths match actual codebase: `@/lib/auth`, `@/lib/api-error-handler`, `@/lib/neon`

---

## Edge Cases to Handle

| Scenario | Handling |
|----------|----------|
| Document not found or wrong tenant | Return `apiResponse.notFound(res, 'AFS document', documentId)` |
| `afs_sections` empty (no generation yet) | Structural checks all fail; mathematical checks return `info` deferral |
| `note_17` has `profitBeforeTax === 0` | Skip effective rate check entirely (avoid division by zero) |
| `currentRatio` field absent from `data_snapshot` | Skip going concern trigger; log `warn` |
| Employee/shareholder count unavailable | Return `0` for points, include field name in `dataUnavailable` array |
| Alert already fired (duplicate guard) | `INSERT ... ON CONFLICT DO NOTHING` via partial unique index |
| PIS detector: only one document (no prior) | Skip threshold-crossing check — can't compare to prior |
| CIPC overdue detector: column missing | No-op stub, log debug message |
| Bank unreconciled detector: column missing | No-op stub, log debug message |
| `withWriteAccess` blocks GET requests | Split into two route files (see implementation note in API section) |

---

## Changes From Original Plan (Audit Fixes)

| Issue | Original (Wrong) | Corrected |
|-------|-------------------|-----------|
| GL query pattern | `journal_entries je JOIN accounts a ON a.id = je.account_id` | 3-table join: `gl_journal_lines jl JOIN gl_journal_entries je JOIN gl_accounts ga` |
| Posted filter | `je.is_posted = TRUE` | `je.status = 'posted'` |
| Table names | `journal_entries`, `accounts` | `gl_journal_entries`, `gl_journal_lines`, `gl_accounts` |
| company_id on journal_lines | Missing | Added `jl.company_id = ${companyId}::UUID` |
| companies.settings JSONB | Queried for employee/shareholder data | Column does not exist — stubbed to 0 with `dataUnavailable` flag |
| companies.employee_count | Queried | Does not exist — stubbed |
| companies.shareholder_count | Queried | Does not exist — stubbed |
| companies.all_shareholders_are_directors | Queried | Does not exist — defaults to false (conservative) |
| afs_documents.filing_deadline | Queried from column | Computed at runtime from `fiscal_year` + `financial_year_start` |
| bank_accounts.last_reconciled_at | Queried | Does not exist — detector stubbed |
| companies.cipc_annual_return_due | Queried | Does not exist — detector stubbed |
| Migration filename | `292-create-compliance-alerts.sql` | `342_compliance_alerts.sql` |
| API handler cast | `handler as any` | `handler as never` |
| Balance sheet section type | `balance_sheet` | `statement_of_fp` (matches SectionType in afsTypes.ts) |
| AfsAlertType | Included `cipc_overdue`, `bank_unreconciled_30d` | Removed — underlying columns don't exist |
| CipcFilingGuide.registrationNumber | `string` | `string \| null` (column is nullable in companies table) |
