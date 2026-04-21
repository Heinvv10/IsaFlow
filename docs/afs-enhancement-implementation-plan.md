# AFS Enhancement Implementation Plan

**Based on**: AFS Master v15 Spreadsheet Analysis
**Date**: 2026-04-20
**Status**: Proposed

ISAFlow already has solid AFS foundations (afs_documents, generation services, HTML/PDF export, compliance checker). The AFS Master v15 spreadsheet reveals gaps in: standardized account taxonomy for statement generation, deferred tax calculations in FAR, complete IFRS note disclosure templates, and SA Companies Act-compliant report wording.

Execute in phases, each delivering standalone value. Prioritize items that fill gaps between our existing TB → AFS pipeline and what a professional accountant expects in output.

---

## Phase 1: Account Mapping Taxonomy (BS/IS Codes)
**Priority: HIGH | Effort: 2-3 days | Dependencies: None**

### What We Have
- `gl_accounts` with type (asset/liability/equity/revenue/expense) and subtype
- `account_reporting_groups` for custom groupings
- Trial balance service already returns categorized balances
- Balance sheet and income statement services generate reports

### What's Missing (from AFS Master)
- Standardized disclosure mapping codes (BS001-BS083, IS001-IS497)
- "Combine" directives (e.g., multiple interest lines → single note disclosure)
- Note number assignment per line item
- On/off toggles for line items in statement output

### Implementation

**Migration: `3XX_afs_mapping_codes.sql`**
```sql
CREATE TABLE afs_statement_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  code VARCHAR(10) NOT NULL,           -- BS001, IS002, etc.
  section VARCHAR(20) NOT NULL,         -- 'balance_sheet', 'income_statement'
  label TEXT NOT NULL,                  -- Display name
  parent_code VARCHAR(10),              -- For hierarchy/grouping
  note_number INTEGER,                  -- Links to disclosure note
  sort_order INTEGER NOT NULL,
  combine_group VARCHAR(20),            -- e.g., 'combine1' = combine into single note
  is_header BOOLEAN DEFAULT false,
  is_total BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE afs_account_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id),
  afs_line_code VARCHAR(10) NOT NULL,   -- Maps to afs_statement_lines.code
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(company_id, gl_account_id)
);
```

**Service: `src/modules/accounting/services/afs/afsMappingService.ts`**
- `getDefaultMappings()` - Seed BS/IS codes from AFS Master taxonomy
- `mapAccountToLine(glAccountId, afsLineCode)` - Manual mapping
- `autoMapAccounts()` - Auto-map based on account type/subtype heuristics
- `getMappedTrialBalance()` - TB reorganized by AFS line codes

**UI: `pages/accounting/afs/mapping.tsx`**
- Drag-and-drop GL accounts to AFS line codes
- Auto-suggest mappings based on account name/type
- Visual tree of BS/IS structure with totals

---

## Phase 2: Enhanced Fixed Asset Register - Deferred Tax
**Priority: HIGH | Effort: 1-2 days | Dependencies: Phase 1**

### What We Have
- `assets` table with purchase cost, depreciation method, useful life
- `asset_categories` with SARS wear-and-tear rates
- `asset_period_ledger` for per-period depreciation
- Book vs tax depreciation already tracked separately

### What's Missing (from AFS Master)
- Deferred tax calculation per asset (policy base vs tax base × tax rate)
- Aggregate deferred tax asset/liability for balance sheet
- Policy vs Tax carrying amount comparison report
- Profit/loss on disposal split (policy vs tax)

### Implementation

**Migration: `3XX_asset_deferred_tax.sql`**
```sql
ALTER TABLE asset_period_ledger
  ADD COLUMN IF NOT EXISTS tax_depreciation NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS tax_carrying_amount NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS deferred_tax_amount NUMERIC(15,2);

-- Summary view for AFS note
CREATE VIEW v_deferred_tax_summary AS
SELECT
  company_id,
  category_id,
  SUM(book_carrying_amount) as policy_carrying_amount,
  SUM(tax_carrying_amount) as tax_carrying_amount,
  SUM(book_carrying_amount - tax_carrying_amount) as temporary_difference,
  SUM(deferred_tax_amount) as deferred_tax
FROM asset_period_ledger
WHERE period_id = (SELECT id FROM fiscal_periods WHERE status = 'open' LIMIT 1)
GROUP BY company_id, category_id;
```

**Service: `src/modules/accounting/services/afs/deferredTaxService.ts`**
- `calculateDeferredTax(companyId, periodId)` - Per-asset and aggregate
- `getDeferredTaxNote(companyId, periodId)` - Formatted for AFS note disclosure
- `getDeferredTaxMovement(companyId, currentPeriod, priorPeriod)` - Year-on-year movement

---

## Phase 3: IFRS Disclosure Note Templates
**Priority: HIGH | Effort: 4-5 days | Dependencies: Phase 1, 2**

### What We Have
- `afs_sections` table for document sections
- `afsHtmlRendererService.ts` for HTML output
- `changesInEquityService.ts`, `cashFlowDirectService.ts`

### What's Missing (from AFS Master)
- Complete note templates for all standard disclosures
- Auto-population from mapped TB data
- Note numbering that follows the standard order
- IFRS for SMEs vs Full IFRS policy wording switch

### Note Templates to Implement

| Note | Topic | Data Source |
|------|-------|-------------|
| 1 | Accounting policies | Template text + framework switch |
| 2 | Property, plant and equipment | FAR summary by category |
| 3 | Investment property | BS006 mapped accounts |
| 4 | Intangible assets / Goodwill | BS019 mapped accounts |
| 5 | Trade and other receivables | BS028 breakdown |
| 6 | Cash and cash equivalents | BS036 + BS070 |
| 7 | Share capital | BS043 movement |
| 8 | Retained earnings | BS045 movement |
| 9 | Interest-bearing borrowings | BS050 + BS062 |
| 10 | Lease liabilities (IFRS 16) | BS051 + BS063 |
| 11 | Trade and other payables | BS065 + BS066 breakdown |
| 12 | Revenue | IS002-IS022 breakdown |
| 13 | Cost of sales | IS042 breakdown |
| 14 | Operating expenses | IS156-IS450 detailed schedule |
| 15 | Directors' remuneration | IS225 breakdown |
| 16 | Depreciation | IS219 by asset class |
| 17 | Finance costs | IS454-IS459 |
| 18 | Investment income | IS461-IS469 |
| 19 | Taxation | IS475-IS477 + rate reconciliation |
| 20 | Financial risk management | Template + data from TB |
| 21 | Related party transactions | Manual input + directors |
| 22 | Events after reporting date | Manual input |
| 23 | Going concern | Template text |

**Service: `src/modules/accounting/services/afs/afsNoteTemplateService.ts`**
- `generateNote(noteNumber, companyId, periodId, framework)` - Returns structured note data
- `getAccountingPolicies(framework)` - IFRS for SMEs or Full IFRS wording
- `getPPENote(companyId, periodId)` - Movement schedule from FAR
- `getRevenueNote(companyId, periodId)` - Revenue disaggregation

---

## Phase 4: Report Templates (SA Companies Act)
**Priority: MEDIUM | Effort: 1 day | Dependencies: None**

### What We Have
- `afsHtmlRendererService.ts` generates HTML
- `proofCopyService.ts` for proof copies

### What's Missing
- Word-perfect SA Companies Act compliant report wording
- Dynamic insertion of company name, period, page numbers
- Support for all report types (MFS, CO, CO Rev, Audit)

### Implementation

**Data: `src/modules/accounting/services/afs/reportTemplates.ts`**

Store exact report wording from AFS Master for each type:
- `getCompilationReport(companyData)` - ISRS 4410 compilation
- `getAccountingOfficerReport(companyData)` - s58 Companies Act
- `getReviewReport(companyData)` - ISRE 2400 review
- `getEmphasisOfMatter(noteRef, description)` - Optional paragraph
- `getDirectorResponsibility(companyData)` - Directors' report

Each template has placeholders: `{companyName}`, `{periodEnd}`, `{pageFrom}`, `{pageTo}`, `{framework}`, `{entityType}`

---

## Phase 5: Public Interest Score & Reporting Requirements
**Priority: MEDIUM | Effort: 0.5 day | Dependencies: None**

### Implementation

**Service: `src/modules/accounting/services/afs/pisService.ts`**
```typescript
interface PISCalculation {
  employees: { beginning: number; end: number; average: number; points: number };
  turnover: { amount: number; points: number };
  thirdPartyLiabilities: { amount: number; points: number };
  shareholders: { count: number; points: number };
  totalScore: number;
  reportingRequirement: 'audit' | 'review' | 'accounting_officer' | 'none';
}
```

- Score ≥ 350: Audit required
- Score ≥ 100: Independent review required
- Score < 100: Accounting officer report sufficient
- Voluntary audit/review always permitted

Auto-populates from:
- Employee count from payroll module
- Turnover from IS002 mapping
- Third-party liabilities from BS050-BS072 sum
- Shareholders from company settings

---

## Phase 6: Financial Ratios Dashboard Enhancement
**Priority: MEDIUM | Effort: 2 days | Dependencies: Phase 1**

### What We Have
- `reportingEngineService.ts` with basic ratios
- `ratioTrendService.ts` for trend analysis

### What's Missing (from AFS Master)
- Complete ratio set (30+ ratios across 5 categories)
- Employee productivity ratios (requires headcount)
- Coverage ratios (interest cover)
- Industry benchmarking

### Additional Ratios to Add

**Activity:**
- Net operating asset turnover
- Inventory turnover (materials)
- Trade receivables turnover (days)

**Profitability:**
- Direct material margin %
- Operating EBITDA %
- PBIT %

**Coverage:**
- Operating EBITDA / net interest
- PBT / net interest
- Net profit / net interest

**Employee Productivity:**
- Revenue per head
- PBIT per head
- EBITDA per head
- Employee cost ratios

---

## Phase 7: VAT Reconciliation Enhancement
**Priority: LOW | Effort: 1 day | Dependencies: None**

### What We Have
- Full VAT201 generation
- Input/output VAT tracking
- VAT returns and submissions

### What's Missing (from AFS Master)
- Monthly VAT reconciliation view (financial statements vs VAT returns)
- Capital goods vs other goods split in reconciliation
- Multi-year comparative VAT summary
- Variance analysis (TB turnover vs VAT declared turnover)

---

## Phase 8: Multi-Entity Type Support
**Priority: LOW | Effort: 2 days | Dependencies: Phase 3, 4**

### What's Missing
- CC (Close Corporation) terminology in reports and notes
- Trust terminology and disclosure requirements
- Automatic switching of "director" → "member" → "trustee"
- "Dividends" → "distributions" → "distributions to beneficiaries"
- Entity-specific disclosure requirements

---

## Execution Timeline

| Phase | Description | Effort | Delivers |
|-------|-------------|--------|----------|
| 1 | Account Mapping Taxonomy | 2-3 days | TB → AFS line code mapping |
| 2 | Deferred Tax in FAR | 1-2 days | Policy vs Tax + deferred tax calc |
| 3 | IFRS Note Templates | 4-5 days | Auto-generated disclosure notes |
| 4 | Report Templates | 1 day | SA Companies Act report wording |
| 5 | Public Interest Score | 0.5 day | Auto PIS calculation |
| 6 | Ratios Enhancement | 2 days | Complete ratio dashboard |
| 7 | VAT Reconciliation | 1 day | Monthly recon view |
| 8 | Multi-Entity | 2 days | CC/Trust support |

**Total estimated: ~14-16 days of development**

---

## Key Design Decisions

1. **Mapping codes are per-company** - different businesses may need different mappings
2. **Default seed from AFS Master taxonomy** - BS001-BS083, IS001-IS497 as starting point
3. **Auto-mapping heuristic** - match GL account type/subtype/name to suggested AFS line
4. **Framework switch at document level** - same data, different disclosure output (IFRS for SMEs vs Full IFRS)
5. **Note templates are data-driven** - pull from mapped accounts, not hardcoded values
6. **Reports use exact legal wording** - sourced directly from AFS Master v15 (verified compliant)
