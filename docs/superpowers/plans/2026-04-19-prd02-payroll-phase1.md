# PRD-02 Payroll SA Compliance Engine — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the SA-compliant payroll engine foundation — new data model (payroll_employees, payroll_components, payroll_run_lines), pure-TS PAYE/UIF/SDL/ETI calculation engine, continuous SARS validation engine, and API routes — so that a monthly payroll run produces legally-correct deductions with zero manual tax computation.

**Architecture:** Calculation engine is pure TypeScript functions with zero DB dependencies (deterministic, trivially testable). A thin DB-aware service layer loads data and stores results. API routes are thin: load → calculate → store → respond. New `payroll_employees` table is separate from the existing `employees` table; both coexist during migration.

**Tech Stack:** Next.js 14, TypeScript, Neon Postgres (`sql` tagged template), Vitest, Tailwind. Package manager: bun.

---

## SA Tax Numbers (2024/2025 Tax Year — March 2024 to February 2025)

These are the exact SARS-published figures embedded in `taxTables.ts`. Update annually.

| Bracket | From | To | Base Tax | Rate on Excess |
|---------|------|----|----------|----------------|
| 1 | R1 | R237,100 | R0 | 18% |
| 2 | R237,101 | R370,500 | R42,678 | 26% |
| 3 | R370,501 | R512,800 | R77,362 | 31% |
| 4 | R512,801 | R673,000 | R121,475 | 36% |
| 5 | R673,001 | R857,900 | R179,147 | 39% |
| 6 | R857,901 | R1,817,000 | R251,258 | 41% |
| 7 | R1,817,001 | ∞ | R644,489 | 45% |

| Rebate | Amount/year |
|--------|-------------|
| Primary (all) | R17,235 |
| Secondary (age 65+) | R9,444 |
| Tertiary (age 75+) | R3,145 |

| Threshold | Annual |
|-----------|--------|
| Below 65 | R95,750 |
| 65–74 | R148,217 |
| 75+ | R165,689 |

| Medical credits | Per month |
|----------------|-----------|
| Main member + first dependant | R364 each |
| Additional dependants | R246 each |

| UIF ceiling | R17,712/month |
|-------------|---------------|
| UIF rate | 1% employee + 1% employer |
| SDL rate | 1% (if annual payroll > R500,000) |

ETI (monthly, 2024/2025):
- Year 1 (months 1–12): wage ≤ R4,500 → R1,500; R4,500 < wage ≤ R7,500 → 1500 × (7500 − wage) / 3000
- Year 2 (months 13–24): wage ≤ R4,500 → R750; R4,500 < wage ≤ R7,500 → 750 × (7500 − wage) / 3000
- Ineligible if: age < 18 or > 35, wage > R7,500, domestic worker, connected person

---

## File Map

### New files — Calculation engine (no DB)

| Path | Responsibility |
|------|---------------|
| `src/modules/accounting/services/payroll/payrollTypes.ts` | Shared interfaces for the entire engine |
| `src/modules/accounting/services/payroll/taxTables.ts` | SARS tax brackets, rebates, thresholds, medical credits per tax year |
| `src/modules/accounting/services/payroll/payeEngine.ts` | `calculatePAYE()` — annual equivalent method |
| `src/modules/accounting/services/payroll/uifEngine.ts` | `calculateUIF()` — ceiling-capped contribution |
| `src/modules/accounting/services/payroll/sdlEngine.ts` | `calculateSDL()` — threshold-gated levy |
| `src/modules/accounting/services/payroll/etiEngine.ts` | `isEtiEligible()`, `calculateEti()` — youth wage subsidy |
| `src/modules/accounting/services/payroll/validationEngine.ts` | `validateEmployee()`, `validatePayrollLine()` — SARS rules, returns `ValidationResult[]` |
| `src/modules/accounting/services/payroll/payrollCalculator.ts` | `calculatePayrollLine()` — orchestrates all engines per employee per period |

### New files — DB-aware services

| Path | Responsibility |
|------|---------------|
| `src/modules/accounting/services/payroll/payrollEmployeeService.ts` | CRUD for `payroll_employees` + `payroll_bank_details` |
| `src/modules/accounting/services/payroll/payrollComponentService.ts` | CRUD for `payroll_components` + `payroll_employee_components` |
| `src/modules/accounting/services/payroll/payrollRunService.ts` | Load employees → calculate → save `payroll_runs` + `payroll_run_lines` |

### New files — API routes

| Path | Responsibility |
|------|---------------|
| `pages/api/payroll/employees/index.ts` | GET list, POST create |
| `pages/api/payroll/employees/[id].ts` | GET, PATCH, DELETE |
| `pages/api/payroll/components/index.ts` | GET list, POST create |
| `pages/api/payroll/runs/index.ts` | GET list, POST create run |
| `pages/api/payroll/runs/[id].ts` | GET run detail with lines |
| `pages/api/payroll/runs/[id]/calculate.ts` | POST — trigger calculation |
| `pages/api/payroll/validate/index.ts` | POST — validate employees/run |

### New files — Migrations (range 380–389)

| Path | Responsibility |
|------|---------------|
| `scripts/migrations/sql/380_payroll_employees.sql` | `payroll_employees` + `payroll_bank_details` tables |
| `scripts/migrations/sql/381_payroll_components.sql` | `payroll_components` + `payroll_employee_components` tables |
| `scripts/migrations/sql/382_payroll_runs.sql` | `payroll_runs` (new company-scoped) + `payroll_run_lines` tables |
| `scripts/migrations/sql/383_payroll_leave.sql` | `payroll_leave_types` + `payroll_leave_balances` + `payroll_leave_requests` |

### New files — Tests

| Path | Responsibility |
|------|---------------|
| `tests/unit/services/payroll/payeEngine.test.ts` | Golden-file: known salary → known PAYE |
| `tests/unit/services/payroll/uifEngine.test.ts` | Ceiling, rate, domestic exclusion |
| `tests/unit/services/payroll/sdlEngine.test.ts` | Threshold gate, rate |
| `tests/unit/services/payroll/etiEngine.test.ts` | Eligibility, year 1/2 amounts |
| `tests/unit/services/payroll/payrollCalculator.test.ts` | Property tests: gross = Σ components, net = gross − deductions, PAYE ≥ 0 |
| `tests/unit/services/payroll/validationEngine.test.ts` | Each validation rule fires correctly |

### Modified files

| Path | Change |
|------|--------|
| `src/components/layout/accountingNavConfig.ts` | Add Payroll section with Employees, Components, Runs links |

---

## Critical conventions

- **Migrations:** `IF NOT EXISTS` on every `CREATE TABLE` / `CREATE INDEX`. Include `company_id UUID NOT NULL` on every tenant-scoped table.
- **DB:** `sql` tagged template from `@/lib/neon`. Always `${companyId}::uuid` in WHERE clauses.
- **API handlers:** `withCompany(withErrorHandler(handler as any))`.
- **Responses:** `apiResponse.success()`, `.badRequest()`, `.notFound()` from `@/lib/apiResponse`.
- **Logger:** `log.info/warn/error(msg, {meta}, 'category')` — never `console.log`.
- **No empty catch blocks.**
- **Max 300 lines per file.**
- **Tests:** run with `bunx vitest run tests/unit/services/payroll/<file>.test.ts --reporter=verbose`.
- **Commit after each passing test group.**

---

## Task 1: Migrations — Core payroll data model

**Files:**
- Create: `scripts/migrations/sql/380_payroll_employees.sql`
- Create: `scripts/migrations/sql/381_payroll_components.sql`
- Create: `scripts/migrations/sql/382_payroll_runs.sql`
- Create: `scripts/migrations/sql/383_payroll_leave.sql`

- [ ] **Step 1: Write migration 380 — payroll_employees + payroll_bank_details**

```sql
-- 380_payroll_employees.sql
-- SA-compliant employee master for payroll (separate from accounting 'employees' table).
-- Includes ID, tax, UIF, equity fields required for IRP5/EMP201.

CREATE TABLE IF NOT EXISTS payroll_employees (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL,
  employee_number       VARCHAR(20) NOT NULL,
  first_name            VARCHAR(100) NOT NULL,
  last_name             VARCHAR(100) NOT NULL,
  id_number             VARCHAR(13),
  passport_number       VARCHAR(30),
  tax_number            VARCHAR(20),
  tax_directive_number  VARCHAR(30),
  employment_type       VARCHAR(20) NOT NULL DEFAULT 'permanent'
    CHECK (employment_type IN ('permanent', 'contract', 'casual', 'director')),
  start_date            DATE NOT NULL,
  end_date              DATE,
  uif_number            VARCHAR(30),
  uif_excluded          BOOLEAN NOT NULL DEFAULT FALSE,
  equity_race           VARCHAR(30)
    CHECK (equity_race IN ('african', 'coloured', 'indian', 'white', 'foreign', NULL)),
  equity_gender         VARCHAR(10)
    CHECK (equity_gender IN ('male', 'female', NULL)),
  equity_disability     BOOLEAN NOT NULL DEFAULT FALSE,
  date_of_birth         DATE,
  department            VARCHAR(100),
  cost_centre           VARCHAR(100),
  status                VARCHAR(10) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'terminated')),
  medical_aid_main_member      BOOLEAN NOT NULL DEFAULT TRUE,
  medical_aid_dependants_count INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, employee_number)
);

CREATE INDEX IF NOT EXISTS idx_payroll_employees_company
  ON payroll_employees (company_id);
CREATE INDEX IF NOT EXISTS idx_payroll_employees_tax
  ON payroll_employees (company_id, tax_number);
CREATE INDEX IF NOT EXISTS idx_payroll_employees_status
  ON payroll_employees (company_id, status);

CREATE TABLE IF NOT EXISTS payroll_bank_details (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  bank_name       VARCHAR(100) NOT NULL,
  account_number  VARCHAR(30) NOT NULL,
  account_type    VARCHAR(20) NOT NULL DEFAULT 'cheque'
    CHECK (account_type IN ('cheque', 'savings', 'transmission')),
  branch_code     VARCHAR(10) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_bank_details_employee
  ON payroll_bank_details (employee_id);
```

- [ ] **Step 2: Write migration 381 — payroll_components + payroll_employee_components**

```sql
-- 381_payroll_components.sql
-- Component catalogue with SARS source codes; employee-level effective-date assignments.

CREATE TABLE IF NOT EXISTS payroll_components (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL,
  name              VARCHAR(100) NOT NULL,
  sars_source_code  VARCHAR(10) NOT NULL,
  component_type    VARCHAR(20) NOT NULL
    CHECK (component_type IN ('earning', 'deduction', 'employer_contribution')),
  is_taxable        BOOLEAN NOT NULL DEFAULT TRUE,
  is_uif_applicable BOOLEAN NOT NULL DEFAULT TRUE,
  is_sdl_applicable BOOLEAN NOT NULL DEFAULT TRUE,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_payroll_components_company
  ON payroll_components (company_id);

CREATE TABLE IF NOT EXISTS payroll_employee_components (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  component_id  UUID NOT NULL REFERENCES payroll_components(id) ON DELETE RESTRICT,
  amount        NUMERIC(14,2) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payroll_emp_components_employee
  ON payroll_employee_components (employee_id);
CREATE INDEX IF NOT EXISTS idx_payroll_emp_components_effective
  ON payroll_employee_components (employee_id, effective_from, effective_to);
```

- [ ] **Step 3: Write migration 382 — payroll_runs (new company-scoped) + payroll_run_lines**

```sql
-- 382_payroll_runs.sql
-- New company-scoped payroll_runs table (replaces old unscoped payroll_runs).
-- payroll_run_lines stores per-employee per-component breakdown.

CREATE TABLE IF NOT EXISTS payroll_run_headers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL,
  period_month    INT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  period_year     INT NOT NULL CHECK (period_year >= 2020),
  status          VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'calculated', 'approved', 'paid', 'cancelled')),
  run_date        DATE,
  total_gross     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_taxable   NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_paye      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_uif       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_sdl       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_eti       NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_net       NUMERIC(14,2) NOT NULL DEFAULT 0,
  employee_count  INT NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS idx_prh_company
  ON payroll_run_headers (company_id);
CREATE INDEX IF NOT EXISTS idx_prh_period
  ON payroll_run_headers (company_id, period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_prh_status
  ON payroll_run_headers (company_id, status);

CREATE TABLE IF NOT EXISTS payroll_run_lines (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES payroll_run_headers(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE RESTRICT,
  gross_pay       NUMERIC(14,2) NOT NULL DEFAULT 0,
  taxable_income  NUMERIC(14,2) NOT NULL DEFAULT 0,
  paye            NUMERIC(14,2) NOT NULL DEFAULT 0,
  uif_employee    NUMERIC(14,2) NOT NULL DEFAULT 0,
  uif_employer    NUMERIC(14,2) NOT NULL DEFAULT 0,
  sdl             NUMERIC(14,2) NOT NULL DEFAULT 0,
  eti             NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay         NUMERIC(14,2) NOT NULL DEFAULT 0,
  component_breakdown JSONB NOT NULL DEFAULT '[]',
  validation_results  JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_prl_run
  ON payroll_run_lines (run_id);
CREATE INDEX IF NOT EXISTS idx_prl_employee
  ON payroll_run_lines (employee_id);
```

- [ ] **Step 4: Write migration 383 — leave tables**

```sql
-- 383_payroll_leave.sql
-- BCEA-compliant leave types, balances, and requests.

CREATE TABLE IF NOT EXISTS payroll_leave_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL,
  name            VARCHAR(100) NOT NULL,
  bcea_type       VARCHAR(30)
    CHECK (bcea_type IN ('annual', 'sick', 'family_responsibility', 'maternity', 'paternity', 'unpaid', 'study', 'other')),
  accrual_rule    VARCHAR(20) NOT NULL DEFAULT 'monthly'
    CHECK (accrual_rule IN ('monthly', 'cycle_30_per_36', 'none')),
  accrual_days    NUMERIC(5,2) NOT NULL DEFAULT 1.25,
  max_carry_over  NUMERIC(5,2),
  is_paid         BOOLEAN NOT NULL DEFAULT TRUE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plt_company ON payroll_leave_types (company_id);

CREATE TABLE IF NOT EXISTS payroll_leave_balances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  leave_type_id   UUID NOT NULL REFERENCES payroll_leave_types(id) ON DELETE RESTRICT,
  balance_year    INT NOT NULL,
  accrued         NUMERIC(6,2) NOT NULL DEFAULT 0,
  taken           NUMERIC(6,2) NOT NULL DEFAULT 0,
  pending         NUMERIC(6,2) NOT NULL DEFAULT 0,
  balance         NUMERIC(6,2) GENERATED ALWAYS AS (accrued - taken - pending) STORED,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, leave_type_id, balance_year)
);

CREATE INDEX IF NOT EXISTS idx_plb_employee ON payroll_leave_balances (employee_id);

CREATE TABLE IF NOT EXISTS payroll_leave_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  leave_type_id   UUID NOT NULL REFERENCES payroll_leave_types(id) ON DELETE RESTRICT,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  days            NUMERIC(5,2) NOT NULL,
  reason          TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approved_by     UUID,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plr_employee ON payroll_leave_requests (employee_id, status);
```

- [ ] **Step 5: Commit migrations**

```bash
git add scripts/migrations/sql/380_payroll_employees.sql \
        scripts/migrations/sql/381_payroll_components.sql \
        scripts/migrations/sql/382_payroll_runs.sql \
        scripts/migrations/sql/383_payroll_leave.sql
git commit -m "feat(payroll): migrations 380-383 — payroll_employees, components, run_headers, run_lines, leave"
```

---

## Task 2: Shared types + tax tables data

**Files:**
- Create: `src/modules/accounting/services/payroll/payrollTypes.ts`
- Create: `src/modules/accounting/services/payroll/taxTables.ts`

- [ ] **Step 1: Write `payrollTypes.ts`**

```typescript
// src/modules/accounting/services/payroll/payrollTypes.ts

export type EmploymentType = 'permanent' | 'contract' | 'casual' | 'director';

export interface PayrollEmployee {
  id: string;
  companyId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  idNumber?: string;
  taxNumber?: string;
  employmentType: EmploymentType;
  startDate: Date;
  endDate?: Date;
  dateOfBirth?: Date;
  uifExcluded: boolean;
  medicalAidMainMember: boolean;
  medicalAidDependantsCount: number;
}

export interface PayrollComponent {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: 'earning' | 'deduction' | 'employer_contribution';
  isTaxable: boolean;
  isUifApplicable: boolean;
  isSdlApplicable: boolean;
}

export interface EmployeeComponent {
  component: PayrollComponent;
  amount: number;
}

export interface PayrollPeriod {
  month: number;
  year: number;
}

export interface PayeInput {
  annualTaxableIncome: number;
  ageAtPeriodEnd: number;
  monthlyMedicalBeneficiaries: number;
  taxYear: number;
}

export interface PayeResult {
  annualTax: number;
  monthlyPaye: number;
  effectiveRate: number;
  rebatesApplied: number;
  medicalCreditsApplied: number;
}

export interface UifResult {
  employeeContribution: number;
  employerContribution: number;
  isCapped: boolean;
}

export interface EtiInput {
  dateOfBirth: Date;
  employmentStartDate: Date;
  periodDate: Date;
  monthlyRemuneration: number;
  isUifExcluded: boolean;
}

export interface EtiResult {
  isEligible: boolean;
  ineligibilityReason?: string;
  monthsEmployed: number;
  employmentYear: 1 | 2 | null;
  monthlyEti: number;
}

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationResult {
  code: string;
  severity: ValidationSeverity;
  message: string;
  field?: string;
  deepLink?: string;
}

export interface PayrollLineInput {
  employee: PayrollEmployee;
  components: EmployeeComponent[];
  period: PayrollPeriod;
  taxYear: number;
  annualPayrollEstimate: number;
  priorPeriodCumulativePaye?: number;
}

export interface ComponentBreakdownItem {
  componentId: string;
  componentName: string;
  sarsSourceCode: string;
  amount: number;
  isTaxable: boolean;
  isUifApplicable: boolean;
}

export interface PayrollLineResult {
  employeeId: string;
  grossPay: number;
  taxableIncome: number;
  paye: PayeResult;
  uif: UifResult;
  sdl: number;
  eti: EtiResult;
  netPay: number;
  componentBreakdown: ComponentBreakdownItem[];
  validationResults: ValidationResult[];
}
```

- [ ] **Step 2: Write `taxTables.ts`**

```typescript
// src/modules/accounting/services/payroll/taxTables.ts

export interface TaxBracket {
  from: number;
  to: number;
  baseTax: number;
  rate: number;
}

export interface TaxYearConfig {
  year: number;
  brackets: TaxBracket[];
  primaryRebate: number;
  secondaryRebate: number;
  tertiaryRebate: number;
  thresholdBelow65: number;
  threshold65to74: number;
  threshold75plus: number;
  medicalCreditMainAndFirst: number;
  medicalCreditAdditional: number;
  uifCeiling: number;
  sdlThresholdAnnual: number;
  etiYearOneMax: number;
  etiYearTwoMax: number;
  etiWageCeiling: number;
  etiWageFloor: number;
}

const TAX_2025: TaxYearConfig = {
  year: 2025,
  brackets: [
    { from: 0,         to: 237_100,   baseTax: 0,       rate: 0.18 },
    { from: 237_101,   to: 370_500,   baseTax: 42_678,  rate: 0.26 },
    { from: 370_501,   to: 512_800,   baseTax: 77_362,  rate: 0.31 },
    { from: 512_801,   to: 673_000,   baseTax: 121_475, rate: 0.36 },
    { from: 673_001,   to: 857_900,   baseTax: 179_147, rate: 0.39 },
    { from: 857_901,   to: 1_817_000, baseTax: 251_258, rate: 0.41 },
    { from: 1_817_001, to: Infinity,  baseTax: 644_489, rate: 0.45 },
  ],
  primaryRebate:   17_235,
  secondaryRebate:  9_444,
  tertiaryRebate:   3_145,
  thresholdBelow65:  95_750,
  threshold65to74:  148_217,
  threshold75plus:  165_689,
  medicalCreditMainAndFirst: 364,
  medicalCreditAdditional:   246,
  uifCeiling:      17_712,
  sdlThresholdAnnual: 500_000,
  etiYearOneMax:    1_500,
  etiYearTwoMax:      750,
  etiWageCeiling:   7_500,
  etiWageFloor:     2_000,
};

// 2026 tax year (March 2025 – February 2026) — update when SARS publishes
const TAX_2026: TaxYearConfig = {
  ...TAX_2025,
  year: 2026,
};

const TAX_TABLE_REGISTRY: Record<number, TaxYearConfig> = {
  2025: TAX_2025,
  2026: TAX_2026,
};

export function getTaxYear(periodMonth: number, periodYear: number): number {
  // SA tax year ends in February; March starts the new year.
  // periodMonth 3 (March) of periodYear 2024 → taxYear 2025 (ends Feb 2025)
  return periodMonth >= 3 ? periodYear + 1 : periodYear;
}

export function getTaxYearConfig(taxYear: number): TaxYearConfig {
  const config = TAX_TABLE_REGISTRY[taxYear];
  if (!config) {
    const latestYear = Math.max(...Object.keys(TAX_TABLE_REGISTRY).map(Number));
    return TAX_TABLE_REGISTRY[latestYear];
  }
  return config;
}

export function computeAnnualTax(annualIncome: number, brackets: TaxBracket[]): number {
  for (const bracket of brackets) {
    if (annualIncome <= bracket.to) {
      return bracket.baseTax + bracket.rate * (annualIncome - bracket.from + 1);
    }
  }
  const last = brackets[brackets.length - 1];
  return last.baseTax + last.rate * (annualIncome - last.from + 1);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/accounting/services/payroll/payrollTypes.ts \
        src/modules/accounting/services/payroll/taxTables.ts
git commit -m "feat(payroll): shared types + SARS 2024/2025 tax tables"
```

---

## Task 3: PAYE engine — TDD

**Files:**
- Create: `tests/unit/services/payroll/payeEngine.test.ts`
- Create: `src/modules/accounting/services/payroll/payeEngine.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/services/payroll/payeEngine.test.ts
import { describe, it, expect } from 'vitest';
import { calculatePAYE } from '@/modules/accounting/services/payroll/payeEngine';

describe('PAYE engine — 2024/2025 tax year', () => {
  it('returns zero for income below threshold (age < 65)', () => {
    const result = calculatePAYE({
      annualTaxableIncome: 90_000,
      ageAtPeriodEnd: 25,
      monthlyMedicalBeneficiaries: 0,
      taxYear: 2025,
    });
    expect(result.monthlyPaye).toBe(0);
    expect(result.annualTax).toBe(0);
  });

  it('golden-file: R25,000/month, age 30, no medical', () => {
    // Annual R300,000 → bracket 2: R42,678 + 26% × 62,900 = R59,032
    // Less primary rebate R17,235 → R41,797 annual → R3,483.08/month
    const result = calculatePAYE({
      annualTaxableIncome: 300_000,
      ageAtPeriodEnd: 30,
      monthlyMedicalBeneficiaries: 0,
      taxYear: 2025,
    });
    expect(result.annualTax).toBeCloseTo(41_797, 0);
    expect(result.monthlyPaye).toBeCloseTo(3_483.08, 1);
    expect(result.effectiveRate).toBeCloseTo(0.1393, 3);
  });

  it('golden-file: R50,000/month, age 45, 2 medical beneficiaries', () => {
    // Annual R600,000 → bracket 4: R121,475 + 36% × 87,200 = R152,867
    // Less primary rebate R17,235 → R135,632
    // Medical credits: R364 × 2 × 12 = R8,736
    // Net annual PAYE: R126,896 → monthly R10,574.67
    const result = calculatePAYE({
      annualTaxableIncome: 600_000,
      ageAtPeriodEnd: 45,
      monthlyMedicalBeneficiaries: 2,
      taxYear: 2025,
    });
    expect(result.annualTax).toBeCloseTo(126_896, 0);
    expect(result.monthlyPaye).toBeCloseTo(10_574.67, 1);
    expect(result.medicalCreditsApplied).toBeCloseTo(8_736, 0);
  });

  it('golden-file: age 66, R20,000/month (secondary rebate applies)', () => {
    // Annual R240,000 → bracket 2: R42,678 + 26% × 2,900 = R43,432
    // Less primary + secondary: R17,235 + R9,444 = R26,679
    // Annual PAYE: R16,753 → monthly R1,396.08
    const result = calculatePAYE({
      annualTaxableIncome: 240_000,
      ageAtPeriodEnd: 66,
      monthlyMedicalBeneficiaries: 0,
      taxYear: 2025,
    });
    expect(result.annualTax).toBeCloseTo(16_753, 0);
    expect(result.monthlyPaye).toBeCloseTo(1_396.08, 1);
    expect(result.rebatesApplied).toBeCloseTo(26_679, 0);
  });

  it('age 66, income below 65-74 threshold → zero PAYE', () => {
    const result = calculatePAYE({
      annualTaxableIncome: 140_000,
      ageAtPeriodEnd: 66,
      monthlyMedicalBeneficiaries: 0,
      taxYear: 2025,
    });
    expect(result.monthlyPaye).toBe(0);
  });

  it('golden-file: R100,000/month, age 50, 4 medical beneficiaries, top bracket', () => {
    // Annual R1,200,000 → bracket 6: R251,258 + 41% × (1,200,000 - 857,900)
    //   = R251,258 + 41% × 342,100 = R251,258 + 140,261 = R391,519
    // Less primary: R17,235 → R374,284
    // Medical credits: main+1st at R364 each = R728/month × 12 = R8,736 (2 ppl)
    //   additional 2 at R246 each = R492/month × 12 = R5,904
    //   total annual credits = R14,640
    // Net: R374,284 - R14,640 = R359,644 → monthly R29,970.33
    const result = calculatePAYE({
      annualTaxableIncome: 1_200_000,
      ageAtPeriodEnd: 50,
      monthlyMedicalBeneficiaries: 4,
      taxYear: 2025,
    });
    expect(result.annualTax).toBeCloseTo(359_644, 0);
    expect(result.monthlyPaye).toBeCloseTo(29_970.33, 1);
  });

  it('PAYE never goes negative', () => {
    const result = calculatePAYE({
      annualTaxableIncome: 100_000,
      ageAtPeriodEnd: 30,
      monthlyMedicalBeneficiaries: 10,
      taxYear: 2025,
    });
    expect(result.monthlyPaye).toBeGreaterThanOrEqual(0);
    expect(result.annualTax).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (file not found)**

```bash
bunx vitest run tests/unit/services/payroll/payeEngine.test.ts --reporter=verbose
```

Expected: `Cannot find module '@/modules/accounting/services/payroll/payeEngine'`

- [ ] **Step 3: Implement `payeEngine.ts`**

```typescript
// src/modules/accounting/services/payroll/payeEngine.ts
import { getTaxYearConfig, computeAnnualTax } from './taxTables';
import type { PayeInput, PayeResult } from './payrollTypes';

function getAge(dateOfBirth: Date, atDate: Date): number {
  const years = atDate.getFullYear() - dateOfBirth.getFullYear();
  const m = atDate.getMonth() - dateOfBirth.getMonth();
  return m < 0 || (m === 0 && atDate.getDate() < dateOfBirth.getDate())
    ? years - 1
    : years;
}

function computeRebates(age: number, config: ReturnType<typeof getTaxYearConfig>): number {
  let rebates = config.primaryRebate;
  if (age >= 65) rebates += config.secondaryRebate;
  if (age >= 75) rebates += config.tertiaryRebate;
  return rebates;
}

function computeAnnualMedicalCredits(
  monthlyBeneficiaries: number,
  config: ReturnType<typeof getTaxYearConfig>,
): number {
  if (monthlyBeneficiaries <= 0) return 0;
  const mainAndFirst = Math.min(monthlyBeneficiaries, 2) * config.medicalCreditMainAndFirst;
  const additional = Math.max(0, monthlyBeneficiaries - 2) * config.medicalCreditAdditional;
  return (mainAndFirst + additional) * 12;
}

export function calculatePAYE(input: PayeInput): PayeResult {
  const config = getTaxYearConfig(input.taxYear);
  const age = input.ageAtPeriodEnd;

  const rebates = computeRebates(age, config);
  const annualMedicalCredits = computeAnnualMedicalCredits(
    input.monthlyMedicalBeneficiaries,
    config,
  );

  const grossAnnualTax = computeAnnualTax(input.annualTaxableIncome, config.brackets);
  const taxAfterRebates = Math.max(0, grossAnnualTax - rebates);
  const annualTax = Math.max(0, taxAfterRebates - annualMedicalCredits);
  const monthlyPaye = Math.round((annualTax / 12) * 100) / 100;

  const effectiveRate =
    input.annualTaxableIncome > 0 ? annualTax / input.annualTaxableIncome : 0;

  return {
    annualTax: Math.round(annualTax * 100) / 100,
    monthlyPaye,
    effectiveRate: Math.round(effectiveRate * 10_000) / 10_000,
    rebatesApplied: Math.round(rebates * 100) / 100,
    medicalCreditsApplied: Math.round(annualMedicalCredits * 100) / 100,
  };
}

export { getAge };
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
bunx vitest run tests/unit/services/payroll/payeEngine.test.ts --reporter=verbose
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/unit/services/payroll/payeEngine.test.ts \
        src/modules/accounting/services/payroll/payeEngine.ts
git commit -m "feat(payroll): PAYE engine with SA 2024/2025 tax tables — all golden-file tests pass"
```

---

## Task 4: UIF engine — TDD

**Files:**
- Create: `tests/unit/services/payroll/uifEngine.test.ts`
- Create: `src/modules/accounting/services/payroll/uifEngine.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/services/payroll/uifEngine.test.ts
import { describe, it, expect } from 'vitest';
import { calculateUIF } from '@/modules/accounting/services/payroll/uifEngine';

describe('UIF engine', () => {
  it('1% employee + 1% employer on regular salary', () => {
    const result = calculateUIF(10_000, 2025);
    expect(result.employeeContribution).toBeCloseTo(100, 2);
    expect(result.employerContribution).toBeCloseTo(100, 2);
    expect(result.isCapped).toBe(false);
  });

  it('caps at R17,712/month ceiling', () => {
    const result = calculateUIF(25_000, 2025);
    expect(result.employeeContribution).toBeCloseTo(177.12, 2);
    expect(result.employerContribution).toBeCloseTo(177.12, 2);
    expect(result.isCapped).toBe(true);
  });

  it('salary exactly at ceiling — no cap', () => {
    const result = calculateUIF(17_712, 2025);
    expect(result.employeeContribution).toBeCloseTo(177.12, 2);
    expect(result.isCapped).toBe(false);
  });

  it('salary just above ceiling — caps', () => {
    const result = calculateUIF(17_713, 2025);
    expect(result.isCapped).toBe(true);
    expect(result.employeeContribution).toBeCloseTo(177.12, 2);
  });

  it('zero salary → zero UIF', () => {
    const result = calculateUIF(0, 2025);
    expect(result.employeeContribution).toBe(0);
    expect(result.employerContribution).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bunx vitest run tests/unit/services/payroll/uifEngine.test.ts --reporter=verbose
```

- [ ] **Step 3: Implement `uifEngine.ts`**

```typescript
// src/modules/accounting/services/payroll/uifEngine.ts
import { getTaxYearConfig } from './taxTables';
import type { UifResult } from './payrollTypes';

export function calculateUIF(monthlySalary: number, taxYear: number): UifResult {
  const config = getTaxYearConfig(taxYear);
  const leviable = Math.min(monthlySalary, config.uifCeiling);
  const contribution = Math.round(leviable * 0.01 * 100) / 100;
  return {
    employeeContribution: contribution,
    employerContribution: contribution,
    isCapped: monthlySalary > config.uifCeiling,
  };
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bunx vitest run tests/unit/services/payroll/uifEngine.test.ts --reporter=verbose
```

- [ ] **Step 5: Commit**

```bash
git add tests/unit/services/payroll/uifEngine.test.ts \
        src/modules/accounting/services/payroll/uifEngine.ts
git commit -m "feat(payroll): UIF engine — ceiling-capped 1%+1% contributions"
```

---

## Task 5: SDL engine — TDD

**Files:**
- Create: `tests/unit/services/payroll/sdlEngine.test.ts`
- Create: `src/modules/accounting/services/payroll/sdlEngine.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/services/payroll/sdlEngine.test.ts
import { describe, it, expect } from 'vitest';
import { calculateSDL } from '@/modules/accounting/services/payroll/sdlEngine';

describe('SDL engine', () => {
  it('charges 1% when annual payroll exceeds R500,000', () => {
    const sdl = calculateSDL(25_000, 700_000, 2025);
    expect(sdl).toBeCloseTo(250, 2);
  });

  it('zero when annual payroll is below R500,000', () => {
    const sdl = calculateSDL(25_000, 400_000, 2025);
    expect(sdl).toBe(0);
  });

  it('zero when annual payroll exactly equals R500,000', () => {
    const sdl = calculateSDL(25_000, 500_000, 2025);
    expect(sdl).toBe(0);
  });

  it('charges 1% when annual payroll is R500,001', () => {
    const sdl = calculateSDL(25_000, 500_001, 2025);
    expect(sdl).toBeCloseTo(250, 2);
  });

  it('zero monthly salary → zero SDL even with large payroll', () => {
    const sdl = calculateSDL(0, 1_000_000, 2025);
    expect(sdl).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bunx vitest run tests/unit/services/payroll/sdlEngine.test.ts --reporter=verbose
```

- [ ] **Step 3: Implement `sdlEngine.ts`**

```typescript
// src/modules/accounting/services/payroll/sdlEngine.ts
import { getTaxYearConfig } from './taxTables';

export function calculateSDL(
  monthlyLeviableAmount: number,
  estimatedAnnualPayroll: number,
  taxYear: number,
): number {
  const config = getTaxYearConfig(taxYear);
  if (estimatedAnnualPayroll <= config.sdlThresholdAnnual) return 0;
  return Math.round(monthlyLeviableAmount * 0.01 * 100) / 100;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bunx vitest run tests/unit/services/payroll/sdlEngine.test.ts --reporter=verbose
```

- [ ] **Step 5: Commit**

```bash
git add tests/unit/services/payroll/sdlEngine.test.ts \
        src/modules/accounting/services/payroll/sdlEngine.ts
git commit -m "feat(payroll): SDL engine — 1% threshold-gated levy"
```

---

## Task 6: ETI engine — TDD

**Files:**
- Create: `tests/unit/services/payroll/etiEngine.test.ts`
- Create: `src/modules/accounting/services/payroll/etiEngine.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/services/payroll/etiEngine.test.ts
import { describe, it, expect } from 'vitest';
import { calculateEti } from '@/modules/accounting/services/payroll/etiEngine';

const periodDate = new Date('2025-03-31');

function dob(yearsAgo: number): Date {
  const d = new Date(periodDate);
  d.setFullYear(d.getFullYear() - yearsAgo);
  return d;
}

function startDate(monthsAgo: number): Date {
  const d = new Date(periodDate);
  d.setMonth(d.getMonth() - monthsAgo);
  return d;
}

describe('ETI engine — eligibility', () => {
  it('age 36 → ineligible (too old)', () => {
    const result = calculateEti({
      dateOfBirth: dob(36),
      employmentStartDate: startDate(3),
      periodDate,
      monthlyRemuneration: 4_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(false);
    expect(result.ineligibilityReason).toContain('age');
    expect(result.monthlyEti).toBe(0);
  });

  it('age 17 → ineligible (too young)', () => {
    const result = calculateEti({
      dateOfBirth: dob(17),
      employmentStartDate: startDate(2),
      periodDate,
      monthlyRemuneration: 3_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(false);
  });

  it('UIF excluded employee → ineligible', () => {
    const result = calculateEti({
      dateOfBirth: dob(25),
      employmentStartDate: startDate(2),
      periodDate,
      monthlyRemuneration: 3_000,
      isUifExcluded: true,
    }, 2025);
    expect(result.isEligible).toBe(false);
    expect(result.ineligibilityReason).toContain('UIF');
  });

  it('wage above R7,500 → ineligible', () => {
    const result = calculateEti({
      dateOfBirth: dob(25),
      employmentStartDate: startDate(3),
      periodDate,
      monthlyRemuneration: 8_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(false);
    expect(result.ineligibilityReason).toContain('wage');
  });
});

describe('ETI engine — year 1 calculations', () => {
  it('wage ≤ R4,500 in year 1 → R1,500', () => {
    const result = calculateEti({
      dateOfBirth: dob(22),
      employmentStartDate: startDate(3),
      periodDate,
      monthlyRemuneration: 3_500,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(true);
    expect(result.employmentYear).toBe(1);
    expect(result.monthlyEti).toBeCloseTo(1_500, 2);
  });

  it('wage R6,000 in year 1 → R750 (linear taper)', () => {
    // 1500 × (7500 - 6000) / 3000 = 1500 × 0.5 = 750
    const result = calculateEti({
      dateOfBirth: dob(25),
      employmentStartDate: startDate(8),
      periodDate,
      monthlyRemuneration: 6_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(true);
    expect(result.monthlyEti).toBeCloseTo(750, 2);
  });

  it('wage exactly R7,500 in year 1 → R0 (at ceiling)', () => {
    const result = calculateEti({
      dateOfBirth: dob(25),
      employmentStartDate: startDate(6),
      periodDate,
      monthlyRemuneration: 7_500,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(true);
    expect(result.monthlyEti).toBeCloseTo(0, 2);
  });
});

describe('ETI engine — year 2 calculations', () => {
  it('wage ≤ R4,500 in year 2 → R750', () => {
    const result = calculateEti({
      dateOfBirth: dob(22),
      employmentStartDate: startDate(15),
      periodDate,
      monthlyRemuneration: 4_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(true);
    expect(result.employmentYear).toBe(2);
    expect(result.monthlyEti).toBeCloseTo(750, 2);
  });

  it('month 25 → ineligible (ETI window expired)', () => {
    const result = calculateEti({
      dateOfBirth: dob(22),
      employmentStartDate: startDate(25),
      periodDate,
      monthlyRemuneration: 3_000,
      isUifExcluded: false,
    }, 2025);
    expect(result.isEligible).toBe(false);
    expect(result.employmentYear).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bunx vitest run tests/unit/services/payroll/etiEngine.test.ts --reporter=verbose
```

- [ ] **Step 3: Implement `etiEngine.ts`**

```typescript
// src/modules/accounting/services/payroll/etiEngine.ts
import { getTaxYearConfig } from './taxTables';
import { getAge } from './payeEngine';
import type { EtiInput, EtiResult } from './payrollTypes';

function monthsBetween(start: Date, end: Date): number {
  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth())
  );
}

export function calculateEti(input: EtiInput, taxYear: number): EtiResult {
  const config = getTaxYearConfig(taxYear);
  const age = getAge(input.dateOfBirth, input.periodDate);
  const monthsEmployed = monthsBetween(input.employmentStartDate, input.periodDate) + 1;

  if (age < 18 || age > 35) {
    return { isEligible: false, ineligibilityReason: 'Employee age must be 18–35', monthsEmployed, employmentYear: null, monthlyEti: 0 };
  }
  if (input.isUifExcluded) {
    return { isEligible: false, ineligibilityReason: 'UIF-excluded employees do not qualify', monthsEmployed, employmentYear: null, monthlyEti: 0 };
  }
  if (input.monthlyRemuneration > config.etiWageCeiling) {
    return { isEligible: false, ineligibilityReason: `Wage exceeds ETI ceiling of R${config.etiWageCeiling.toLocaleString()}`, monthsEmployed, employmentYear: null, monthlyEti: 0 };
  }
  if (monthsEmployed > 24) {
    return { isEligible: false, ineligibilityReason: 'ETI window (24 months) expired', monthsEmployed, employmentYear: null, monthlyEti: 0 };
  }

  const employmentYear: 1 | 2 = monthsEmployed <= 12 ? 1 : 2;
  const maxEti = employmentYear === 1 ? config.etiYearOneMax : config.etiYearTwoMax;

  let monthlyEti: number;
  if (input.monthlyRemuneration <= config.etiWageFloor) {
    monthlyEti = 0;
  } else if (input.monthlyRemuneration <= 4_500) {
    monthlyEti = maxEti;
  } else {
    const taper = (config.etiWageCeiling - input.monthlyRemuneration) / (config.etiWageCeiling - 4_500);
    monthlyEti = maxEti * taper;
  }

  return {
    isEligible: true,
    monthsEmployed,
    employmentYear,
    monthlyEti: Math.round(Math.max(0, monthlyEti) * 100) / 100,
  };
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bunx vitest run tests/unit/services/payroll/etiEngine.test.ts --reporter=verbose
```

- [ ] **Step 5: Commit**

```bash
git add tests/unit/services/payroll/etiEngine.test.ts \
        src/modules/accounting/services/payroll/etiEngine.ts
git commit -m "feat(payroll): ETI engine — eligibility + year1/year2 linear taper"
```

---

## Task 7: Payroll calculator orchestrator — property tests

**Files:**
- Create: `tests/unit/services/payroll/payrollCalculator.test.ts`
- Create: `src/modules/accounting/services/payroll/payrollCalculator.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/services/payroll/payrollCalculator.test.ts
import { describe, it, expect } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { PayrollLineInput, PayrollEmployee, EmployeeComponent, PayrollComponent } from '@/modules/accounting/services/payroll/payrollTypes';

function makeEmployee(overrides: Partial<PayrollEmployee> = {}): PayrollEmployee {
  return {
    id: 'emp-1',
    companyId: 'co-1',
    employeeNumber: 'E001',
    firstName: 'Test',
    lastName: 'Employee',
    idNumber: '9001015009087',
    taxNumber: '1234567890',
    employmentType: 'permanent',
    startDate: new Date('2023-01-01'),
    dateOfBirth: new Date('1990-01-01'),
    uifExcluded: false,
    medicalAidMainMember: true,
    medicalAidDependantsCount: 0,
    ...overrides,
  };
}

function makeComponent(overrides: Partial<PayrollComponent> = {}): PayrollComponent {
  return {
    id: 'comp-1',
    name: 'Basic Salary',
    sarsSourceCode: '3601',
    componentType: 'earning',
    isTaxable: true,
    isUifApplicable: true,
    isSdlApplicable: true,
    ...overrides,
  };
}

function makeInput(grossSalary: number, annualPayroll: number = 1_000_000): PayrollLineInput {
  return {
    employee: makeEmployee(),
    components: [{ component: makeComponent(), amount: grossSalary }],
    period: { month: 6, year: 2024 },
    taxYear: 2025,
    annualPayrollEstimate: annualPayroll,
  };
}

describe('payrollCalculator — property tests', () => {
  it('gross pay equals sum of earning components', () => {
    const input = makeInput(25_000);
    const result = calculatePayrollLine(input);
    expect(result.grossPay).toBeCloseTo(25_000, 2);
  });

  it('net pay = gross - PAYE - employee UIF - other deductions', () => {
    const input = makeInput(25_000);
    const result = calculatePayrollLine(input);
    const expectedNet = result.grossPay - result.paye.monthlyPaye - result.uif.employeeContribution;
    expect(result.netPay).toBeCloseTo(expectedNet, 2);
  });

  it('PAYE is never negative', () => {
    const input = makeInput(5_000);
    const result = calculatePayrollLine(input);
    expect(result.paye.monthlyPaye).toBeGreaterThanOrEqual(0);
  });

  it('SDL is zero when annual payroll below threshold', () => {
    const input = makeInput(25_000, 300_000);
    const result = calculatePayrollLine(input);
    expect(result.sdl).toBe(0);
  });

  it('SDL is 1% when annual payroll above threshold', () => {
    const input = makeInput(25_000, 1_000_000);
    const result = calculatePayrollLine(input);
    expect(result.sdl).toBeCloseTo(250, 2);
  });

  it('deduction component reduces taxable income and net pay', () => {
    const emp = makeEmployee();
    const salary: EmployeeComponent = { component: makeComponent(), amount: 25_000 };
    const pension: EmployeeComponent = {
      component: makeComponent({
        id: 'comp-2', name: 'Pension Fund', sarsSourceCode: '4001',
        componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false,
      }),
      amount: 2_000,
    };
    const result = calculatePayrollLine({
      employee: emp,
      components: [salary, pension],
      period: { month: 6, year: 2024 },
      taxYear: 2025,
      annualPayrollEstimate: 1_000_000,
    });
    expect(result.taxableIncome).toBeCloseTo(23_000, 2);
    expect(result.grossPay).toBeCloseTo(25_000, 2);
    expect(result.netPay).toBeCloseTo(25_000 - 2_000 - result.paye.monthlyPaye - result.uif.employeeContribution, 2);
  });

  it('non-taxable component does not affect PAYE', () => {
    const taxableBase = calculatePayrollLine(makeInput(25_000)).paye.monthlyPaye;
    const emp = makeEmployee();
    const salary: EmployeeComponent = { component: makeComponent(), amount: 25_000 };
    const reimbursement: EmployeeComponent = {
      component: makeComponent({
        id: 'comp-reim', name: 'Reimbursement', sarsSourceCode: '3713',
        componentType: 'earning', isTaxable: false, isUifApplicable: false, isSdlApplicable: false,
      }),
      amount: 3_000,
    };
    const result = calculatePayrollLine({
      employee: emp,
      components: [salary, reimbursement],
      period: { month: 6, year: 2024 },
      taxYear: 2025,
      annualPayrollEstimate: 1_000_000,
    });
    expect(result.paye.monthlyPaye).toBeCloseTo(taxableBase, 1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bunx vitest run tests/unit/services/payroll/payrollCalculator.test.ts --reporter=verbose
```

- [ ] **Step 3: Implement `payrollCalculator.ts`**

```typescript
// src/modules/accounting/services/payroll/payrollCalculator.ts
import { calculatePAYE, getAge } from './payeEngine';
import { calculateUIF } from './uifEngine';
import { calculateSDL } from './sdlEngine';
import { calculateEti } from './etiEngine';
import { getTaxYear } from './taxTables';
import type {
  PayrollLineInput,
  PayrollLineResult,
  ComponentBreakdownItem,
} from './payrollTypes';

export function calculatePayrollLine(input: PayrollLineInput): PayrollLineResult {
  const { employee, components, period, taxYear, annualPayrollEstimate } = input;

  const periodDate = new Date(period.year, period.month - 1, 28);
  const age = employee.dateOfBirth ? getAge(employee.dateOfBirth, periodDate) : 30;

  let grossPay = 0;
  let taxableIncome = 0;
  let uifLeviable = 0;
  let sdlLeviable = 0;
  let totalDeductions = 0;

  const breakdown: ComponentBreakdownItem[] = [];

  for (const { component, amount } of components) {
    breakdown.push({
      componentId: component.id,
      componentName: component.name,
      sarsSourceCode: component.sarsSourceCode,
      amount,
      isTaxable: component.isTaxable,
      isUifApplicable: component.isUifApplicable,
    });

    if (component.componentType === 'earning') {
      grossPay += amount;
      if (component.isTaxable) taxableIncome += amount;
      if (component.isUifApplicable) uifLeviable += amount;
      if (component.isSdlApplicable) sdlLeviable += amount;
    } else if (component.componentType === 'deduction') {
      totalDeductions += amount;
      if (component.isTaxable) taxableIncome -= amount;
    }
  }

  taxableIncome = Math.max(0, taxableIncome);

  const medicalBeneficiaries = employee.medicalAidMainMember
    ? 1 + employee.medicalAidDependantsCount
    : employee.medicalAidDependantsCount;

  const paye = calculatePAYE({
    annualTaxableIncome: taxableIncome * 12,
    ageAtPeriodEnd: age,
    monthlyMedicalBeneficiaries: medicalBeneficiaries,
    taxYear,
  });

  const uif = employee.uifExcluded
    ? { employeeContribution: 0, employerContribution: 0, isCapped: false }
    : calculateUIF(uifLeviable, taxYear);

  const sdl = calculateSDL(sdlLeviable, annualPayrollEstimate, taxYear);

  const eti = employee.dateOfBirth && employee.startDate
    ? calculateEti({
        dateOfBirth: employee.dateOfBirth,
        employmentStartDate: employee.startDate,
        periodDate,
        monthlyRemuneration: grossPay,
        isUifExcluded: employee.uifExcluded,
      }, taxYear)
    : { isEligible: false, monthsEmployed: 0, employmentYear: null, monthlyEti: 0 } as const;

  const netPay = Math.round(
    (grossPay - totalDeductions - paye.monthlyPaye - uif.employeeContribution) * 100,
  ) / 100;

  return {
    employeeId: employee.id,
    grossPay: Math.round(grossPay * 100) / 100,
    taxableIncome: Math.round(taxableIncome * 100) / 100,
    paye,
    uif,
    sdl: Math.round(sdl * 100) / 100,
    eti: { ...eti, ineligibilityReason: 'ineligibilityReason' in eti ? eti.ineligibilityReason : undefined },
    netPay: Math.max(0, netPay),
    componentBreakdown: breakdown,
    validationResults: [],
  };
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bunx vitest run tests/unit/services/payroll/payrollCalculator.test.ts --reporter=verbose
```

- [ ] **Step 5: Run all payroll tests together**

```bash
bunx vitest run tests/unit/services/payroll/ --reporter=verbose
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/services/payroll/payrollCalculator.test.ts \
        src/modules/accounting/services/payroll/payrollCalculator.ts
git commit -m "feat(payroll): payrollCalculator orchestrator — all property tests pass"
```

---

## Task 8: SARS validation engine — TDD

**Files:**
- Create: `tests/unit/services/payroll/validationEngine.test.ts`
- Create: `src/modules/accounting/services/payroll/validationEngine.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/unit/services/payroll/validationEngine.test.ts
import { describe, it, expect } from 'vitest';
import { validateEmployee, validatePayrollLine } from '@/modules/accounting/services/payroll/validationEngine';
import type { PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

function baseEmployee(): PayrollEmployee {
  return {
    id: 'emp-1', companyId: 'co-1', employeeNumber: 'E001',
    firstName: 'Test', lastName: 'Employee',
    idNumber: '9001015009087',
    taxNumber: '1234567890',
    employmentType: 'permanent',
    startDate: new Date('2020-01-01'),
    uifExcluded: false,
    medicalAidMainMember: true,
    medicalAidDependantsCount: 0,
  };
}

describe('validateEmployee', () => {
  it('passes for a complete, valid employee', () => {
    const results = validateEmployee(baseEmployee(), []);
    const errors = results.filter(r => r.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('error: missing tax number', () => {
    const emp = { ...baseEmployee(), taxNumber: undefined };
    const results = validateEmployee(emp, []);
    expect(results.some(r => r.code === 'MISSING_TAX_NUMBER' && r.severity === 'error')).toBe(true);
  });

  it('error: tax number wrong length (not 10 digits)', () => {
    const emp = { ...baseEmployee(), taxNumber: '12345' };
    const results = validateEmployee(emp, []);
    expect(results.some(r => r.code === 'INVALID_TAX_NUMBER_FORMAT' && r.severity === 'error')).toBe(true);
  });

  it('error: SA ID number wrong length', () => {
    const emp = { ...baseEmployee(), idNumber: '123' };
    const results = validateEmployee(emp, []);
    expect(results.some(r => r.code === 'INVALID_ID_NUMBER' && r.severity === 'error')).toBe(true);
  });

  it('error: duplicate tax number detected', () => {
    const emp = baseEmployee();
    const existingTaxNumbers = ['1234567890'];
    const results = validateEmployee(emp, existingTaxNumbers);
    expect(results.some(r => r.code === 'DUPLICATE_TAX_NUMBER' && r.severity === 'error')).toBe(true);
  });

  it('warning: no bank details (field deepLink present)', () => {
    const emp = { ...baseEmployee(), hasBankDetails: false } as PayrollEmployee & { hasBankDetails: boolean };
    const results = validateEmployee(emp, [], { hasBankDetails: false });
    expect(results.some(r => r.code === 'MISSING_BANK_DETAILS' && r.severity === 'warning')).toBe(true);
  });
});

describe('validatePayrollLine', () => {
  it('warning: effective rate is 0% on taxable income above threshold', () => {
    const results = validatePayrollLine({ taxableIncome: 15_000, monthlyPaye: 0, grossPay: 15_000 });
    expect(results.some(r => r.code === 'PAYE_ZERO_ON_TAXABLE_INCOME' && r.severity === 'warning')).toBe(true);
  });

  it('no warning when income is below threshold', () => {
    const results = validatePayrollLine({ taxableIncome: 7_000, monthlyPaye: 0, grossPay: 7_000 });
    expect(results.some(r => r.code === 'PAYE_ZERO_ON_TAXABLE_INCOME')).toBe(false);
  });

  it('no warning when PAYE is positive', () => {
    const results = validatePayrollLine({ taxableIncome: 15_000, monthlyPaye: 500, grossPay: 15_000 });
    expect(results.some(r => r.code === 'PAYE_ZERO_ON_TAXABLE_INCOME')).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bunx vitest run tests/unit/services/payroll/validationEngine.test.ts --reporter=verbose
```

- [ ] **Step 3: Implement `validationEngine.ts`**

```typescript
// src/modules/accounting/services/payroll/validationEngine.ts
import type { PayrollEmployee, ValidationResult } from './payrollTypes';

const MONTHLY_THRESHOLD = 95_750 / 12;

export function validateEmployee(
  employee: PayrollEmployee,
  existingTaxNumbers: string[],
  flags: { hasBankDetails?: boolean } = {},
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (!employee.taxNumber) {
    results.push({
      code: 'MISSING_TAX_NUMBER',
      severity: 'error',
      message: `${employee.firstName} ${employee.lastName} has no SARS tax number. PAYE cannot be calculated.`,
      field: 'taxNumber',
      deepLink: `/payroll/employees/${employee.id}#tax-number`,
    });
  } else if (!/^\d{10}$/.test(employee.taxNumber)) {
    results.push({
      code: 'INVALID_TAX_NUMBER_FORMAT',
      severity: 'error',
      message: `Tax number ${employee.taxNumber} is invalid — must be 10 digits.`,
      field: 'taxNumber',
      deepLink: `/payroll/employees/${employee.id}#tax-number`,
    });
  }

  if (employee.taxNumber && existingTaxNumbers.includes(employee.taxNumber)) {
    results.push({
      code: 'DUPLICATE_TAX_NUMBER',
      severity: 'error',
      message: `Tax number ${employee.taxNumber} is already used by another employee.`,
      field: 'taxNumber',
      deepLink: `/payroll/employees/${employee.id}#tax-number`,
    });
  }

  if (employee.idNumber && !/^\d{13}$/.test(employee.idNumber)) {
    results.push({
      code: 'INVALID_ID_NUMBER',
      severity: 'error',
      message: `ID number for ${employee.firstName} ${employee.lastName} must be 13 digits.`,
      field: 'idNumber',
      deepLink: `/payroll/employees/${employee.id}#id-number`,
    });
  }

  if (flags.hasBankDetails === false) {
    results.push({
      code: 'MISSING_BANK_DETAILS',
      severity: 'warning',
      message: `${employee.firstName} ${employee.lastName} has no bank details — EFT payment will fail.`,
      field: 'bankDetails',
      deepLink: `/payroll/employees/${employee.id}#bank-details`,
    });
  }

  return results;
}

export function validatePayrollLine(line: {
  taxableIncome: number;
  monthlyPaye: number;
  grossPay: number;
}): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (line.taxableIncome > MONTHLY_THRESHOLD && line.monthlyPaye === 0) {
    results.push({
      code: 'PAYE_ZERO_ON_TAXABLE_INCOME',
      severity: 'warning',
      message: 'Employee has taxable income above the annual threshold but zero PAYE. Verify tax number and directive.',
      field: 'paye',
    });
  }

  return results;
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bunx vitest run tests/unit/services/payroll/validationEngine.test.ts --reporter=verbose
```

- [ ] **Step 5: Run full suite**

```bash
bunx vitest run tests/unit/services/payroll/ --reporter=verbose
```

- [ ] **Step 6: Commit**

```bash
git add tests/unit/services/payroll/validationEngine.test.ts \
        src/modules/accounting/services/payroll/validationEngine.ts
git commit -m "feat(payroll): SARS validation engine — missing tax, duplicate, ID format, PAYE sanity"
```

---

## Task 9: DB-aware payroll employee service

**Files:**
- Create: `src/modules/accounting/services/payroll/payrollEmployeeService.ts`
- Create: `src/modules/accounting/services/payroll/payrollComponentService.ts`

- [ ] **Step 1: Write `payrollEmployeeService.ts`**

```typescript
// src/modules/accounting/services/payroll/payrollEmployeeService.ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PayrollEmployee } from './payrollTypes';

type Row = DbRow;

function mapRow(r: Row): PayrollEmployee {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    employeeNumber: String(r.employee_number),
    firstName: String(r.first_name),
    lastName: String(r.last_name),
    idNumber: r.id_number ? String(r.id_number) : undefined,
    taxNumber: r.tax_number ? String(r.tax_number) : undefined,
    employmentType: String(r.employment_type) as PayrollEmployee['employmentType'],
    startDate: new Date(String(r.start_date)),
    endDate: r.end_date ? new Date(String(r.end_date)) : undefined,
    dateOfBirth: r.date_of_birth ? new Date(String(r.date_of_birth)) : undefined,
    uifExcluded: Boolean(r.uif_excluded),
    medicalAidMainMember: Boolean(r.medical_aid_main_member),
    medicalAidDependantsCount: Number(r.medical_aid_dependants_count) || 0,
  };
}

export async function listPayrollEmployees(companyId: string): Promise<PayrollEmployee[]> {
  const rows = (await sql`
    SELECT * FROM payroll_employees
    WHERE company_id = ${companyId}::uuid AND status = 'active'
    ORDER BY last_name, first_name
  `) as Row[];
  return rows.map(mapRow);
}

export async function getPayrollEmployee(id: string, companyId: string): Promise<PayrollEmployee | null> {
  const rows = (await sql`
    SELECT * FROM payroll_employees
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function createPayrollEmployee(
  companyId: string,
  data: Omit<PayrollEmployee, 'id' | 'companyId'>,
): Promise<PayrollEmployee> {
  log.info('Creating payroll employee', { companyId, employeeNumber: data.employeeNumber }, 'payrollEmployeeService');
  const rows = (await sql`
    INSERT INTO payroll_employees (
      company_id, employee_number, first_name, last_name,
      id_number, tax_number, employment_type, start_date, end_date,
      date_of_birth, uif_excluded, medical_aid_main_member, medical_aid_dependants_count
    ) VALUES (
      ${companyId}::uuid, ${data.employeeNumber}, ${data.firstName}, ${data.lastName},
      ${data.idNumber ?? null}, ${data.taxNumber ?? null},
      ${data.employmentType}, ${data.startDate.toISOString().split('T')[0]},
      ${data.endDate ? data.endDate.toISOString().split('T')[0] : null},
      ${data.dateOfBirth ? data.dateOfBirth.toISOString().split('T')[0] : null},
      ${data.uifExcluded}, ${data.medicalAidMainMember}, ${data.medicalAidDependantsCount}
    )
    RETURNING *
  `) as Row[];
  return mapRow(rows[0]);
}

export async function updatePayrollEmployee(
  id: string,
  companyId: string,
  data: Partial<Omit<PayrollEmployee, 'id' | 'companyId'>>,
): Promise<PayrollEmployee | null> {
  log.info('Updating payroll employee', { id, companyId }, 'payrollEmployeeService');
  const rows = (await sql`
    UPDATE payroll_employees SET
      first_name                  = COALESCE(${data.firstName ?? null}, first_name),
      last_name                   = COALESCE(${data.lastName ?? null}, last_name),
      tax_number                  = COALESCE(${data.taxNumber ?? null}, tax_number),
      id_number                   = COALESCE(${data.idNumber ?? null}, id_number),
      employment_type             = COALESCE(${data.employmentType ?? null}, employment_type),
      uif_excluded                = COALESCE(${data.uifExcluded ?? null}, uif_excluded),
      medical_aid_main_member     = COALESCE(${data.medicalAidMainMember ?? null}, medical_aid_main_member),
      medical_aid_dependants_count = COALESCE(${data.medicalAidDependantsCount ?? null}, medical_aid_dependants_count),
      updated_at                  = NOW()
    WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
    RETURNING *
  `) as Row[];
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function listTaxNumbersForCompany(companyId: string, excludeId?: string): Promise<string[]> {
  const rows = (await sql`
    SELECT tax_number FROM payroll_employees
    WHERE company_id = ${companyId}::uuid
      AND tax_number IS NOT NULL
      AND status = 'active'
      AND (${excludeId ?? null}::uuid IS NULL OR id != ${excludeId ?? null}::uuid)
  `) as Row[];
  return rows.map(r => String(r.tax_number));
}
```

- [ ] **Step 2: Write `payrollComponentService.ts`**

```typescript
// src/modules/accounting/services/payroll/payrollComponentService.ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PayrollComponent, EmployeeComponent } from './payrollTypes';

type Row = DbRow;

function mapComponent(r: Row): PayrollComponent {
  return {
    id: String(r.id),
    name: String(r.name),
    sarsSourceCode: String(r.sars_source_code),
    componentType: String(r.component_type) as PayrollComponent['componentType'],
    isTaxable: Boolean(r.is_taxable),
    isUifApplicable: Boolean(r.is_uif_applicable),
    isSdlApplicable: Boolean(r.is_sdl_applicable),
  };
}

export async function listComponents(companyId: string): Promise<PayrollComponent[]> {
  const rows = (await sql`
    SELECT * FROM payroll_components
    WHERE company_id = ${companyId}::uuid AND is_active = TRUE
    ORDER BY component_type, name
  `) as Row[];
  return rows.map(mapComponent);
}

export async function getEmployeeComponents(
  employeeId: string,
  periodDate: Date,
): Promise<EmployeeComponent[]> {
  const dateStr = periodDate.toISOString().split('T')[0];
  const rows = (await sql`
    SELECT
      pec.amount,
      pc.id, pc.name, pc.sars_source_code, pc.component_type,
      pc.is_taxable, pc.is_uif_applicable, pc.is_sdl_applicable
    FROM payroll_employee_components pec
    JOIN payroll_components pc ON pc.id = pec.component_id
    WHERE pec.employee_id = ${employeeId}::uuid
      AND pec.effective_from <= ${dateStr}
      AND (pec.effective_to IS NULL OR pec.effective_to >= ${dateStr})
      AND pc.is_active = TRUE
    ORDER BY pc.component_type, pc.name
  `) as Row[];

  return rows.map(r => ({
    component: mapComponent(r),
    amount: Number(r.amount),
  }));
}

export async function createComponent(
  companyId: string,
  data: Omit<PayrollComponent, 'id'>,
): Promise<PayrollComponent> {
  log.info('Creating payroll component', { companyId, name: data.name }, 'payrollComponentService');
  const rows = (await sql`
    INSERT INTO payroll_components (
      company_id, name, sars_source_code, component_type,
      is_taxable, is_uif_applicable, is_sdl_applicable
    ) VALUES (
      ${companyId}::uuid, ${data.name}, ${data.sarsSourceCode}, ${data.componentType},
      ${data.isTaxable}, ${data.isUifApplicable}, ${data.isSdlApplicable}
    )
    RETURNING *
  `) as Row[];
  return mapComponent(rows[0]);
}
```

- [ ] **Step 3: Type-check**

```bash
bunx tsc --noEmit
```

Fix any type errors before committing.

- [ ] **Step 4: Commit**

```bash
git add src/modules/accounting/services/payroll/payrollEmployeeService.ts \
        src/modules/accounting/services/payroll/payrollComponentService.ts
git commit -m "feat(payroll): DB-aware employee and component services"
```

---

## Task 10: Payroll run service (DB-aware)

**Files:**
- Create: `src/modules/accounting/services/payroll/payrollRunService.ts`

- [ ] **Step 1: Write `payrollRunService.ts`**

```typescript
// src/modules/accounting/services/payroll/payrollRunService.ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listPayrollEmployees } from './payrollEmployeeService';
import { getEmployeeComponents } from './payrollComponentService';
import { calculatePayrollLine } from './payrollCalculator';
import { validateEmployee, validatePayrollLine } from './validationEngine';
import { listTaxNumbersForCompany } from './payrollEmployeeService';
import { getTaxYear } from './taxTables';
import type { PayrollPeriod } from './payrollTypes';

type Row = DbRow;

export interface PayrollRunSummary {
  id: string;
  companyId: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
  employeeCount: number;
}

export async function createPayrollRun(
  companyId: string,
  period: PayrollPeriod,
  createdBy?: string,
): Promise<PayrollRunSummary> {
  log.info('Creating payroll run', { companyId, period }, 'payrollRunService');
  const rows = (await sql`
    INSERT INTO payroll_run_headers (company_id, period_month, period_year, created_by)
    VALUES (${companyId}::uuid, ${period.month}, ${period.year}, ${createdBy ?? null}::uuid)
    ON CONFLICT (company_id, period_year, period_month) DO NOTHING
    RETURNING *
  `) as Row[];
  if (rows.length === 0) throw new Error(`Payroll run for ${period.month}/${period.year} already exists`);
  return mapRunRow(rows[0]);
}

export async function calculatePayrollRun(
  runId: string,
  companyId: string,
): Promise<PayrollRunSummary> {
  log.info('Calculating payroll run', { runId, companyId }, 'payrollRunService');

  const runRows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (runRows.length === 0) throw new Error('Payroll run not found');
  const run = runRows[0];
  const period: PayrollPeriod = { month: Number(run.period_month), year: Number(run.period_year) };
  const taxYear = getTaxYear(period.month, period.year);
  const periodDate = new Date(period.year, period.month - 1, 28);

  const employees = await listPayrollEmployees(companyId);
  const allTaxNumbers = await listTaxNumbersForCompany(companyId);

  let totalGross = 0, totalPaye = 0, totalUifEmployee = 0, totalUifEmployer = 0;
  let totalSdl = 0, totalEti = 0, totalNet = 0;
  const annualPayrollEstimate = employees.length * 25_000 * 12;

  await sql`DELETE FROM payroll_run_lines WHERE run_id = ${runId}::uuid`;

  for (const employee of employees) {
    const components = await getEmployeeComponents(employee.id, periodDate);
    const line = calculatePayrollLine({ employee, components, period, taxYear, annualPayrollEstimate });

    const empValidation = validateEmployee(employee, allTaxNumbers.filter(t => t !== employee.taxNumber));
    const lineValidation = validatePayrollLine({
      taxableIncome: line.taxableIncome,
      monthlyPaye: line.paye.monthlyPaye,
      grossPay: line.grossPay,
    });
    const allValidation = [...empValidation, ...lineValidation];

    await sql`
      INSERT INTO payroll_run_lines (
        run_id, employee_id, gross_pay, taxable_income, paye,
        uif_employee, uif_employer, sdl, eti, net_pay,
        component_breakdown, validation_results
      ) VALUES (
        ${runId}::uuid, ${employee.id}::uuid,
        ${line.grossPay}, ${line.taxableIncome}, ${line.paye.monthlyPaye},
        ${line.uif.employeeContribution}, ${line.uif.employerContribution},
        ${line.sdl}, ${line.eti.monthlyEti}, ${line.netPay},
        ${JSON.stringify(line.componentBreakdown)}, ${JSON.stringify(allValidation)}
      )
    `;

    totalGross += line.grossPay;
    totalPaye += line.paye.monthlyPaye;
    totalUifEmployee += line.uif.employeeContribution;
    totalUifEmployer += line.uif.employerContribution;
    totalSdl += line.sdl;
    totalEti += line.eti.monthlyEti;
    totalNet += line.netPay;
  }

  const rounds = (n: number) => Math.round(n * 100) / 100;
  const updated = (await sql`
    UPDATE payroll_run_headers SET
      status         = 'calculated',
      total_gross    = ${rounds(totalGross)},
      total_paye     = ${rounds(totalPaye)},
      total_uif      = ${rounds(totalUifEmployee + totalUifEmployer)},
      total_sdl      = ${rounds(totalSdl)},
      total_eti      = ${rounds(totalEti)},
      total_net      = ${rounds(totalNet)},
      employee_count = ${employees.length},
      updated_at     = NOW()
    WHERE id = ${runId}::uuid
    RETURNING *
  `) as Row[];

  log.info('Payroll run calculated', { runId, employees: employees.length, totalGross }, 'payrollRunService');
  return mapRunRow(updated[0]);
}

export async function listPayrollRuns(companyId: string): Promise<PayrollRunSummary[]> {
  const rows = (await sql`
    SELECT * FROM payroll_run_headers
    WHERE company_id = ${companyId}::uuid
    ORDER BY period_year DESC, period_month DESC
  `) as Row[];
  return rows.map(mapRunRow);
}

function mapRunRow(r: Row): PayrollRunSummary {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    periodMonth: Number(r.period_month),
    periodYear: Number(r.period_year),
    status: String(r.status),
    totalGross: Number(r.total_gross) || 0,
    totalPaye: Number(r.total_paye) || 0,
    totalUif: Number(r.total_uif) || 0,
    totalSdl: Number(r.total_sdl) || 0,
    totalEti: Number(r.total_eti) || 0,
    totalNet: Number(r.total_net) || 0,
    employeeCount: Number(r.employee_count) || 0,
  };
}
```

- [ ] **Step 2: Type-check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/accounting/services/payroll/payrollRunService.ts
git commit -m "feat(payroll): DB-aware payroll run service — calculate, save, list"
```

---

## Task 11: API routes

**Files:**
- Create: `pages/api/payroll/employees/index.ts`
- Create: `pages/api/payroll/employees/[id].ts`
- Create: `pages/api/payroll/components/index.ts`
- Create: `pages/api/payroll/runs/index.ts`
- Create: `pages/api/payroll/runs/[id]/calculate.ts`

- [ ] **Step 1: Write `pages/api/payroll/employees/index.ts`**

```typescript
// pages/api/payroll/employees/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { listPayrollEmployees, createPayrollEmployee } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import type { CompanyRequest } from '@/lib/withCompany';

async function handler(req: NextApiRequest & CompanyRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const employees = await listPayrollEmployees(req.companyId);
    return apiResponse.success(res, employees);
  }
  if (req.method === 'POST') {
    const { firstName, lastName, employeeNumber, employmentType, startDate,
            taxNumber, idNumber, dateOfBirth, uifExcluded,
            medicalAidMainMember, medicalAidDependantsCount } = req.body;
    if (!firstName || !lastName || !employeeNumber || !employmentType || !startDate) {
      return apiResponse.badRequest(res, 'firstName, lastName, employeeNumber, employmentType, startDate are required');
    }
    const employee = await createPayrollEmployee(req.companyId, {
      firstName, lastName, employeeNumber, employmentType,
      startDate: new Date(startDate),
      endDate: req.body.endDate ? new Date(req.body.endDate) : undefined,
      taxNumber, idNumber,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
      uifExcluded: Boolean(uifExcluded),
      medicalAidMainMember: medicalAidMainMember !== false,
      medicalAidDependantsCount: Number(medicalAidDependantsCount) || 0,
    });
    return apiResponse.success(res, employee);
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as any));
```

- [ ] **Step 2: Write `pages/api/payroll/runs/index.ts`**

```typescript
// pages/api/payroll/runs/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { listPayrollRuns, createPayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import type { CompanyRequest } from '@/lib/withCompany';

async function handler(req: NextApiRequest & CompanyRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const runs = await listPayrollRuns(req.companyId);
    return apiResponse.success(res, runs);
  }
  if (req.method === 'POST') {
    const { month, year } = req.body;
    if (!month || !year) return apiResponse.badRequest(res, 'month and year are required');
    const run = await createPayrollRun(req.companyId, { month: Number(month), year: Number(year) });
    return apiResponse.success(res, run);
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as any));
```

- [ ] **Step 3: Write `pages/api/payroll/runs/[id]/calculate.ts`**

```typescript
// pages/api/payroll/runs/[id]/calculate.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { calculatePayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import type { CompanyRequest } from '@/lib/withCompany';

async function handler(req: NextApiRequest & CompanyRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { id } = req.query;
  if (typeof id !== 'string') return apiResponse.badRequest(res, 'Invalid run ID');
  const summary = await calculatePayrollRun(id, req.companyId);
  return apiResponse.success(res, summary);
}

export default withCompany(withErrorHandler(handler as any));
```

- [ ] **Step 4: Write `pages/api/payroll/components/index.ts`**

```typescript
// pages/api/payroll/components/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/withCompany';
import { withErrorHandler } from '@/lib/withErrorHandler';
import { apiResponse } from '@/lib/apiResponse';
import { listComponents, createComponent } from '@/modules/accounting/services/payroll/payrollComponentService';
import type { CompanyRequest } from '@/lib/withCompany';

async function handler(req: NextApiRequest & CompanyRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const components = await listComponents(req.companyId);
    return apiResponse.success(res, components);
  }
  if (req.method === 'POST') {
    const { name, sarsSourceCode, componentType, isTaxable, isUifApplicable, isSdlApplicable } = req.body;
    if (!name || !sarsSourceCode || !componentType) {
      return apiResponse.badRequest(res, 'name, sarsSourceCode, componentType are required');
    }
    const component = await createComponent(req.companyId, {
      name, sarsSourceCode, componentType,
      isTaxable: isTaxable !== false,
      isUifApplicable: isUifApplicable !== false,
      isSdlApplicable: isSdlApplicable !== false,
    });
    return apiResponse.success(res, component);
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler as any));
```

- [ ] **Step 5: Type-check all routes**

```bash
bunx tsc --noEmit
```

Fix any type errors before committing.

- [ ] **Step 6: Commit**

```bash
git add pages/api/payroll/employees/index.ts \
        pages/api/payroll/runs/index.ts \
        pages/api/payroll/runs/[id]/calculate.ts \
        pages/api/payroll/components/index.ts
git commit -m "feat(payroll): API routes — employees, components, runs, calculate"
```

---

## Task 12: Nav config update

**Files:**
- Modify: `src/components/layout/accountingNavConfig.ts`

- [ ] **Step 1: Add payroll nav section**

Find the `accountingNavConfig.ts` file and add a Payroll section with these links:
- `/payroll/employees` — Employees
- `/payroll/components` — Pay Components
- `/payroll/runs` — Payroll Runs
- `/payroll/leave` — Leave
- `/payroll/irp5-readiness` — IRP5 Readiness
- `/payroll/emp501` — EMP501

The exact insertion point depends on the existing nav structure — add after the last existing module section.

- [ ] **Step 2: Commit**

```bash
git add src/components/layout/accountingNavConfig.ts
git commit -m "feat(payroll): add Payroll section to nav config"
```

---

## Task 13: Full test suite + type-check

- [ ] **Step 1: Run all payroll unit tests**

```bash
bunx vitest run tests/unit/services/payroll/ --reporter=verbose
```

Expected: all tests pass (payeEngine, uifEngine, sdlEngine, etiEngine, payrollCalculator, validationEngine).

- [ ] **Step 2: Run full unit test suite**

```bash
bun run test:unit
```

Expected: no regressions in existing tests.

- [ ] **Step 3: Type-check**

```bash
bunx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 4: Final commit**

```bash
git commit -m "chore(payroll): Phase 1 engine complete — all tests pass, zero type errors"
```

---

## Self-Review: Spec Coverage

| PRD Requirement | Plan Task |
|----------------|-----------|
| payroll_employees (id_number, passport_number, tax_number, employment_type, UIF fields, equity) | Task 1, migration 380 |
| payroll_bank_details | Task 1, migration 380 |
| payroll_components (SARS source code, taxable, UIF, SDL flags) | Task 1, migration 381 |
| payroll_employee_components (effective-date history) | Task 1, migration 381 |
| payroll_runs (period, status, totals) | Task 1, migration 382 |
| payroll_run_lines (per-employee breakdown) | Task 1, migration 382 |
| PAYE: correct SA tax tables, rebates, medical credits, annual equivalent method | Tasks 2–3 |
| UIF: 1% + 1%, ceiling R17,712 | Task 4 |
| SDL: 1%, threshold R500,000 | Task 5 |
| ETI: eligibility, year 1/year 2, linear taper | Task 6 |
| Payroll calculator: deterministic, pure functions | Task 7 |
| Continuous SARS validation: tax number, duplicate, bank details, PAYE sanity | Task 8 |
| API routes for employees, components, runs, calculate | Tasks 9–11 |
| Leave tables (Phase 2 ready) | Task 1, migration 383 |
| TDD: golden-file tests with known PAYE/UIF/SDL/ETI values | Tasks 3–8 |
| Property tests: Σ components = gross, gross − deductions = net, PAYE ≥ 0 | Task 7 |

**Not in Phase 1 (Phase 2+):**
- Retrospective corrections (recalculate cumulative PAYE for prior periods)
- EMP201 generation and export
- Leave request workflow
- Payslip PDF (exists in payrollPdfBuilders — extend later)
- ETI cumulative tracking (Phase 4)
- e@syFile ZIP export (Phase 3)
- IRP5 readiness dashboard (Phase 3)
