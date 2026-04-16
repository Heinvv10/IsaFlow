# Plan 7 — Monthly Management Pack Scheduler

**Date:** 2026-04-16
**Spec:** `docs/superpowers/specs/2026-04-16-financial-reporting-afs-design.md` (Section 7)
**Status:** Ready for implementation
**Prerequisites:** Plan 1 (Document Engine Foundation) and Plan 3 (Primary Statements) complete.
**Types source:** `@/modules/accounting/services/afs/afsTypes.ts` (from Plan 1)

---

## Overview

This plan implements the automated Monthly Management Pack Scheduler for ISaFlow. Each pack is an `AfsDocument` with `document_type: 'management_pack'`. The system generates packs on a per-company schedule, calculates KPIs with RAG traffic lights, generates an AI executive summary, and delivers the pack to configured recipients.

---

## File Map

```
scripts/migrations/sql/
  (337_management_pack_configs.sql already exists — no new migration needed)

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
  generate-pack.ts                           (POST — manual trigger)
  cron/
    management-packs.ts                      (GET — 06:00 SAST cron)

pages/accounting/afs/
  management-packs.tsx                       (list + config page)

tests/unit/services/afs/
  kpiScorecardService.test.ts
  managementPackConfigService.test.ts
```

---

## Step 1 — Migration: Already Done

Migration `337_management_pack_configs.sql` already creates the `management_pack_configs` table with the correct schema:

- `delivery_day` (integer, 1–28) — matches `afsTypes.ts` `ManagementPackConfig.deliveryDay`
- `pack_style` default is `'detailed'`
- `sections_enabled` default is `'{}'::JSONB` (empty object; the service layer applies defaults)
- `recipients` default is `'[]'::JSONB`
- No `rag_thresholds` column exists — RAG thresholds will use hardcoded defaults in the KPI service, with per-company overrides stored in a future migration if needed

**No new migration is needed for Plan 7.**

> NOTE: The existing table has no `rag_thresholds` column. The `kpiScorecardService` will use hardcoded South African SME defaults. If per-company RAG threshold configuration is needed later, add an ALTER TABLE migration at that time.

---

## Step 2 — Type Definitions (already in `afsTypes.ts` from Plan 1)

The following interfaces already exist in `@/modules/accounting/services/afs/afsTypes.ts` and must NOT be duplicated:

```typescript
// Already defined in afsTypes.ts:
export type PackStyle = 'executive' | 'detailed' | 'board';

export interface PackRecipient {
  email: string;
  role: string;                               // free-form string, not a union type
  receives: 'draft' | 'final' | 'both';
}

export interface ManagementPackConfig {
  id: string;
  companyId: string;
  enabled: boolean;
  generationDay: number;
  deliveryDay: number;                        // NOT deliveryOffset — this is a day-of-month
  reviewRequired: boolean;
  sectionsEnabled: Record<string, boolean>;   // generic, NOT a specific union
  recipients: PackRecipient[];
  packStyle: PackStyle;
  comparisonMode: 'prior_month' | 'prior_year' | 'budget' | 'all_three';
  currencyDisplay: 'full' | 'thousands' | 'millions';
}
```

**Add the following types** to `afsTypes.ts` (append at the end, before the closing `// ── API response shapes ──` section):

```typescript
// ── KPI Scorecard ───────────────────────────────────────────────────────────

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
getManagementPackConfig(companyId: string): Promise<ManagementPackConfig>
upsertManagementPackConfig(companyId: string, updates: Partial<ManagementPackConfig>): Promise<ManagementPackConfig>
getCompaniesScheduledForDate(dayOfMonth: number): Promise<Array<{ companyId: string; config: ManagementPackConfig }>>
```

### Implementation Notes

**`getManagementPackConfig`:**
- `SELECT * FROM management_pack_configs WHERE company_id = ${companyId}::UUID`
- If no row, return the default config (do not insert; insert happens on first explicit PUT).
- Map snake_case DB row to camelCase `ManagementPackConfig`. Handle both `Date` and `string` for timestamps.

**`upsertManagementPackConfig`:**
- Use `INSERT ... ON CONFLICT (company_id) DO UPDATE SET ...` pattern.
- Only update fields that are provided in `updates` (partial update). Merge `sectionsEnabled`, `recipients` as full JSONB replace (not deep merge — caller sends complete object).
- Always set `updated_at = NOW()`.

**`getCompaniesScheduledForDate`:**
- `SELECT * FROM management_pack_configs WHERE enabled = TRUE AND generation_day = ${dayOfMonth}`
- Called by the cron job to find which companies generate today.
- Returns array of `{ companyId, config }`.

### Skeleton

```typescript
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ManagementPackConfig } from './afsTypes';

type Row = DbRow;

const DEFAULT_SECTIONS_ENABLED: Record<string, boolean> = {
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
};

const DEFAULT_CONFIG: Omit<ManagementPackConfig, 'id' | 'companyId'> = {
  enabled: false,
  generationDay: 5,
  deliveryDay: 10,
  reviewRequired: true,
  sectionsEnabled: DEFAULT_SECTIONS_ENABLED,
  recipients: [],
  packStyle: 'detailed',
  comparisonMode: 'prior_month',
  currencyDisplay: 'full',
};

function mapRow(row: Row): ManagementPackConfig {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    enabled: Boolean(row.enabled),
    generationDay: Number(row.generation_day),
    deliveryDay: Number(row.delivery_day),
    reviewRequired: Boolean(row.review_required),
    sectionsEnabled: (row.sections_enabled as Record<string, boolean>) ?? DEFAULT_SECTIONS_ENABLED,
    recipients: (row.recipients as ManagementPackConfig['recipients']) ?? [],
    packStyle: String(row.pack_style) as ManagementPackConfig['packStyle'],
    comparisonMode: String(row.comparison_mode) as ManagementPackConfig['comparisonMode'],
    currencyDisplay: String(row.currency_display) as ManagementPackConfig['currencyDisplay'],
  };
}

export async function getManagementPackConfig(companyId: string): Promise<ManagementPackConfig> {
  const rows = (await sql`
    SELECT * FROM management_pack_configs
    WHERE company_id = ${companyId}::UUID
  `) as Row[];

  if (rows.length === 0) {
    log.info('No config found, returning defaults', { companyId }, 'managementPackConfigService');
    return { id: '', companyId, ...DEFAULT_CONFIG };
  }

  return mapRow(rows[0]);
}

export async function upsertManagementPackConfig(
  companyId: string,
  updates: Partial<ManagementPackConfig>,
): Promise<ManagementPackConfig> {
  const current = await getManagementPackConfig(companyId);
  const merged = { ...current, ...updates };

  const rows = (await sql`
    INSERT INTO management_pack_configs (
      company_id, enabled, generation_day, delivery_day,
      review_required, sections_enabled, recipients,
      pack_style, comparison_mode, currency_display, updated_at
    ) VALUES (
      ${companyId}::UUID,
      ${merged.enabled},
      ${merged.generationDay},
      ${merged.deliveryDay},
      ${merged.reviewRequired},
      ${JSON.stringify(merged.sectionsEnabled)}::jsonb,
      ${JSON.stringify(merged.recipients)}::jsonb,
      ${merged.packStyle},
      ${merged.comparisonMode},
      ${merged.currencyDisplay},
      NOW()
    )
    ON CONFLICT (company_id) DO UPDATE SET
      enabled          = EXCLUDED.enabled,
      generation_day   = EXCLUDED.generation_day,
      delivery_day     = EXCLUDED.delivery_day,
      review_required  = EXCLUDED.review_required,
      sections_enabled = EXCLUDED.sections_enabled,
      recipients       = EXCLUDED.recipients,
      pack_style       = EXCLUDED.pack_style,
      comparison_mode  = EXCLUDED.comparison_mode,
      currency_display = EXCLUDED.currency_display,
      updated_at       = NOW()
    RETURNING *
  `) as Row[];

  log.info('Config upserted', { companyId }, 'managementPackConfigService');
  return mapRow(rows[0]);
}

export async function getCompaniesScheduledForDate(
  dayOfMonth: number,
): Promise<Array<{ companyId: string; config: ManagementPackConfig }>> {
  const rows = (await sql`
    SELECT * FROM management_pack_configs
    WHERE enabled = TRUE AND generation_day = ${dayOfMonth}
  `) as Row[];

  return rows.map((row) => ({
    companyId: String(row.company_id),
    config: mapRow(row),
  }));
}
```

---

## Step 4 — `kpiScorecardService.ts`

**File:** `src/modules/accounting/services/afs/kpiScorecardService.ts`
**Max lines:** 300
**DB:** Two SQL queries (income statement aggregates, balance sheet aggregates for the period + prior period). Pure calculation functions are exported for unit testing without DB mocks.
**Dependency:** Accepts pre-fetched financial snapshot objects — does NOT call other service modules.

### Important Schema Notes

The following tables and columns are the ACTUAL schema (verified from migrations):

- **Table names:** `gl_accounts` (NOT `chart_of_accounts`), `gl_journal_entries`, `gl_journal_lines`
- **Join pattern:** `gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id JOIN gl_accounts ga ON ga.id = jl.gl_account_id`
- **Posted filter:** `je.status = 'posted'` (NOT `je.is_posted = TRUE`)
- **Company scoping:** ALL three tables have `company_id` — always filter on all three: `AND je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID AND ga.company_id = ${companyId}::UUID`
- **Account subtypes present in seed data:** `bank`, `receivable`, `payable`, `vat_input`, `vat_output`, `fixed_asset`, `accumulated_depreciation`, `equity`, `retained_earnings`, `default_revenue`, `revenue`, `other_income`, `default_expense`, `operating_expense`, `admin_expense`, `depreciation_expense`, `cost_of_sales` (added via migration 204)
- **NO `inventory` account_subtype** in default chart — inventory accounts are managed through the products module, not GL subtypes. KPIs requiring inventory must handle `NULL` gracefully.
- **NO `headcount`** column exists anywhere — removed from KPI list (see below).
- **NO `interest_expense` account_subtype** in default chart — interest coverage KPI deferred.

### The 11 KPIs (adjusted from spec)

Removed from original 14:
- `revenuePerEmployee` — no headcount data exists; deferred until companies table gets an employee count field
- `interestCoverage` — no `interest_expense` account_subtype in default chart; unreliable
- `inventoryDays` — no `inventory` account_subtype in default chart; deferred

Adjusted:
- `cashConversionCycle` simplified to `debtorDays - creditorDays` (no inventoryDays component)

| # | Key | Formula | Good direction |
|---|-----|---------|----------------|
| 1 | `grossMarginPct` | `grossProfit / revenue * 100` | Higher |
| 2 | `ebitdaMarginPct` | `ebitda / revenue * 100` | Higher |
| 3 | `netProfitMarginPct` | `netProfit / revenue * 100` | Higher |
| 4 | `currentRatio` | `currentAssets / currentLiabilities` | Higher |
| 5 | `quickRatio` | `(currentAssets - inventory) / currentLiabilities` | Higher |
| 6 | `debtorDays` | `(tradeReceivables / revenue) * daysInPeriod` | Lower |
| 7 | `creditorDays` | `(tradePayables / cogs) * daysInPeriod` | Lower |
| 8 | `cashConversionCycle` | `debtorDays - creditorDays` | Lower |
| 9 | `debtToEquity` | `totalDebt / totalEquity` | Lower |
| 10 | `revenueGrowthPct` | `(currentRevenue - priorRevenue) / priorRevenue * 100` | Higher |
| 11 | `cashBurnRate` | `(openingCash - closingCash) / daysInPeriod * 30` (only if cash declined) | Lower |

### RAG Thresholds (hardcoded defaults — no DB column)

```typescript
export const DEFAULT_RAG_THRESHOLDS: Record<string, { green: number; amber: number; lowerIsBetter: boolean }> = {
  grossMarginPct:     { green: 40,   amber: 20,   lowerIsBetter: false },
  ebitdaMarginPct:    { green: 15,   amber: 5,    lowerIsBetter: false },
  netProfitMarginPct: { green: 10,   amber: 5,    lowerIsBetter: false },
  currentRatio:       { green: 1.5,  amber: 1.0,  lowerIsBetter: false },
  quickRatio:         { green: 1.0,  amber: 0.7,  lowerIsBetter: false },
  debtorDays:         { green: 30,   amber: 60,   lowerIsBetter: true  },
  creditorDays:       { green: 45,   amber: 75,   lowerIsBetter: true  },
  cashConversionCycle:{ green: 30,   amber: 60,   lowerIsBetter: true  },
  debtToEquity:       { green: 1.0,  amber: 2.0,  lowerIsBetter: true  },
  revenueGrowthPct:   { green: 10,   amber: 0,    lowerIsBetter: false },
  cashBurnRate:       { green: 0,    amber: 50000, lowerIsBetter: true },
};
```

### Trend Calculation

Trend is derived by comparing `value` to `priorValue`:
- `priorValue` is `null` → `'flat'`
- `Math.abs((value - priorValue) / priorValue) < 0.01` → `'flat'`
- `value > priorValue` → `'up'`
- `value < priorValue` → `'down'`

### Public Interface

```typescript
export interface FinancialSnapshot {
  revenue: number;
  cogs: number;
  grossProfit: number;
  ebitda: number;
  ebit: number;
  netProfit: number;
  currentAssets: number;
  currentLiabilities: number;
  inventory: number;          // may be 0 if no inventory accounts
  tradeReceivables: number;
  tradePayables: number;
  totalDebt: number;
  totalEquity: number;
  openingCash: number;
  closingCash: number;
  daysInPeriod: number;       // 28, 29, 30, or 31
}

export type RagThresholds = Record<string, { green: number; amber: number; lowerIsBetter: boolean }>;

// Pure function — no DB calls — for unit testing
export function calculateKpis(
  current: FinancialSnapshot,
  prior: FinancialSnapshot | null,
  ragThresholds: RagThresholds,
): KpiResult[]

// DB-aware entry point
export async function getKpiScorecard(
  companyId: string,
  period: string,           // 'YYYY-MM'
  ragThresholds?: RagThresholds,
): Promise<KpiScorecard>
```

### `getKpiScorecard` DB Queries

The function fetches two GL aggregates in `Promise.all`:

**Query 1 — Current period income/expense aggregates:**
```sql
SELECT
  COALESCE(SUM(
    CASE WHEN ga.account_type = 'revenue'
      THEN jl.credit - jl.debit ELSE 0 END
  ), 0) AS revenue,
  COALESCE(SUM(
    CASE WHEN ga.account_subtype = 'cost_of_sales'
      THEN jl.debit - jl.credit ELSE 0 END
  ), 0) AS cogs,
  COALESCE(SUM(
    CASE WHEN ga.account_type = 'revenue'
      THEN jl.credit - jl.debit
      WHEN ga.account_type = 'expense'
      THEN -(jl.debit - jl.credit) ELSE 0 END
  ), 0) AS net_profit,
  COALESCE(SUM(
    CASE WHEN ga.account_type = 'expense' AND ga.account_subtype = 'depreciation_expense'
      THEN jl.debit - jl.credit ELSE 0 END
  ), 0) AS depreciation
FROM gl_journal_lines jl
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
JOIN gl_accounts ga ON ga.id = jl.gl_account_id
WHERE je.company_id = ${companyId}::UUID
  AND jl.company_id = ${companyId}::UUID
  AND ga.company_id = ${companyId}::UUID
  AND je.status = 'posted'
  AND je.entry_date >= ${periodStart}::date
  AND je.entry_date <= ${periodEnd}::date
```

Then derive:
- `grossProfit = revenue - cogs`
- `ebit = netProfit` (all operating income/expenses)
- `ebitda = ebit + depreciation`

**Query 2 — Balance sheet snapshot (cumulative as at period end):**
```sql
SELECT
  COALESCE(SUM(CASE
    WHEN ga.account_type = 'asset' AND ga.account_subtype NOT IN ('fixed_asset', 'accumulated_depreciation')
    THEN jl.debit - jl.credit ELSE 0 END
  ), 0) AS current_assets,
  COALESCE(SUM(CASE
    WHEN ga.account_type = 'liability'
      AND ga.account_subtype NOT IN ('vat_output')
    THEN jl.credit - jl.debit ELSE 0 END
  ), 0) AS current_liabilities,
  COALESCE(SUM(CASE
    WHEN ga.account_subtype = 'receivable'
    THEN jl.debit - jl.credit ELSE 0 END
  ), 0) AS trade_receivables,
  COALESCE(SUM(CASE
    WHEN ga.account_subtype = 'payable'
    THEN jl.credit - jl.debit ELSE 0 END
  ), 0) AS trade_payables,
  COALESCE(SUM(CASE
    WHEN ga.account_type = 'liability'
    THEN jl.credit - jl.debit ELSE 0 END
  ), 0) AS total_debt,
  COALESCE(SUM(CASE
    WHEN ga.account_type = 'equity'
    THEN jl.credit - jl.debit ELSE 0 END
  ), 0) AS total_equity
FROM gl_journal_lines jl
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
JOIN gl_accounts ga ON ga.id = jl.gl_account_id
WHERE je.company_id = ${companyId}::UUID
  AND jl.company_id = ${companyId}::UUID
  AND ga.company_id = ${companyId}::UUID
  AND je.status = 'posted'
  AND je.entry_date <= ${periodEnd}::date
```

**Query 3 — Cash balances (opening + closing):**

Uses the same pattern as `cashFlowDirectService.ts` `fetchOpeningCash`:

```sql
-- Opening cash (all posted entries BEFORE period start)
SELECT COALESCE(SUM(
  CASE WHEN ga.normal_balance = 'debit'
    THEN jl.debit - jl.credit
    ELSE jl.credit - jl.debit END
), 0)::numeric AS balance
FROM gl_journal_lines jl
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
JOIN gl_accounts ga ON ga.id = jl.gl_account_id
WHERE ga.account_subtype = 'bank'
  AND je.company_id = ${companyId}::UUID
  AND jl.company_id = ${companyId}::UUID
  AND ga.company_id = ${companyId}::UUID
  AND je.status = 'posted'
  AND je.entry_date < ${periodStart}::date

-- Closing cash (all posted entries UP TO period end)
-- Same query but: AND je.entry_date <= ${periodEnd}::date
```

**Inventory:** Set to `0` — no `inventory` account_subtype exists in the default chart. If a company creates custom inventory GL accounts, those would need a subtype mapping. For now, `quickRatio` equals `currentRatio`.

**Division safety:** If any denominator is `0`, the KPI value is `0` and RAG is `'red'`. Never return `Infinity` or `NaN`.

---

## Step 5 — `packAiSummaryService.ts`

**File:** `src/modules/accounting/services/afs/packAiSummaryService.ts`
**Max lines:** 300
**External:** Calls Anthropic Claude API (same pattern as `noteAiService.ts`)
**No DB calls** — receives pre-fetched data objects

### AI Client Pattern (from `noteAiService.ts`)

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { log } from '@/lib/logger';
import type { KpiResult } from './afsTypes';

const client = new Anthropic();
```

### Prompt Template

```typescript
export interface ExecutiveSummaryParams {
  companyName: string;
  period: string;
  revenue: number;
  priorRevenue: number | null;
  grossMarginPct: number;
  priorGrossMarginPct: number | null;
  ebitda: number;
  closingCash: number;
  cashChange: number;
  debtorDays: number;
  priorDebtorDays: number | null;
  overdueDebtors: number;
  topRevenueAccount: string;
  revenueMovement: number;
  topExpenseAccount: string;
  expenseMovement: number;
  kpis: KpiResult[];
}

export function buildExecutiveSummaryPrompt(params: ExecutiveSummaryParams): string {
  return `You are a senior financial analyst. Write a concise 3-5 paragraph executive summary for ${params.companyName} for ${params.period}.

Key figures:
- Revenue: R${params.revenue.toLocaleString()} (prior month: ${params.priorRevenue !== null ? `R${params.priorRevenue.toLocaleString()}` : 'N/A'})
- Gross margin: ${params.grossMarginPct.toFixed(1)}% (prior: ${params.priorGrossMarginPct !== null ? `${params.priorGrossMarginPct.toFixed(1)}%` : 'N/A'})
- EBITDA: R${params.ebitda.toLocaleString()}
- Cash: R${params.closingCash.toLocaleString()} (change: R${params.cashChange.toLocaleString()})
- Debtor days: ${params.debtorDays.toFixed(0)} (prior: ${params.priorDebtorDays !== null ? params.priorDebtorDays.toFixed(0) : 'N/A'})
- 60+ day debtors: R${params.overdueDebtors.toLocaleString()}
- Top revenue movement: ${params.topRevenueAccount} R${params.revenueMovement.toLocaleString()}
- Top expense movement: ${params.topExpenseAccount} R${params.expenseMovement.toLocaleString()}

KPI Traffic Lights:
${params.kpis.map(k => `- ${k.label}: ${k.formatted} (${k.rag})`).join('\n')}

Write in plain English. Be specific with numbers. Identify what drove the changes. Note any risks. Do not reference budget comparisons.`;
}
```

> NOTE: No `budgetRevenue` parameter — budget infrastructure does not exist yet. The prompt explicitly says "Do not reference budget comparisons."

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
- Timeout: 30 seconds via `AbortController`. If exceeded, return fallback.

### Model Selection

Follow `noteAiService.ts` pattern:
- Executive summary: `claude-sonnet-4-6` (higher quality for the main narrative)
- Section commentary: `claude-haiku-4-5` (fast, cost-efficient for individual sections)

```typescript
export async function generateExecutiveSummary(params: ExecutiveSummaryParams): Promise<string> {
  const prompt = buildExecutiveSummaryPrompt(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }, { signal: controller.signal });

    return response.content[0]?.type === 'text' ? response.content[0].text : '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Executive summary generation failed', { period: params.period, error: message }, 'packAiSummaryService');
    return 'AI summary unavailable for this period.';
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateSectionCommentary(params: {
  sectionType: string;
  sectionData: Record<string, unknown>;
  companyName: string;
  period: string;
  priorData: Record<string, unknown> | null;
}): Promise<string> {
  const prompt = `You are a senior financial analyst. Write a concise 1-2 paragraph commentary for the ${params.sectionType} section of ${params.companyName}'s management accounts for ${params.period}.

Data:
${JSON.stringify(params.sectionData, null, 2)}

${params.priorData ? `Prior period data:\n${JSON.stringify(params.priorData, null, 2)}` : 'No prior period data available.'}

Be specific with numbers. Identify key movements and risks. Do not reference budgets.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content[0]?.type === 'text' ? response.content[0].text : '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Section commentary failed', { sectionType: params.sectionType, error: message }, 'packAiSummaryService');
    return 'AI commentary unavailable for this section.';
  }
}
```

---

## Step 6 — `managementPackGeneratorService.ts`

**File:** `src/modules/accounting/services/afs/managementPackGeneratorService.ts`
**Max lines:** 300 (split into sub-functions if needed — each function <= 80 lines)
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
WHERE company_id = ${companyId}::UUID
  AND document_type = 'management_pack'
  AND period = ${period}
LIMIT 1
```

If a document exists, throw `new Error('Management pack already generated for period ' + period)`. Caller catches and logs — does not re-run.

### Section Content Renderers

Each section type maps to a renderer function `renderSectionContent(type, data)` that returns `NoteContent`:

```typescript
import type { NoteContent, ManagementPackConfig } from './afsTypes';

interface PackGenerationData {
  kpis: KpiResult[];
  incomeStatement: Record<string, unknown>;
  balanceSheet: Record<string, unknown>;
  cashFlow: Record<string, unknown>;
  arAgeing: Record<string, unknown>;
  apAgeing: Record<string, unknown>;
  bankRecon: Record<string, unknown>;
  priorIncomeStatement: Record<string, unknown> | null;
}

function renderSectionContent(
  sectionType: string,
  data: PackGenerationData,
): NoteContent {
  switch (sectionType) {
    case 'kpi_scorecard':         return renderKpiScorecard(data.kpis);
    case 'income_statement':      return renderIncomeStatement(data.incomeStatement);
    case 'balance_sheet':         return renderBalanceSheet(data.balanceSheet);
    case 'cash_flow':             return renderCashFlow(data.cashFlow);
    case 'debtors_ageing':        return renderAgeing('Debtors', data.arAgeing);
    case 'creditors_ageing':      return renderAgeing('Creditors', data.apAgeing);
    case 'bank_reconciliation':   return renderBankRecon(data.bankRecon);
    default:                      return { title: sectionType, blocks: [] };
  }
}
```

Each renderer returns `NoteContent` (from Plan 1's type definition).

### Data Fetch Queries

All financial data queries follow the same JOIN pattern established in Step 4:

```typescript
// Pattern for ALL GL queries in this service:
const rows = (await sql`
  SELECT ...
  FROM gl_journal_lines jl
  JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
  JOIN gl_accounts ga ON ga.id = jl.gl_account_id
  WHERE je.company_id = ${companyId}::UUID
    AND jl.company_id = ${companyId}::UUID
    AND ga.company_id = ${companyId}::UUID
    AND je.status = 'posted'
    AND je.entry_date >= ${periodStart}::date
    AND je.entry_date <= ${periodEnd}::date
`) as Row[];
```

**Top revenue/expense movers** (for AI summary input):

```sql
SELECT
  ga.account_name,
  ga.account_type,
  SUM(CASE WHEN ga.account_type = 'revenue'
    THEN jl.credit - jl.debit
    ELSE jl.debit - jl.credit END) AS amount
FROM gl_journal_lines jl
JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
JOIN gl_accounts ga ON ga.id = jl.gl_account_id
WHERE je.company_id = ${companyId}::UUID
  AND jl.company_id = ${companyId}::UUID
  AND ga.company_id = ${companyId}::UUID
  AND je.status = 'posted'
  AND je.entry_date >= ${periodStart}::date
  AND je.entry_date <= ${periodEnd}::date
  AND ga.account_type IN ('revenue', 'expense')
GROUP BY ga.id, ga.account_name, ga.account_type
ORDER BY ABS(SUM(CASE WHEN ga.account_type = 'revenue'
    THEN jl.credit - jl.debit
    ELSE jl.debit - jl.credit END)) DESC
LIMIT 1
```

Run twice — once filtered to `ga.account_type = 'revenue'`, once to `ga.account_type = 'expense'`.

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
  │      SELECT * FROM afs_documents WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  │      SELECT * FROM afs_sections WHERE document_id = ${documentId}::UUID AND company_id = ${companyId}::UUID
  │      SELECT * FROM management_pack_configs WHERE company_id = ${companyId}::UUID
  ├── 2. Build HTML email (top 5 KPI callouts by RAG severity)
  ├── 3. Trigger PDF generation (WeasyPrint sidecar — see note below)
  ├── 4. For each recipient in config.recipients:
  │       ├── if receives 'draft' | 'both': always send
  │       └── if receives 'final' | 'both': send when document.status = 'signed_off'
  ├── 5. Send email with PDF attachment (existing email infrastructure)
  ├── 6. Create portal notification (portal notification service)
  └── 7. UPDATE afs_documents
  │      SET updated_at = NOW()
  │      WHERE id = ${documentId}::UUID AND company_id = ${companyId}::UUID
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
import { log } from '@/lib/logger';
import { getCompaniesScheduledForDate } from './managementPackConfigService';
import { generateManagementPack } from './managementPackGeneratorService';

export interface SchedulerRunResult {
  date: string;
  dayOfMonth: number;
  period: string;
  companiesFound: number;
  succeeded: number;
  failed: number;
  errors: Array<{ companyId: string; error: string }>;
}

export function buildPriorMonthPeriod(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed — January is 0
  if (month === 0) {
    return `${year - 1}-12`;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}

export async function runDailyScheduler(): Promise<SchedulerRunResult> {
  const today = new Date();
  const dayOfMonth = today.getDate();
  const period = buildPriorMonthPeriod(today);

  log.info('Running daily pack scheduler', { dayOfMonth, period }, 'packSchedulerService');

  const companies = await getCompaniesScheduledForDate(dayOfMonth);

  const results = await Promise.allSettled(
    companies.map(({ companyId, config }) =>
      generateManagementPack({ companyId, period, config, triggeredBy: 'cron' })
    )
  );

  const errors: Array<{ companyId: string; error: string }> = [];
  let succeeded = 0;
  let failed = 0;

  results.forEach((result, idx) => {
    const companyId = companies[idx].companyId;
    if (result.status === 'fulfilled') {
      succeeded++;
      log.info('Pack generated', { companyId, period, documentId: result.value.documentId }, 'packSchedulerService');
    } else {
      failed++;
      const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ companyId, error: errorMsg });
      log.error('Pack generation failed', { companyId, period, error: errorMsg }, 'packSchedulerService');
    }
  });

  const summary: SchedulerRunResult = {
    date: today.toISOString().slice(0, 10),
    dayOfMonth,
    period,
    companiesFound: companies.length,
    succeeded,
    failed,
    errors,
  };

  log.info('Scheduler run complete', summary, 'packSchedulerService');
  return summary;
}
```

**Period calculation:**
- The pack is for the *prior* completed month.
- If `generation_day` is `5` and today is `2026-04-05`, the pack covers `2026-03`.
- Helper: `buildPriorMonthPeriod(date: Date): string` — subtract one month, format as `YYYY-MM`.

**Error isolation:**
- Use `Promise.allSettled` (not `Promise.all`) — one company's failure must not block others.
- Log each failure with `log.error({ companyId, error })`.

---

## Step 9 — API Routes

### `pages/api/accounting/afs/management-pack-config.ts`

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getManagementPackConfig,
  upsertManagementPackConfig,
} from '@/modules/accounting/services/afs/managementPackConfigService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    log.info('Fetching management pack config', { companyId }, 'management-pack-config-api');
    const config = await getManagementPackConfig(companyId);
    return apiResponse.success(res, { config });
  }

  if (req.method === 'PUT') {
    log.info('Upserting management pack config', { companyId }, 'management-pack-config-api');
    const config = await upsertManagementPackConfig(companyId, req.body);
    return apiResponse.success(res, { config });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withCompany(withErrorHandler(handler as never));
```

### `pages/api/accounting/afs/management-packs/index.ts`

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const year = req.query.year ? Number(req.query.year) : null;

  log.info('Listing management packs', { companyId, year }, 'management-packs-api');

  let rows: Row[];
  if (year) {
    rows = (await sql`
      SELECT * FROM afs_documents
      WHERE company_id = ${companyId}::UUID
        AND document_type = 'management_pack'
        AND period LIKE ${`${year}-%`}
      ORDER BY period DESC
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM afs_documents
      WHERE company_id = ${companyId}::UUID
        AND document_type = 'management_pack'
      ORDER BY period DESC
    `) as Row[];
  }

  return apiResponse.success(res, { documents: rows });
}

export default withCompany(withErrorHandler(handler as never));
```

### `pages/api/accounting/afs/management-packs/[packId]/index.ts`

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const packId = String(req.query.packId);

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  log.info('Fetching management pack', { companyId, packId }, 'management-pack-detail-api');

  // IDOR guard: always filter by company_id
  const docRows = (await sql`
    SELECT * FROM afs_documents
    WHERE id = ${packId}::UUID
      AND company_id = ${companyId}::UUID
      AND document_type = 'management_pack'
  `) as Row[];

  if (docRows.length === 0) {
    return apiResponse.notFound(res, 'Management pack not found');
  }

  const sectionRows = (await sql`
    SELECT * FROM afs_sections
    WHERE document_id = ${packId}::UUID
      AND company_id = ${companyId}::UUID
    ORDER BY sort_order ASC
  `) as Row[];

  return apiResponse.success(res, {
    document: docRows[0],
    sections: sectionRows,
  });
}

export default withCompany(withErrorHandler(handler as never));
```

### `pages/api/accounting/afs/management-packs/[packId]/deliver.ts`

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { deliverPack } from '@/modules/accounting/services/afs/packDeliveryService';

type Row = DbRow;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const packId = String(req.query.packId);

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  // IDOR guard
  const docRows = (await sql`
    SELECT id, status FROM afs_documents
    WHERE id = ${packId}::UUID
      AND company_id = ${companyId}::UUID
      AND document_type = 'management_pack'
  `) as Row[];

  if (docRows.length === 0) {
    return apiResponse.notFound(res, 'Management pack not found');
  }

  const status = String(docRows[0].status);
  if (status !== 'draft' && status !== 'signed_off') {
    return apiResponse.badRequest(res, `Cannot deliver pack with status '${status}'`);
  }

  log.info('Manual pack delivery triggered', { companyId, packId, status }, 'management-pack-deliver-api');

  await deliverPack(packId, companyId);

  return apiResponse.success(res, { delivered: true });
}

export default withCompany(withErrorHandler(handler as never));
```

### `pages/api/accounting/afs/generate-pack.ts`

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getManagementPackConfig } from '@/modules/accounting/services/afs/managementPackConfigService';
import { generateManagementPack } from '@/modules/accounting/services/afs/managementPackGeneratorService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  const { period } = req.body as { period?: string };

  if (!period || !/^\d{4}-\d{2}$/.test(period)) {
    return apiResponse.badRequest(res, 'period must be in YYYY-MM format');
  }

  log.info('Manual pack generation triggered', { companyId, period }, 'generate-pack-api');

  const config = await getManagementPackConfig(companyId);
  const result = await generateManagementPack({
    companyId,
    period,
    config,
    triggeredBy: 'manual',
  });

  return apiResponse.success(res, { result });
}

export default withCompany(withErrorHandler(handler as never));
```

### `pages/api/accounting/afs/cron/management-packs.ts`

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { log } from '@/lib/logger';
import { runDailyScheduler } from '@/modules/accounting/services/afs/packSchedulerService';

/**
 * Cron endpoint — called at 06:00 SAST by system cron / Vercel Cron.
 *
 * Authentication: X-Cron-Secret header must match CRON_SECRET env var.
 * This route does NOT use withCompany — it is a system-level endpoint
 * that processes multiple companies internally.
 */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    log.warn('Unauthorized cron attempt', { ip: req.socket.remoteAddress }, 'cron-management-packs');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  log.info('Cron triggered: management pack scheduler', {}, 'cron-management-packs');

  try {
    const result = await runDailyScheduler();
    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Cron scheduler failed', { error: message }, 'cron-management-packs');
    return res.status(500).json({ error: 'Scheduler failed', message });
  }
}

export default handler;
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
│  │  Delivery on day:  [10 ▼] of each month                │    │
│  │  Review required:  [yes ▼]                              │    │
│  │  Pack style:  [Detailed ▼]                              │    │
│  │  Comparison:  [Prior month ▼]                           │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌── Sections ─────────────────────────────────────────────┐    │
│  │  [grid of 16 toggle switches with labels]               │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌── Recipients ───────────────────────────────────────────┐    │
│  │  [email] [role] [receives ▼]  [+ Add]                    │    │
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
- Manual generate: `POST /api/accounting/afs/generate-pack` with `{ period }`
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
import {
  calculateKpis,
  DEFAULT_RAG_THRESHOLDS,
  type FinancialSnapshot,
  type RagThresholds,
} from '@/modules/accounting/services/afs/kpiScorecardService';

const BASE_SNAPSHOT: FinancialSnapshot = {
  revenue: 1_000_000,
  cogs: 600_000,
  grossProfit: 400_000,
  ebitda: 150_000,
  ebit: 120_000,
  netProfit: 80_000,
  currentAssets: 500_000,
  currentLiabilities: 300_000,
  inventory: 0,              // no inventory accounts in default chart
  tradeReceivables: 150_000,
  tradePayables: 120_000,
  totalDebt: 400_000,
  totalEquity: 600_000,
  openingCash: 200_000,
  closingCash: 250_000,
  daysInPeriod: 31,
};
```

**Test cases to implement:**

1. `grossMarginPct` calculated correctly as `(400000/1000000)*100 = 40` → RAG `green`
2. `currentRatio` = `500000/300000 = 1.667` → RAG `green`
3. `debtorDays` = `(150000/1000000)*31 = 4.65` → RAG `green`
4. Low gross margin (< 20%) → RAG `red`
5. Border case: `currentRatio` exactly `1.5` → `green` (threshold is `>=`)
6. `revenueGrowthPct` calculated correctly with prior snapshot
7. `revenueGrowthPct` trend is `flat` when no prior snapshot
8. `cashBurnRate` is `0` when cash increased (closing > opening)
9. Trend: `up` when value increased vs prior; `down` when decreased; `flat` when < 1% change
10. All 11 KPIs present in output array
11. No division-by-zero: returns `0` and RAG `red` when `currentLiabilities = 0`
12. No division-by-zero: returns `0` and RAG `red` when `revenue = 0`

### `tests/unit/services/afs/managementPackConfigService.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
7. `getManagementPackConfig` — never returns data across tenants (always `WHERE company_id = ...`)
8. Default config has `deliveryDay: 10` and `packStyle: 'detailed'` (matches DB schema defaults)

---

## Execution Order

1. Verify types in `afsTypes.ts` — add `KpiResult` and `KpiScorecard` if missing
2. Implement `kpiScorecardService.ts` (pure functions first, then DB wrapper)
3. Write `kpiScorecardService.test.ts` — all 12 test cases green
4. Implement `managementPackConfigService.ts`
5. Write `managementPackConfigService.test.ts` — all 8 test cases green
6. Implement `packAiSummaryService.ts`
7. Implement `managementPackGeneratorService.ts`
8. Implement `packDeliveryService.ts`
9. Implement `packSchedulerService.ts`
10. Implement all 6 API routes
11. Implement `management-packs.tsx` page
12. Update `accountingNavConfig.ts`
13. Run `bun run test:unit` — all tests green
14. Run `bunx tsc --noEmit` — zero type errors

---

## Cross-Cutting Rules (apply to every file)

- Every DB query includes `company_id` in `WHERE` — no exceptions. For the GL triple-join pattern, filter on ALL three tables: `je.company_id`, `jl.company_id`, `ga.company_id`.
- No `console.log` — use `log.info`, `log.error`, `log.warn` from `@/lib/logger`.
- No empty `catch` blocks — always log the error.
- All route handlers: `export default withCompany(withErrorHandler(handler as never));` (except cron endpoint).
- Import pattern: `import { withCompany, type CompanyApiRequest } from '@/lib/auth';` and `import { withErrorHandler } from '@/lib/api-error-handler';`
- All responses: `apiResponse.success()`, `.badRequest()`, `.notFound()`, `.methodNotAllowed()`.
- Use `sql` tagged template from `@/lib/neon` — never string concatenation.
- Every file max 300 lines.
- 100% TypeScript — no `any` except Next.js required patterns (use `as never` instead).
- Table names: `gl_accounts` (NOT `chart_of_accounts`), alias as `ga` (NOT `a`).
- Posted status: `je.status = 'posted'` (NOT `je.is_posted = TRUE`).

---

## Environment Variables Required

```bash
CRON_SECRET=<random-secret>     # Validates cron endpoint — add to .env.local and Vercel
```

---

## Out of Scope for Plan 7

- PDF generation via WeasyPrint (Plan 4) — stub provided
- DOCX export (Plan 4)
- Client portal delivery page (Plan 6)
- Budget import / budget vs actual (no budget infrastructure exists)
- 13-week cash flow forecast (separate feature)
- E-signature flow (Plan 6 + Signum)
- IFRS compliance checker (Plan 8)
- Per-company RAG threshold configuration (no `rag_thresholds` column — hardcoded defaults used)
- Revenue per employee KPI (no `headcount` field exists)
- Interest coverage KPI (no `interest_expense` account_subtype in default chart)
- Inventory days KPI (no `inventory` account_subtype in default chart)

---

*Plan 7 rewritten: 2026-04-16 | Spec: Section 7 — Monthly Management Pack Scheduler | Audit-corrected: all SQL, imports, schemas verified against actual codebase*
