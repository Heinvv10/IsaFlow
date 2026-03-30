# ISAFlow Outstanding Features — Resume Document

## Working Directory
```
/home/hein/Workspace/IsaFlow
```

## Current State (as of 2026-03-30)

### Test Suite
- **694 Vitest unit tests** — all pass
- **253 Playwright E2E tests** — all pass (full-audit.spec.ts + workflow-audit.spec.ts)
- **947 total tests**

### VLM Status
- **ACTIVE** — Qwen3-VL-8B-Instruct on vLLM port 8100
- `.env.local` configured: `VLLM_BASE_URL=http://localhost:8100/v1`

---

## What's DONE

### Sprint A — Financial Ratios & KPI Scorecards ✅
- `src/modules/accounting/services/reportingEngineService.ts` — extended with `calculateExtendedRatios()` (30+ ratios)
- `src/modules/accounting/services/ratioTrendService.ts` — multi-period trend tracking
- `src/modules/accounting/services/kpiScorecardService.ts` — traffic-light scoring
- 3 APIs: `reports-extended-ratios.ts`, `reports-ratio-trends.ts`, `reports-kpi-scorecard.ts`
- UI: `pages/accounting/reports/financial-analysis.tsx`
- Tests: `tests/unit/reporting/advanced-ratios.test.ts`, `ratio-trends.test.ts`, `kpi-scorecard.test.ts`

### Sprint B — Waterfall Charts & Trend Analysis ✅
- `src/modules/accounting/services/waterfallDataService.ts` — profit/cashflow/variance waterfalls
- `src/modules/accounting/services/trendAnalysisService.ts` — growth rates, moving averages, anomaly detection
- `src/components/shared/WaterfallChart.tsx` — reusable Recharts component
- 2 APIs: `reports-waterfall.ts`, `reports-trend-analysis.ts`
- UI: `pages/accounting/reports/waterfall.tsx`, `trend-analysis.tsx`
- Tests: `tests/unit/reporting/waterfall-data.test.ts`, `trend-analysis.test.ts`

### Sprint D — AI Invoice Pipeline + Receipt Journal ✅
- `src/modules/accounting/services/aiInvoicePipelineService.ts` — capture→invoice→GL
- `src/modules/accounting/services/receiptToJournalService.ts` — receipt photo→expense journal
- 2 APIs: `ai-invoice-pipeline.ts`, `receipt-to-journal.ts`
- Tests: `tests/unit/ai/ai-invoice-pipeline.test.ts`, `receipt-to-journal.test.ts`

### Sprint E — VLM Bank Match + Contract Extraction (PARTIAL)
- `src/modules/accounting/services/vlmBankMatchService.ts` ✅
- `src/modules/accounting/services/contractExtractionService.ts` ✅
- Tests: `tests/unit/ai/vlm-bank-match.test.ts` ✅, `contract-extraction.test.ts` ✅
- **MISSING**: `pages/api/accounting/contract-to-recurring.ts` API endpoint

### Sprint F — Payslip Verification + Multi-Doc Match (PARTIAL)
- `src/modules/accounting/services/payslipVerificationService.ts` ✅
- Tests: `tests/unit/ai/payslip-verification.test.ts` ✅
- **MISSING**: `src/modules/accounting/services/multiDocMatchService.ts` service
- **MISSING**: `tests/unit/ai/multi-doc-match.test.ts` test
- **MISSING**: `pages/api/accounting/verify-payslip.ts` API
- **MISSING**: `pages/api/accounting/multi-doc-match.ts` API

### Sprint G — AI Commentary + Continuous Close (PARTIAL)
- `src/modules/accounting/services/aiCommentaryService.ts` ✅
- `src/modules/accounting/services/continuousCloseService.ts` ✅
- Tests: `tests/unit/ai/ai-commentary.test.ts` ✅, `continuous-close.test.ts` ✅
- **MISSING**: `pages/api/accounting/ai-commentary.ts` API
- **MISSING**: `pages/api/accounting/continuous-close.ts` API

---

## What's NOT DONE

### Sprint C — Executive Dashboard, Report Packs & 3-Way Forecast (ENTIRE SPRINT)

#### C1. Tests to write (RED phase):
```
tests/unit/reporting/executive-summary.test.ts (~7 tests)
tests/unit/reporting/report-pack.test.ts (~6 tests)
tests/unit/reporting/three-way-forecast.test.ts (~8 tests)
```

#### C2. Services to create (GREEN phase):
```
src/modules/accounting/services/executiveSummaryService.ts
  - buildExecutiveSummary(companyId, from, to) — orchestrates KPIs + ratios + trends + forecast

src/modules/accounting/services/reportPackService.ts
  - buildReportPack(type: 'board'|'management'|'monthly', data) → ordered sections

src/modules/accounting/services/threeWayForecastService.ts
  - generateThreeWayForecast(historical, params, months) → linked P&L + BS + CF
  - Must validate: BS balances (A=L+E), CF reconciles to BS cash movement
```

#### C3. APIs to create:
```
pages/api/accounting/reports-executive-summary.ts   GET ?from=&to=
pages/api/accounting/reports-pack.ts                GET ?type=board|management|monthly&from=&to=
pages/api/accounting/reports-three-way-forecast.ts   GET ?months=6&revenueGrowth=5
pages/api/accounting/reports-pdf.ts                 POST { type, from, to } → PDF buffer
```

#### C4. UI pages to create:
```
pages/accounting/reports/executive-dashboard.tsx
  - KPI cards + waterfalls + scorecard + alerts in one page

pages/accounting/reports/report-packs.tsx
  - Pack selector (Board/Management/Monthly) + preview + PDF download

pages/accounting/reports/three-way-forecast.tsx
  - Parameter panel + linked P&L/BS/CF tabs
```

#### C5. E2E test:
```
tests/e2e/sprint-analytics-c.spec.ts
```

### Missing APIs (5 endpoints):
```
pages/api/accounting/contract-to-recurring.ts     POST multipart PDF → create recurring invoice
pages/api/accounting/verify-payslip.ts            POST multipart PDF → verify against payroll
pages/api/accounting/multi-doc-match.ts           POST multipart (up to 3 files) → 3-way match
pages/api/accounting/ai-commentary.ts             POST { from, to } → management commentary
pages/api/accounting/continuous-close.ts           POST { action: 'run' } → auto-process
```

### Missing Service (1):
```
src/modules/accounting/services/multiDocMatchService.ts
  - classifyDocumentRole(extracted) → 'purchase_order'|'delivery_note'|'invoice'
  - performMultiDocMatch(docs) → overall status + cross-references
  - buildCrossReferenceReport(po, grn, invoice) → field-by-field comparison
  - Uses existing threeWayMatch.ts utility from src/modules/accounting/utils/threeWayMatch.ts

tests/unit/ai/multi-doc-match.test.ts (~14 tests)
```

### Reports Hub Update:
```
pages/accounting/reports/index.tsx
  - Add "Analytics" category with 6 new report links
```

---

## Patterns to Follow

### Unit Test Pattern (Vitest):
```typescript
import { describe, it, expect } from 'vitest';
import { myFunction } from '@/modules/accounting/services/myService';

describe('My Feature', () => {
  it('does something', () => {
    expect(myFunction(input)).toBe(expected);
  });
});
```

### Service Pattern (pure business logic):
```typescript
// No DB imports — pure functions only
export function myFunction(data: InputType): OutputType {
  // business logic
}
```

### API Pattern:
```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  // ...
  return apiResponse.success(res, data);
}

export default withCompany(withErrorHandler(handler as any));
```

### UI Page Pattern:
```typescript
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import dynamic from 'next/dynamic';
// Dynamic Recharts imports:
const LineChart = dynamic(() => import('recharts').then(m => m.LineChart), { ssr: false });
```

---

## Verification Commands
```bash
npx vitest run                    # All unit tests (expect 700+)
npx tsc --noEmit                  # TypeScript clean
bun run build                     # Production build
npx playwright test tests/e2e/full-audit.spec.ts tests/e2e/workflow-audit.spec.ts  # E2E (253+ tests)
```

## Key File References
- Existing ratio service: `src/modules/accounting/services/reportingEngineService.ts`
- Existing KPI service: `src/modules/accounting/services/kpiService.ts`
- Cash flow forecast: `src/modules/accounting/services/cashFlowForecastService.ts`
- Three-way match utility: `src/modules/accounting/utils/threeWayMatch.ts`
- Fuzzy match utility: `src/modules/accounting/utils/fuzzyMatch.ts`
- Report narrative service: `src/modules/accounting/services/reportNarrativeService.ts`
- VLM service: `src/modules/accounting/services/vlmService.ts`
- Vitest config: `vitest.config.ts`
- Playwright config: `playwright.config.ts` (baseURL: http://localhost:3101)
