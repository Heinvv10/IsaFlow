# Plan 7 — Monthly Management Pack Scheduler

**Date:** 2026-04-16
**Spec:** `docs/superpowers/specs/2026-04-16-financial-reporting-afs-design.md` (Section 7)
**Status:** Ready for implementation
**Prerequisites:** Plan 1 (Document Engine Foundation) and Plan 3 (Primary Statements) complete.
**Types source:** `@/modules/accounting/services/afs/afsTypes.ts` (from Plan 1)

---

## Overview

This plan implements the automated Monthly Management Pack Scheduler for ISaFlow. Each pack is an `AfsDocument` with `document_type: 'management_pack'`. The system generates packs on a per-company schedule, calculates 14 KPIs with RAG traffic lights, generates an AI executive summary, and delivers the pack to configured recipients.

---

## File Map

```
scripts/migrations/sql/
  339_management_pack_configs.sql

src/modules/accounting/services/afs/
  managementPackConfigService.ts
  managementPackGeneratorService.ts
  kpiScorecardService.ts
  packAiSummaryService.ts
  packDeliveryService.ts
  packSchedulerService.ts

pages/api/accounting/afs/
  management-pack-config.ts                  (GET / PUT)
  management-packs/
    index.ts                                 (GET — list)
    [packId]/
      index.ts                               (GET — single)
      deliver.ts                             (POST — manual deliver)
  generate.ts                                (POST — manual trigger)
  cron/
    management-packs.ts                      (GET — 06:00 SAST cron)

pages/accounting/afs/
  management-packs.tsx                       (list + config page)

tests/unit/services/afs/
  kpiScorecardService.test.ts
  managementPackConfigService.test.ts
```

---

## Step 1 — Migration: `339_management_pack_configs.sql`

**File:** `scripts/migrations/sql/339_management_pack_configs.sql`

> NOTE: Plan 1's migration `337_afs_documents.sql` already creates `afs_documents` and `afs_sections`. This migration adds the `management_pack_configs` table only. If Plan 1 already includes it in `337`, skip this file and leave a comment noting that.

```sql
-- 339_management_pack_configs.sql
-- Management pack scheduler configuration per company

CREATE TABLE IF NOT EXISTS management_pack_configs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  generation_day    INTEGER NOT NULL DEFAULT 5 CHECK (generation_day BETWEEN 1 AND 28),
  delivery_offset   INTEGER NOT NULL DEFAULT 3 CHECK (delivery_offset BETWEEN 0 AND 28),
  review_required   BOOLEAN NOT NULL DEFAULT TRUE,
  sections_enabled  JSONB NOT NULL DEFAULT '{
    "cover": true,
    "ai_executive_summary": true,
    "kpi_scorecard": true,
    "income_statement": true,
    "income_vs_budget": true,
    "balance_sheet": true,
    "cash_flow": true,
    "debtors_ageing": true,
    "creditors_ageing": true,
    "bank_reconciliation": true,
    "revenue_analysis": false,
    "expense_analysis": false,
    "budget_variance": false,
    "cash_flow_forecast": false,
    "vat_dashboard": false,
    "cfo_narrative": false
  }'::jsonb,
  recipients        JSONB NOT NULL DEFAULT '[]'::jsonb,
  pack_style        TEXT NOT NULL DEFAULT 'executive'
                      CHECK (pack_style IN ('executive', 'detailed', 'board')),
  comparison_mode   TEXT NOT NULL DEFAULT 'prior_month'
                      CHECK (comparison_mode IN ('prior_month', 'prior_year', 'budget', 'all_three')),
  currency_display  TEXT NOT NULL DEFAULT 'full'
                      CHECK (currency_display IN ('full', 'thousands', 'millions')),
  rag_thresholds    JSONB NOT NULL DEFAULT '{
    "currentRatio":      { "green": 1.5,  "amber": 1.0 },
    "debtorDays":        { "green": 30,   "amber": 60  },
    "grossMarginPct":    { "green": 40,   "amber": 20  },
    "quickRatio":        { "green": 1.0,  "amber": 0.7 },
    "debtToEquity":      { "green": 1.0,  "amber": 2.0 },
    "netProfitMarginPct":{ "green": 10,   "amber": 5   }
  }'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id)
);

CREATE INDEX IF NOT EXISTS idx_management_pack_configs_company
  ON management_pack_configs(company_id);

CREATE INDEX IF NOT EXISTS idx_management_pack_configs_enabled_day
  ON management_pack_configs(enabled, generation_day)
  WHERE enabled = TRUE;
```

**Explanation of design choices:**

- `UNIQUE (company_id)` — one config per company, GET/PUT is an upsert pattern.
- `generation_day` range `1–28` avoids February edge cases (never 29, 30, 31).
- `delivery_offset` — days after generation before client delivery (review window).
- `rag_thresholds` — per-company override of default RAG thresholds; higher wins green for ratios where higher is better; lower wins green for days-based metrics.
- `sections_enabled` default mirrors spec's 10 on / 6 off split exactly.

---

## Step 2 — Type Definitions (already in `afsTypes.ts` from Plan 1)

The following interfaces are expected to already exist in `@/modules/accounting/services/afs/afsTypes.ts`. This plan references them — do not duplicate. Verify they exist before implementing:

```typescript
// Expected from Plan 1:
export interface ManagementPackConfig { ... }
// AfsDocument with document_type: 'management_pack' | 'afs'
// AfsSection with data_snapshot, content (NoteContent), overrides, ai_narrative
```

If they are missing, add them to `afsTypes.ts` now (do not create a new types file):

```typescript
export interface ManagementPackRecipient {
  email: string;
  name: string;
  role: 'director' | 'cfo' | 'accountant' | 'other';
  receives: 'draft' | 'final' | 'both';
}

export interface ManagementPackSectionsEnabled {
  cover: boolean;
  ai_executive_summary: boolean;
  kpi_scorecard: boolean;
  income_statement: boolean;
  income_vs_budget: boolean;
  balance_sheet: boolean;
  cash_flow: boolean;
  debtors_ageing: boolean;
  creditors_ageing: boolean;
  bank_reconciliation: boolean;
  revenue_analysis: boolean;
  expense_analysis: boolean;
  budget_variance: boolean;
  cash_flow_forecast: boolean;
  vat_dashboard: boolean;
  cfo_narrative: boolean;
}

export interface RagThresholds {
  currentRatio:       { green: number; amber: number };
  quickRatio:         { green: number; amber: number };
  grossMarginPct:     { green: number; amber: number };
  netProfitMarginPct: { green: number; amber: number };
  debtorDays:         { green: number; amber: number };
  debtToEquity:       { green: number; amber: number };
}

export interface ManagementPackConfig {
  id: string;
  companyId: string;
  enabled: boolean;
  generationDay: number;
  deliveryOffset: number;
  reviewRequired: boolean;
  sectionsEnabled: ManagementPackSectionsEnabled;
  recipients: ManagementPackRecipient[];
  packStyle: 'executive' | 'detailed' | 'board';
  comparisonMode: 'prior_month' | 'prior_year' | 'budget' | 'all_three';
  currencyDisplay: 'full' | 'thousands' | 'millions';
  ragThresholds: RagThresholds;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface KpiResult {
  key: string;
  label: string;
  value: number;
  formatted: string;
  rag: 'green' | 'amber' | 'red';
  trend: 'up' | 'down' | 'flat';
  priorValue: number | null;
}

export interface KpiScorecard {
  period: string;
  companyId: string;
  kpis: KpiResult[];
  generatedAt: string;
}
```

---

## Step 3 — `managementPackConfigService.ts`

**File:** `src/modules/accounting/services/afs/managementPackConfigService.ts`
**Max lines:** 300
**DB:** `sql` tagged template from `@/lib/neon`
**Pattern:** Always scope by `company_id`

### Interface

```typescript
// Public API of this service:
getManagementPackConfig(companyId: string): Promise<ManagementPackConfig>
upsertManagementPackConfig(companyId: string, updates: Partial<ManagementPackConfig>): Promise<ManagementPackConfig>
getCompaniesScheduledForDate(dayOfMonth: number): Promise<Array<{ companyId: string; config: ManagementPackConfig }>>
```

### Implementation Notes

**`getManagementPackConfig`:**
- `SELECT * FROM management_pack_configs WHERE company_id = ${companyId}`
- If no row, return the default config (do not insert; insert happens on first explicit PUT).
- Map snake_case DB row to camelCase `ManagementPackConfig`. Handle both `Date` and `string` for `created_at`/`updated_at`.

**`upsertManagementPackConfig`:**
- Use `INSERT ... ON CONFLICT (company_id) DO UPDATE SET ...` pattern.
- Only update fields that are provided in `updates` (partial update). Merge `sectionsEnabled`, `recipients`, `ragThresholds` as full JSONB replace (not deep merge — caller sends complete object).
- Always set `updated_at = NOW()`.

**`getCompaniesScheduledForDate`:**
- `SELECT * FROM management_pack_configs WHERE enabled = TRUE AND generation_day = ${dayOfMonth}`
- Called by the cron job to find which companies generate today.
- Returns array of `{ companyId, config }`.

### Skeleton

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ManagementPackConfig } from './afsTypes';

const DEFAULT_CONFIG: Omit<ManagementPackConfig, 'id' | 'companyId' | 'createdAt' | 'updatedAt'> = {
  enabled: false,
  generationDay: 5,
  deliveryOffset: 3,
  reviewRequired: true,
  sectionsEnabled: {
    cover: true,
    ai_executive_summary: true,
    kpi_scorecard: true,
    income_statement: true,
    income_vs_budget: true,
    balance_sheet: true,
    cash_flow: true,
    debtors_ageing: true,
    creditors_ageing: true,
    bank_reconciliation: true,
    revenue_analysis: false,
    expense_analysis: false,
    budget_variance: false,
    cash_flow_forecast: false,
    vat_dashboard: false,
    cfo_narrative: false,
  },
  recipients: [],
  packStyle: 'executive',
  comparisonMode: 'prior_month',
  currencyDisplay: 'full',
  ragThresholds: {
    currentRatio:       { green: 1.5,  amber: 1.0 },
    quickRatio:         { green: 1.0,  amber: 0.7 },
    grossMarginPct:     { green: 40,   amber: 20  },
    netProfitMarginPct: { green: 10,   amber: 5   },
    debtorDays:         { green: 30,   amber: 60  },
    debtToEquity:       { green: 1.0,  amber: 2.0 },
  },
};

function mapRow(row: Record<string, unknown>): ManagementPackConfig { ... }

export async function getManagementPackConfig(companyId: string): Promise<ManagementPackConfig> { ... }
export async function upsertManagementPackConfig(companyId: string, updates: Partial<ManagementPackConfig>): Promise<ManagementPackConfig> { ... }
export async function getCompaniesScheduledForDate(dayOfMonth: number): Promise<Array<{ companyId: string; config: ManagementPackConfig }>> { ... }
```

---

## Step 4 — `kpiScorecardService.ts`

**File:** `src/modules/accounting/services/afs/kpiScorecardService.ts`
**Max lines:** 300
**DB:** Two SQL queries (income statement aggregates, balance sheet aggregates for the period + prior period). Pure calculation functions are exported for unit testing without DB mocks.
**Dependency:** Accepts pre-fetched financial snapshot objects — does NOT call other service modules.

### The 14 KPIs

| Key | Formula | Good direction |
|-----|---------|----------------|
| `grossMarginPct` | `grossProfit / revenue * 100` | Higher |
| `ebitdaMarginPct` | `ebitda / revenue * 100` | Higher |
| `netProfitMarginPct` | `netProfit / revenue * 100` | Higher |
| `currentRatio` | `currentAssets / currentLiabilities` | Higher |
| `quickRatio` | `(currentAssets - inventory) / currentLiabilities` | Higher |
| `debtorDays` | `(tradeReceivables / revenue) * 30` | Lower |
| `creditorDays` | `(tradePayables / cogs) * 30` | Lower |
| `inventoryDays` | `(inventory / cogs) * 30` | Lower |
| `cashConversionCycle` | `debtorDays + inventoryDays - creditorDays` | Lower |
| `debtToEquity` | `totalDebt / totalEquity` | Lower |
| `interestCoverage` | `ebit / interestExpense` | Higher |
| `revenueGrowthPct` | `(currentRevenue - priorRevenue) / priorRevenue * 100` | Higher |
| `cashBurnRate` | `(openingCash - closingCash) / days * 30` (only if cash declined) | Lower |
| `revenuePerEmployee` | `revenue / headcount` | Higher |

### RAG Logic

For each KPI, apply the company's configured thresholds. The threshold structure:
- **Higher-is-better KPIs** (ratios, margins, growth): `value >= green threshold → green`, `value >= amber threshold → amber`, else `red`.
- **Lower-is-better KPIs** (days-based, debt): `value <= green threshold → green`, `value <= amber threshold → amber`, else `red`.

```typescript
// Default thresholds (used when company has no override):
const DEFAULT_RAG_THRESHOLDS = {
  currentRatio:       { green: 1.5,  amber: 1.0,  lowerIsBetter: false },
  quickRatio:         { green: 1.0,  amber: 0.7,  lowerIsBetter: false },
  grossMarginPct:     { green: 40,   amber: 20,   lowerIsBetter: false },
  ebitdaMarginPct:    { green: 15,   amber: 5,    lowerIsBetter: false },
  netProfitMarginPct: { green: 10,   amber: 5,    lowerIsBetter: false },
  debtorDays:         { green: 30,   amber: 60,   lowerIsBetter: true  },
  creditorDays:       { green: 45,   amber: 75,   lowerIsBetter: true  },
  inventoryDays:      { green: 30,   amber: 60,   lowerIsBetter: true  },
  cashConversionCycle:{ green: 30,   amber: 60,   lowerIsBetter: true  },
  debtToEquity:       { green: 1.0,  amber: 2.0,  lowerIsBetter: true  },
  interestCoverage:   { green: 3.0,  amber: 1.5,  lowerIsBetter: false },
  revenueGrowthPct:   { green: 10,   amber: 0,    lowerIsBetter: false },
  cashBurnRate:       { green: 0,    amber: 50000,lowerIsBetter: true  },
  revenuePerEmployee: { green: 500000,amber: 200000,lowerIsBetter: false },
};
```

### Trend Calculation

Trend is derived by comparing `value` to `priorValue`:
- `Math.abs((value - priorValue) / priorValue) < 0.01` → `'flat'`
- `value > priorValue` → `'up'`
- `value < priorValue` → `'down'`
- If `priorValue` is `null` → `'flat'`

### Public Interface

```typescript
export interface FinancialSnapshot {
  revenue: number;
  cogs: number;            // cost of goods sold
  grossProfit: number;
  ebitda: number;
  ebit: number;
  netProfit: number;
  interestExpense: number;
  currentAssets: number;
  currentLiabilities: number;
  inventory: number;
  tradeReceivables: number;
  tradePayables: number;
  totalDebt: number;
  totalEquity: number;
  openingCash: number;
  closingCash: number;
  headcount: number;
  daysInPeriod: number;    // 28, 29, 30, or 31
}

// Pure functions — no DB calls — for unit testing
export function calculateKpis(
  current: FinancialSnapshot,
  prior: FinancialSnapshot | null,
  ragThresholds: RagThresholds,
): KpiResult[]

// DB-aware entry point
export async function getKpiScorecard(
  companyId: string,
  period: string,           // 'YYYY-MM'
  ragThresholds: RagThresholds,
): Promise<KpiScorecard>
```

### `getKpiScorecard` DB Queries

The function fetches two GL aggregates in `Promise.all`:

**Query 1 — Current period income/expense aggregates:**
```sql
SELECT
  SUM(CASE WHEN a.account_type = 'revenue' THEN jl.credit - jl.debit ELSE 0 END) AS revenue,
  SUM(CASE WHEN a.account_subtype = 'cost_of_sales' THEN jl.debit - jl.credit ELSE 0 END) AS cogs,
  -- ... other aggregates
FROM gl_journal_lines jl
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
JOIN chart_of_accounts a ON a.id = jl.account_id
WHERE je.company_id = ${companyId}
  AND je.is_posted = TRUE
  AND DATE_TRUNC('month', je.entry_date) = DATE_TRUNC('month', ${periodStart}::date)
```

**Query 2 — Balance sheet snapshot (as at last day of period):**
```sql
SELECT
  SUM(CASE WHEN a.account_type = 'asset' AND a.account_subtype = 'current_asset'
        THEN jl.debit - jl.credit ELSE 0 END) AS current_assets,
  -- ... other aggregates
FROM gl_journal_lines jl
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
JOIN chart_of_accounts a ON a.id = jl.account_id
WHERE je.company_id = ${companyId}
  AND je.is_posted = TRUE
  AND je.entry_date <= ${periodEnd}::date
```

Both queries must use `company_id` in the `WHERE` clause (tenant isolation).

**Headcount:** If `company_settings` has a `headcount` field use it; otherwise default to `1` (never divide by zero).

---

## Step 5 — `packAiSummaryService.ts`

**File:** `src/modules/accounting/services/afs/packAiSummaryService.ts`
**Max lines:** 300
**External:** Calls Anthropic Claude API (same pattern as `aiCommentaryService.ts`)
**No DB calls** — receives pre-fetched data objects

### Prompt Template

```typescript
export function buildExecutiveSummaryPrompt(params: {
  companyName: string;
  period: string;
  revenue: number;
  priorRevenue: number | null;
  budgetRevenue: number | null;
  grossMarginPct: number;
  priorGrossMarginPct: number | null;
  ebitda: number;
  closingCash: number;
  cashChange: number;
  debtorDays: number;
  priorDebtorDays: number | null;
  overdueDebtors: number;   // 60+ day debtors amount
  topRevenueAccount: string;
  revenueMovement: number;
  topExpenseAccount: string;
  expenseMovement: number;
  kpis: KpiResult[];
}): string
```

The prompt must match the structure in the spec (Section 7, AI Executive Summary):

```
You are a senior financial analyst. Write a concise 3-5 paragraph executive summary for {companyName} for {period}.

Key figures:
- Revenue: {revenue} (vs prior month: {priorRevenue}, vs budget: {budgetRevenue})
- Gross margin: {grossMarginPct}% (prior: {priorGrossMarginPct}%)
- EBITDA: {ebitda}
- Cash: {closingCash} (change: {cashChange})
- Debtor days: {debtorDays} (prior: {priorDebtorDays})
- 60+ day debtors: {overdueDebtors}
- Top revenue movement: {topRevenueAccount} {revenueMovement}
- Top expense movement: {topExpenseAccount} {expenseMovement}

Write in plain English. Be specific with numbers. Identify what drove the changes. Note any risks.
```

### Public Interface

```typescript
export async function generateExecutiveSummary(params: ExecutiveSummaryParams): Promise<string>

export async function generateSectionCommentary(params: {
  sectionType: string;
  sectionData: Record<string, unknown>;
  companyName: string;
  period: string;
  priorData: Record<string, unknown> | null;
}): Promise<string>
```

### Error Handling

- Catch Anthropic API errors: log with `log.error`, return a fallback string: `'AI summary unavailable for this period.'`
- Never throw from this service — caller continues with fallback.
- Timeout: 30 seconds. If exceeded, return fallback.

### Anthropic Client Pattern

Follow existing pattern in the codebase. Use `claude-3-5-haiku-20241022` for section commentary (fast, cost-efficient) and `claude-3-5-sonnet-20241022` for the executive summary (higher quality for the main narrative).

---

## Step 6 — `managementPackGeneratorService.ts`

**File:** `src/modules/accounting/services/afs/managementPackGeneratorService.ts`
**Max lines:** 300 (split into sub-functions if needed — each function ≤ 80 lines)
**DB:** Creates `afs_documents` and `afs_sections` rows

### Generation Flow

```
generateManagementPack(companyId, period, config)
  ├── 1. Idempotency check — abort if document already exists for (company_id, period, 'management_pack')
  ├── 2. Create AfsDocument row (status: 'draft')
  ├── 3. Create AfsSection rows for each enabled section (status: 'pending')
  ├── 4. Fetch all data in Promise.all:
  │       ├── incomeStatement (current + prior period)
  │       ├── balanceSheet (as at period end)
  │       ├── cashFlow
  │       ├── arAgeing
  │       ├── apAgeing
  │       ├── bankReconciliation
  │       └── kpiScorecard (via kpiScorecardService)
  ├── 5. For each enabled section:
  │       ├── renderSectionContent(sectionType, data)
  │       ├── UPDATE afs_sections SET data_snapshot = ..., content = ..., status = 'auto_generated'
  ├── 6. AI pass (in sequence, not parallel — rate limit safety):
  │       ├── generateExecutiveSummary (packAiSummaryService)
  │       ├── generateSectionCommentary for each enabled section
  │       └── UPDATE afs_sections SET ai_narrative = ..., status = 'ai_enhanced'
  ├── 7. UPDATE afs_documents SET status = reviewRequired ? 'draft' : 'signed_off'
  └── 8. If !reviewRequired: packDeliveryService.deliverPack(documentId)
```

### Idempotency

```sql
SELECT id FROM afs_documents
WHERE company_id = ${companyId}
  AND document_type = 'management_pack'
  AND period = ${period}
LIMIT 1
```

If a document exists, throw `new Error('Management pack already generated for period ' + period)`. Caller catches and logs — does not re-run.

### Section Content Renderers

Each section type maps to a renderer function `renderSectionContent(type, data)` that returns `NoteContent`. Implement as a switch statement:

```typescript
function renderSectionContent(
  sectionType: keyof ManagementPackSectionsEnabled,
  data: PackGenerationData,
): NoteContent {
  switch (sectionType) {
    case 'kpi_scorecard':     return renderKpiScorecard(data.kpis);
    case 'income_statement':  return renderIncomeStatement(data.incomeStatement);
    case 'balance_sheet':     return renderBalanceSheet(data.balanceSheet);
    // ... etc
    default:                  return { title: sectionType, blocks: [] };
  }
}
```

Each renderer returns `NoteContent` (from Plan 1's type definition).

### Public Interface

```typescript
export interface GeneratePackOptions {
  companyId: string;
  period: string;      // 'YYYY-MM'
  config: ManagementPackConfig;
  triggeredBy: 'cron' | 'manual';
}

export interface GeneratePackResult {
  documentId: string;
  sectionsGenerated: number;
  status: 'draft' | 'signed_off';
  deliveryScheduled: boolean;
}

export async function generateManagementPack(options: GeneratePackOptions): Promise<GeneratePackResult>
```

---

## Step 7 — `packDeliveryService.ts`

**File:** `src/modules/accounting/services/afs/packDeliveryService.ts`
**Max lines:** 300
**DB:** Reads `afs_documents`, `afs_sections`, `management_pack_configs`; writes delivery log to `afs_documents` metadata

### Delivery Flow

```
deliverPack(documentId, companyId)
  ├── 1. Fetch document + config + sections
  ├── 2. Build HTML email (top 5 KPI callouts by RAG severity)
  ├── 3. Trigger PDF generation (WeasyPrint sidecar — see note below)
  ├── 4. For each recipient in config.recipients:
  │       ├── if receives 'draft' | 'both': always send
  │       └── if receives 'final' | 'both': send when document.status = 'signed_off'
  ├── 5. Send email with PDF attachment (existing email infrastructure)
  ├── 6. Create portal notification (portal notification service)
  └── 7. UPDATE afs_documents SET metadata = jsonb_set(metadata, '{delivered_at}', NOW()::text::jsonb)
```

> **WeasyPrint note:** PDF generation via WeasyPrint Docker sidecar is planned in Plan 4. For Plan 7, call a `generatePackPdf(documentId)` stub that logs a warning and returns `null`. The email is sent without attachment until Plan 4 is complete. The stub must be clearly marked `// PARTIAL: PDF generation awaiting Plan 4 (WeasyPrint sidecar)`.

### Email Structure

```
Subject: {companyName} — Management Accounts {period}

Body:
  - Company logo (if available)
  - Period heading
  - KPI Dashboard: top 5 KPIs as coloured callout blocks (green/amber/red)
  - Revenue figure with trend arrow
  - Net profit figure with trend arrow
  - Cash position
  - CTA button: "View Full Report" → portal URL
  - Footer: firm contact details
```

### Public Interface

```typescript
export async function deliverPack(documentId: string, companyId: string): Promise<void>
export async function scheduleDelivery(documentId: string, companyId: string, deliverAt: Date): Promise<void>
```

---

## Step 8 — `packSchedulerService.ts`

**File:** `src/modules/accounting/services/afs/packSchedulerService.ts`
**Max lines:** 200
**DB:** Calls `managementPackConfigService.getCompaniesScheduledForDate`

### Purpose

Called by the cron API route at 06:00 SAST. Determines which companies should generate a management pack today and triggers generation for each.

### Logic

```typescript
export async function runDailyScheduler(): Promise<SchedulerRunResult> {
  const today = new Date();
  const dayOfMonth = today.getDate();
  const period = buildPriorMonthPeriod(today);  // e.g. if today = 2026-04-05, period = '2026-03'

  const companies = await getCompaniesScheduledForDate(dayOfMonth);

  const results = await Promise.allSettled(
    companies.map(({ companyId, config }) =>
      generateManagementPack({ companyId, period, config, triggeredBy: 'cron' })
    )
  );

  // Log each result — fulfilled or rejected — without throwing
  // Return summary
}
```

**Period calculation:**
- The pack is for the *prior* completed month.
- If `generation_day` is `5` and today is `2026-04-05`, the pack covers `2026-03`.
- Helper: `buildPriorMonthPeriod(date: Date): string` — subtract one month, format as `YYYY-MM`.

**Error isolation:**
- Use `Promise.allSettled` (not `Promise.all`) — one company's failure must not block others.
- Log each failure with `log.error({ companyId, error })`.

### Public Interface

```typescript
export interface SchedulerRunResult {
  date: string;
  dayOfMonth: number;
  period: string;
  companiesFound: number;
  succeeded: number;
  failed: number;
  errors: Array<{ companyId: string; error: string }>;
}

export async function runDailyScheduler(): Promise<SchedulerRunResult>
export function buildPriorMonthPeriod(date: Date): string   // exported for unit tests
```

---

## Step 9 — API Routes

### `pages/api/accounting/afs/management-pack-config.ts`

```typescript
// GET — get config for authenticated company
// PUT — upsert config for authenticated company
// Pattern: withCompany(withErrorHandler(handler as any))

import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { getManagementPackConfig, upsertManagementPackConfig } from '@/modules/accounting/services/afs/managementPackConfigService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as NextApiRequest & { companyId: string };

  if (req.method === 'GET') {
    const config = await getManagementPackConfig(companyId);
    return apiResponse.success(res, config);
  }

  if (req.method === 'PUT') {
    const config = await upsertManagementPackConfig(companyId, req.body);
    return apiResponse.success(res, config);
  }

  return apiResponse.methodNotAllowed(res);
}

export default withCompany(withErrorHandler(handler as any));
```

### `pages/api/accounting/afs/management-packs/index.ts`

```
GET /api/accounting/afs/management-packs
  Query params: ?year=2026 (optional — filter by year)
  Returns: AfsDocument[] where document_type = 'management_pack'
  Scoped by company_id from withCompany middleware
```

### `pages/api/accounting/afs/management-packs/[packId]/index.ts`

```
GET /api/accounting/afs/management-packs/:packId
  Returns: AfsDocument + all AfsSection records for the document
  Must validate document.company_id === req.companyId (IDOR guard)
```

### `pages/api/accounting/afs/management-packs/[packId]/deliver.ts`

```
POST /api/accounting/afs/management-packs/:packId/deliver
  Manually trigger delivery (for accountant after review)
  Validates: document.company_id === req.companyId
  Validates: document.status === 'signed_off' OR document.status === 'draft' (draft allowed for proof copy)
  Calls: packDeliveryService.deliverPack(packId, companyId)
```

### `pages/api/accounting/afs/generate.ts`

```
POST /api/accounting/afs/generate
  Body: { period: 'YYYY-MM', documentType: 'management_pack' }
  Validates period format with regex: /^\d{4}-\d{2}$/
  Validates documentType is 'management_pack' (Plan 7 scope only)
  Calls: managementPackGeneratorService.generateManagementPack(...)
  Returns: GeneratePackResult
```

### `pages/api/accounting/afs/cron/management-packs.ts`

```
GET /api/accounting/afs/cron/management-packs
  Called by system cron at 06:00 SAST (configured in cron job / Vercel cron)
  Auth: Validates X-Cron-Secret header === process.env.CRON_SECRET
  Does NOT use withCompany (system-level, not tenant-scoped)
  Calls: packSchedulerService.runDailyScheduler()
  Returns: SchedulerRunResult
  Responds 200 even on partial failures (individual company errors are logged, not surfaced)
```

**Cron secret validation:**

```typescript
const cronSecret = req.headers['x-cron-secret'];
if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
  return res.status(401).json({ error: 'Unauthorized' });
}
```

---

## Step 10 — Page: `pages/accounting/afs/management-packs.tsx`

**File:** `pages/accounting/afs/management-packs.tsx`
**Pattern:** `/frontend-design` plugin — bold, distinctive, non-generic
**Max lines:** 300 (split into sub-components if needed)

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Management Packs                          [Generate for March ▼]│
├─────────────────────────────────────────────────────────────────┤
│  [Configuration tab]  [Pack History tab]                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  CONFIGURATION TAB:                                             │
│  ┌── Scheduler Settings ──────────────────────────────────┐    │
│  │  Enable automated packs  [toggle]                       │    │
│  │  Generate on day:  [5 ▼]  of each month                │    │
│  │  Review required:  [yes ▼]                              │    │
│  │  Pack style:  [Executive ▼]                             │    │
│  │  Comparison:  [Prior month ▼]                           │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌── Sections ─────────────────────────────────────────────┐    │
│  │  [grid of 16 toggle switches with labels]               │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌── Recipients ───────────────────────────────────────────┐    │
│  │  [email] [name] [role ▼] [receives ▼]  [+ Add]          │    │
│  └─────────────────────────────────────────────────────────┘    │
│  [Save Configuration]                                           │
│                                                                 │
│  PACK HISTORY TAB:                                              │
│  ┌── 2026-03 — March 2026 ─────────────────────── [signed_off]─┐│
│  │  Generated: 5 Apr 2026  |  Delivered: 8 Apr 2026            ││
│  │  KPIs: Revenue ▲12%  Margin 38%  Cash R450k  Debtors 28d   ││
│  │  [View] [Re-deliver] [Download PDF]                         ││
│  └──────────────────────────────────────────────────────────────┘│
│  ┌── 2026-02 — February 2026 ──────────────────── [draft] ────┐ │
│  │  ...                                                         │ │
│  └──────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Data Fetching

- On mount: `GET /api/accounting/afs/management-pack-config` + `GET /api/accounting/afs/management-packs`
- Config save: `PUT /api/accounting/afs/management-pack-config`
- Manual generate: `POST /api/accounting/afs/generate` with `{ period, documentType: 'management_pack' }`
- Manual deliver: `POST /api/accounting/afs/management-packs/:packId/deliver`

### Nav Config Update

After creating the page, update `src/components/layout/accountingNavConfig.ts`:

```typescript
// Add to the AFS group (or create one if Plan 1 hasn't yet):
{
  label: 'Management Packs',
  href: '/accounting/afs/management-packs',
  icon: 'BarChart3',
}
```

---

## Step 11 — Tests

### `tests/unit/services/afs/kpiScorecardService.test.ts`

Tests target the **pure** `calculateKpis` function — no DB mocks needed for the core logic.

```typescript
import { describe, it, expect } from 'vitest';
import { calculateKpis } from '@/modules/accounting/services/afs/kpiScorecardService';
import type { FinancialSnapshot, RagThresholds } from '@/modules/accounting/services/afs/afsTypes';

const DEFAULT_THRESHOLDS: RagThresholds = {
  currentRatio:       { green: 1.5,  amber: 1.0 },
  quickRatio:         { green: 1.0,  amber: 0.7 },
  grossMarginPct:     { green: 40,   amber: 20  },
  netProfitMarginPct: { green: 10,   amber: 5   },
  debtorDays:         { green: 30,   amber: 60  },
  debtToEquity:       { green: 1.0,  amber: 2.0 },
};

const BASE_SNAPSHOT: FinancialSnapshot = {
  revenue: 1_000_000,
  cogs: 600_000,
  grossProfit: 400_000,
  ebitda: 150_000,
  ebit: 120_000,
  netProfit: 80_000,
  interestExpense: 30_000,
  currentAssets: 500_000,
  currentLiabilities: 300_000,
  inventory: 100_000,
  tradeReceivables: 150_000,
  tradePayables: 120_000,
  totalDebt: 400_000,
  totalEquity: 600_000,
  openingCash: 200_000,
  closingCash: 250_000,
  headcount: 10,
  daysInPeriod: 31,
};
```

**Test cases to implement:**

1. `grossMarginPct` calculated correctly as `(400000/1000000)*100 = 40` → RAG `green`
2. `currentRatio` = `500000/300000 = 1.667` → RAG `green`
3. `debtorDays` = `(150000/1000000)*30 = 4.5` → RAG `green`
4. Low gross margin (< 20%) → RAG `red`
5. Border case: `currentRatio` exactly `1.5` → `green` (threshold is `>=`)
6. `revenueGrowthPct` calculated correctly with prior snapshot
7. `revenueGrowthPct` = `null` trend when no prior snapshot
8. `cashBurnRate` only appears when cash declined (closing < opening)
9. `revenuePerEmployee` = `1000000 / 10 = 100000`
10. Trend: `up` when value increased vs prior; `down` when decreased; `flat` when < 1% change
11. All 14 KPIs present in output array
12. No division-by-zero when `currentLiabilities = 0` (returns `Infinity` clamped to a safe value or `null`)

### `tests/unit/services/afs/managementPackConfigService.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  getManagementPackConfig,
  upsertManagementPackConfig,
  getCompaniesScheduledForDate,
} from '@/modules/accounting/services/afs/managementPackConfigService';
```

**Test cases to implement:**

1. `getManagementPackConfig` — returns mapped camelCase config when row exists
2. `getManagementPackConfig` — returns default config when no row (empty array from DB)
3. `upsertManagementPackConfig` — calls SQL with correct `ON CONFLICT` upsert
4. `upsertManagementPackConfig` — returns updated config after upsert
5. `getCompaniesScheduledForDate` — returns only enabled companies for day 5
6. `getCompaniesScheduledForDate` — returns empty array when no companies scheduled
7. `getManagementPackConfig` — never returns data across tenants (always `WHERE company_id = ${companyId}`)
8. Date fields (`createdAt`, `updatedAt`) handled as both `Date` object and ISO string

---

## Execution Order

1. Run migration: `scripts/migrations/sql/339_management_pack_configs.sql`
2. Verify/add types to `afsTypes.ts`
3. Implement `kpiScorecardService.ts` (pure functions first, then DB wrapper)
4. Write `kpiScorecardService.test.ts` — all 12 test cases green
5. Implement `managementPackConfigService.ts`
6. Write `managementPackConfigService.test.ts` — all 8 test cases green
7. Implement `packAiSummaryService.ts`
8. Implement `managementPackGeneratorService.ts`
9. Implement `packDeliveryService.ts`
10. Implement `packSchedulerService.ts`
11. Implement all 6 API routes
12. Implement `management-packs.tsx` page
13. Update `accountingNavConfig.ts`
14. Run `bun run test:unit` — all tests green
15. Run `bunx tsc --noEmit` — zero type errors

---

## Cross-Cutting Rules (apply to every file)

- Every DB query includes `company_id` in `WHERE` — no exceptions.
- No `console.log` — use `log.info`, `log.error`, `log.warn` from `@/lib/logger`.
- No empty `catch` blocks — always log the error.
- All route handlers: `withCompany(withErrorHandler(handler as any))`.
- All responses: `apiResponse.success()`, `.badRequest()`, `.notFound()`.
- Use `sql` tagged template from `@/lib/neon` — never string concatenation.
- Every file max 300 lines.
- 100% TypeScript — no `any` except Next.js required patterns.

---

## Environment Variables Required

```bash
CRON_SECRET=<random-secret>     # Validates cron endpoint — add to .env.local and Vercel
```

---

## Out of Scope for Plan 7

- PDF generation via WeasyPrint (Plan 4)
- DOCX export (Plan 4)
- Client portal delivery page (Plan 6)
- Budget import / budget vs actual (separate feature)
- 13-week cash flow forecast (separate feature)
- E-signature flow (Plan 6 + Signum)
- IFRS compliance checker (Plan 8)

---

*Plan 7 written: 2026-04-16 | Spec: Section 7 — Monthly Management Pack Scheduler*
