# PRD-03: Loan Amortisation Module

**Status:** `PLANNED`  
**Priority:** P2 — High-value niche, differentiates ISaFlow for firms managing loan books or client financing  
**Source specs:** `Amort Summary.docx`, `Amortisation Report AI ver.xlsx` (golden-file reference)  
**Related modules:** GL (`journalEntryCrudService`, `journalEntryPostingService`), Fixed Assets (amortisation pattern), Reports (balance sheet current/non-current split)

---

## 1. Problem Statement

Accounting firms and businesses managing loans (property bonds, vehicle finance, shareholder loans, inter-company loans) currently use Excel models to track amortisation schedules. The existing Excel model (`Amortisation Report AI ver.xlsx`) has:

- 668 rows of SA Prime rate history + user-defined rate curve (INTRATE sheet)
- Lump-sum prepayment handling
- Skip-payment handling (ad-hoc + recurring e.g. Dec+Jan every year)
- Short-term / long-term liability split (current portion of long-term debt)
- Variable-rate schedules (Prime + margin, Prime - margin, or fixed)

The problem: Excel models are per-loan, disconnected from the GL, not auditable, and can't produce portfolio-level reporting or IFRS 9 staging.

---

## 2. Strategic Objective

Provide a first-class loan book management module integrated with IsaFlow's GL, so that:
- Loan schedules auto-generate double-entry journals each period
- Balance sheet current vs non-current debt split is automatic
- SA Prime rate curve is maintained centrally and applies to all linked loans
- Period close locks postings (no retroactive changes)
- Full NCA compliance (in-duplum rule enforcement)
- IFRS 9 staging (ECL Phase 1/2/3) for firms managing credit portfolios

---

## 3. What Already Exists in IsaFlow

| Component | Status | Notes |
|-----------|--------|-------|
| GL journal entry service | ✅ Exists | `journalEntryPostingService.ts` |
| Fixed assets depreciation pattern | ✅ Exists | Same recurring-journal pattern |
| `fiscal_periods` + period locking | ✅ Exists | `fiscalPeriodService.ts` |
| Chart of accounts (liability accounts) | ✅ Exists | Loan accounts will map here |
| Balance sheet service | ✅ Exists | Needs current/non-current split |
| Multi-currency | ✅ Exists | For USD/EUR-denominated loans |
| Amortisation engine | ❌ Missing | Net-new TypeScript pure function |
| Loan data model | ❌ Missing | Net-new |
| Rate curve management | ❌ Missing | Net-new |
| Portfolio dashboard | ❌ Missing | Net-new |
| NCA in-duplum enforcement | ❌ Missing | Net-new |
| IFRS 9 ECL staging | ❌ Missing | Net-new (Phase 2) |

---

## 4. Core Engine Specification

The amortisation engine is a **pure TypeScript function** — no DB, no side effects, deterministic.

```typescript
function amortise(loan: LoanInputs, events: LoanEvent[], curve: RatePoint[]): ScheduleRow[]

interface LoanInputs {
  id: string
  principal: number
  startDate: string          // ISO date
  termMonths: number
  rateMode: 'FIXED' | 'PRIME_PLUS' | 'PRIME_MINUS'
  margin: number             // e.g. 4.0 for Prime+4%
  fixedRate?: number         // used when rateMode='FIXED'
  residual: number           // balloon payment (0 if none)
  recurringSkipMonths: number[] // [12, 1] = skip Dec and Jan every year
  dayCount: 'ACTUAL_365' | 'ACTUAL_360' | '30_360'
  repriceMode: 'RESOLVE_ON_RATE_CHANGE' | 'RESOLVE_EVERY_PERIOD' | 'FIXED_INSTALLMENT'
  skipMode: 'EXTEND_TERM' | 'MAINTAIN_TERM'  // term extension vs higher installment on resume
  lumpMode: 'REDUCE_INSTALLMENT' | 'MAINTAIN_INSTALLMENT'
}

interface LoanEvent {
  kind: 'LUMP' | 'SKIP' | 'RESTRUCTURE' | 'WRITEOFF'
  date: string
  amount?: number
  note?: string
}

interface RatePoint {
  effectiveDate: string
  rate: number
}

interface ScheduleRow {
  period: number
  date: string
  opening: number
  rate: number               // effective rate for this period
  installment: number
  interest: number
  principal: number
  intPortion: number
  skip: boolean
  payment: number            // 0 on skip months
  lump: number               // lump sum applied this period
  closing: number
  stLiability: number        // sum of next 12 months' principal (current portion)
  extrapolated: boolean      // true if rate was extrapolated beyond curve end
}
```

**Engine rules:**
- Decimal math using `decimal.js` — keep 6dp internally, round to 2dp at write-out
- Rate lookup: approximate match on effectiveDate ascending; extrapolate last known rate if loan period exceeds curve — flag row `extrapolated: true`
- Installment re-solve: `-PMT(rate/12, remainingTerm, openingBalance, -residual)` when repriceMode=RESOLVE_ON_RATE_CHANGE (or after lump, or every period for RESOLVE_EVERY_PERIOD)
- Skip month: payment=0, interest accrues into closing balance; subsequent installments re-solve (unless skipMode=EXTEND_TERM)
- ST liability for row r: `Σ(payment[r..r+11]) + Σ(lump[r..r+11]) − Σ(interest[r..r+11])` — window truncates at end of schedule
- NCA in-duplum: if `Σinterest_accrued > original_principal` → cap interest, flag row

**Golden-file test:** Engine must reproduce the reference Excel output (`Amortisation Report AI ver.xlsx`) to the cent for the reference fixture: 224,873.49 principal, 72 months, Prime+4%, recurring skip 12+1, two lumps, one ad-hoc skip.

---

## 5. Data Model

```sql
-- Rate curves (SA Prime + user-defined)
CREATE TABLE loan_rate_curves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies,
  name text NOT NULL,           -- 'SA Prime', 'JIBAR', custom
  source text,
  UNIQUE (company_id, name)
);

CREATE TABLE loan_rate_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  curve_id uuid NOT NULL REFERENCES loan_rate_curves,
  effective_date date NOT NULL,
  rate numeric(8,4) NOT NULL,
  UNIQUE (curve_id, effective_date)
);

-- Loan master
CREATE TABLE loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies,
  counterparty_id uuid,         -- REFERENCES suppliers or customers (nullable)
  gl_account_id uuid,           -- loan liability/asset account
  curve_id uuid REFERENCES loan_rate_curves,
  reference text,
  product text,                 -- 'bond', 'vehicle_finance', 'shareholder_loan'
  principal numeric(18,2) NOT NULL,
  start_date date NOT NULL,
  term_months integer NOT NULL,
  rate_mode text NOT NULL,
  margin numeric(8,4) DEFAULT 0,
  fixed_rate numeric(8,4),
  residual numeric(18,2) DEFAULT 0,
  day_count text DEFAULT 'ACTUAL_365',
  reprice_mode text DEFAULT 'RESOLVE_ON_RATE_CHANGE',
  skip_mode text DEFAULT 'MAINTAIN_TERM',
  lump_mode text DEFAULT 'REDUCE_INSTALLMENT',
  recurring_skip_months integer[] DEFAULT '{}',
  status text DEFAULT 'active', -- active | closed | written_off
  nca_compliant boolean DEFAULT true,
  currency text DEFAULT 'ZAR',
  created_at timestamptz DEFAULT now()
);

-- Events (immutable append-only)
CREATE TABLE loan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES loans,
  event_date date NOT NULL,
  kind text NOT NULL,           -- LUMP | SKIP | RESTRUCTURE | WRITEOFF
  amount numeric(18,2),
  note text,
  posted_by uuid REFERENCES users,
  posted_at timestamptz DEFAULT now()
);

-- Computed schedules (cached, regenerated on new events)
CREATE TABLE loan_schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES loans,
  computed_at timestamptz DEFAULT now(),
  engine_version text NOT NULL,
  inputs_hash text NOT NULL     -- SHA-256 of (loan + events + curve) inputs
);

CREATE TABLE loan_schedule_rows (
  run_id uuid NOT NULL REFERENCES loan_schedule_runs,
  period integer NOT NULL,
  date date NOT NULL,
  opening numeric(18,6),
  rate numeric(8,6),
  installment numeric(18,6),
  interest numeric(18,6),
  principal numeric(18,6),
  lump numeric(18,6),
  skip_flag boolean,
  payment numeric(18,6),
  closing numeric(18,6),
  st_liability numeric(18,6),
  extrapolated boolean DEFAULT false,
  nca_flagged boolean DEFAULT false,
  PRIMARY KEY (run_id, period)
);

-- GL postings (generated per period close)
CREATE TABLE loan_gl_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies,
  loan_id uuid NOT NULL REFERENCES loans,
  period integer NOT NULL,
  posting_date date NOT NULL,
  account_id uuid NOT NULL REFERENCES chart_of_accounts,
  debit numeric(18,2) DEFAULT 0,
  credit numeric(18,2) DEFAULT 0,
  narrative text,
  posted_period text,           -- YYYYMM
  reversal_of uuid REFERENCES loan_gl_postings,
  journal_entry_id uuid REFERENCES journal_entries
);

-- Period locks (reuse existing fiscal_periods where possible)
CREATE TABLE loan_period_locks (
  company_id uuid NOT NULL REFERENCES companies,
  yyyymm char(6) NOT NULL,
  locked_at timestamptz,
  locked_by uuid REFERENCES users,
  PRIMARY KEY (company_id, yyyymm)
);
```

All tables: `company_id` on every row, RLS by `company_id`.

---

## 6. GL / Accounting Integration

Per period, engine emits double-entry journals:

| Journal | Dr | Cr | When |
|---------|----|----|------|
| Interest accrual | Interest Expense | Interest Payable | Every period |
| Interest payment | Interest Payable | Bank | Non-skip periods |
| Principal payment | Loan Liability | Bank | Non-skip periods |
| Lump sum | Loan Liability | Bank | On lump event |
| Skip month | Interest Expense | Interest Payable | Skip only (no payment leg) |

**Balance sheet split:**
- Current liability = `stLiability` for the period-end row → posted to "Current Portion of Long-Term Debt" account
- Non-current = `closing − stLiability` → posted to "Long-Term Debt" account
- Reclassification journal auto-generated at period close

**Period close:**
- Checklist: all events posted, schedules current, no drafts → lock
- Locked periods: postings frozen; restatement = reversal pair into current open period with audit trail

---

## 7. API Surface

```
POST   /api/accounting/loans                    Create loan
GET    /api/accounting/loans                    List with filters
GET    /api/accounting/loans/:id                Detail
GET    /api/accounting/loans/:id/schedule       Latest schedule (cached or recompute)
POST   /api/accounting/loans/:id/schedule/preview  Dry-run without persisting
POST   /api/accounting/loans/:id/events         Add LUMP / SKIP / RESTRUCTURE
POST   /api/accounting/loans/:id/close          Early settlement
GET    /api/accounting/loans/portfolio/summary  Portfolio KPIs
GET    /api/accounting/loan-rate-curves         List curves
POST   /api/accounting/loan-rate-curves/:id/points  Bulk rate upload
GET    /api/accounting/loans/:id/gl-postings    GL postings for loan
POST   /api/accounting/loan-periods/:yyyymm/close  Period close
```

---

## 8. Frontend Screens

### Portfolio Dashboard
- KPI tiles: total outstanding, weighted-avg rate, next-12-months interest, total current-portion liability
- Maturity ladder chart (bar chart by year)
- Current vs non-current liability waterfall
- Top-10 loans by outstanding balance

### Loan List
- Filter by counterparty, product, status, rate mode
- CSV export
- Quick "add event" from list row

### Loan Detail (tabs)
- **Overview**: key terms, status, next payment date, remaining term
- **Schedule**: virtualised grid, colour-coded for rate changes, skip months, lump events; side-panel "What if" calling `/preview`
- **Events**: immutable event log with before/after schedule diff
- **GL Postings**: all generated journals for this loan
- **Documents**: attach loan agreements, statements
- **Audit**: full change history

### Rate Curve Admin
- Upload CSV of rate points
- Chart view of curve
- SA Prime pre-loaded (668 historical data points from spec)
- Effective-date validation (no duplicates, no future gaps)

### Period Close
- Checklist UI per period
- Lock button → confirmation → freeze

---

## 9. Implementation Phases

### Phase 0 — Engine (2 weeks)
- Extract `amortise()` as standalone TypeScript module in `src/lib/amortisation/`
- Golden-file test: reproduce reference Excel output exactly
- Property-based tests (fast-check): Σinterest+principal=Σpayments, closing≈residual, stLiability≤opening
- No DB, no UI

### Phase 1 — Data & API (3 weeks)
- DB migrations: all tables above
- Seed SA Prime rate curve (historical data)
- REST API: loan CRUD, events, schedule, portfolio summary
- Rate curve admin API

### Phase 2 — Frontend (4 weeks)
- Portfolio dashboard
- Loan list + detail (all tabs)
- Schedule grid (virtualised)
- Event editor with before/after diff preview
- Rate curve admin UI

### Phase 3 — GL Integration (3 weeks)
- Journal generation per period from schedule
- Period close workflow
- Balance sheet current/non-current split automation
- Reversal + restatement for corrections

### Phase 4 — IFRS 9 / NCA (2 weeks)
- NCA in-duplum flag + enforcement
- IFRS 9 ECL staging (1/2/3) based on days past due
- Modification accounting (NPV delta > 10%)

**Total estimate: ~14 weeks with 1 backend + 1 fullstack engineer**

---

## 10. Compliance

| Requirement | Detail |
|-------------|--------|
| NCA (National Credit Act) | In-duplum rule: interest cap at 2× outstanding principal; engine flags and caps |
| IFRS 9 | Effective-interest recalc on modification if NPV delta > 10%; ECL staging Phase 2 |
| IFRS 7 | Interest rate risk disclosure; current/non-current liability split |
| POPIA | PII (counterparty data) encrypted at rest; field-level audit; right-to-erasure |
| VAT | Interest exempt, origination fees taxable — CoA split required |

---

## 11. Testing Requirements

- Engine: golden-file test reproducing reference Excel to the cent
- Engine: property-based tests (fast-check) — all invariants
- GL: double-entry assertion per journal, per period, per loan
- E2E: create loan → add lump → preview → save → close period → reverse
- Performance: 100k loan rows re-amortised in < 60 seconds (batch queue)

---

## 12. Success Criteria

- Engine reproduces reference Excel golden file to the cent
- Balance sheet current/non-current split is automatic with no manual journal entries
- Period close takes < 5 minutes for a portfolio of 500 loans
- Zero GL postings errors (every posting balances)
- NCA in-duplum compliance automatically enforced

---

## 13. Open Questions

1. Is this an IsaFlow module or a standalone product? **Recommendation: IsaFlow module** — shares GL, period close, and multi-tenant infrastructure.
2. Should SA Prime rate curve be a shared system-level curve (maintained by ISaFlow ops) or per-tenant? **Recommendation: system-level default + tenant override.**
3. IFRS 9 ECL staging — is this needed at launch or Phase 2? Likely Phase 2 unless targeting financial institutions.
4. Should lender and borrower perspectives both be supported (loan asset vs loan liability)?
