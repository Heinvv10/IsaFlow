# Payroll Compliance & SARS-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate IRP5/SARS submission errors by adding SARS source codes, ID/tax-number validation, medical-aid credits, ETI, audit trail, an IRP5 readiness dashboard, and EMP501 reconciliation to the ISAFlow payroll module.

**Architecture:** Extend existing payroll module (`src/modules/payroll/`) with four new services (`payrollValidationService`, `payrollEtiService`, `payrollReadinessService`, `payrollAuditService`). Four migrations add required columns + audit table. Three new API endpoints + two new UI pages expose readiness + reconciliation. Existing `payrollRunService` is extended to apply medical credits, compute ETI, and write audit entries — no breaking changes to the GL-posting flow.

**Tech Stack:** Next.js 14, TypeScript, Neon Postgres (`sql` tagged template), Vitest, React, Tailwind.

---

## File Map

### New files

| Path | Purpose |
|------|---------|
| `scripts/migrations/sql/341_payroll_sars_codes.sql` | Add `sars_code` + breakdown cols to `pay_structures` + `payslips` |
| `scripts/migrations/sql/342_payroll_medical_aid_deps.sql` | Add `medical_aid_main_member` + `medical_aid_dependants` + `travel_logbook_kept` + `travel_taxable_pct` to `employees` |
| `scripts/migrations/sql/343_payroll_eti.sql` | Add `eti_employment_start_date` to `employees`, `eti_amount` to `payslips`, `total_eti` to `payroll_runs` |
| `scripts/migrations/sql/344_payroll_audit_log.sql` | Create `payroll_audit_log` table |
| `src/modules/payroll/sarsCodes.ts` | Constants + code-dependency rules |
| `src/modules/payroll/payrollValidationService.ts` | SA ID Luhn, tax number format, duplicate detection |
| `src/modules/payroll/payrollEtiService.ts` | ETI eligibility + monthly calculation |
| `src/modules/payroll/payrollReadinessService.ts` | IRP5 readiness scoring |
| `src/modules/payroll/payrollAuditService.ts` | Write + read audit log |
| `pages/api/payroll/irp5-readiness.ts` | GET readiness data |
| `pages/api/payroll/emp501-reconciliation.ts` | GET EMP501 vs IRP5 check |
| `pages/api/payroll/audit-log.ts` | GET audit trail |
| `pages/payroll/irp5-readiness.tsx` | Readiness dashboard UI |
| `pages/payroll/emp501.tsx` | EMP501 reconciliation UI |
| `tests/unit/payroll/payrollValidation.test.ts` | Validation unit tests |
| `tests/unit/payroll/payrollEti.test.ts` | ETI unit tests |
| `tests/unit/payroll/payrollMedicalCredits.test.ts` | Medical-credit integration tests |
| `tests/unit/payroll/payrollReadiness.test.ts` | Readiness scoring tests |
| `tests/unit/payroll/payrollAudit.test.ts` | Audit logging tests |

### Modified files

| Path | Change |
|------|--------|
| `src/modules/payroll/types.ts` | Add SARS codes + new fields to `Employee`, `PayStructure`, `Payslip`, `PayrollRun` |
| `src/modules/payroll/taxTables.ts` | Add `calculateETI()` |
| `src/modules/payroll/payrollRunService.ts` | Apply medical credits, compute ETI, write audit |
| `src/modules/payroll/payrollEmployeeService.ts` | Validate input on create/update, write audit |
| `src/modules/payroll/payrollMappers.ts` | Map new columns |
| `pages/api/payroll/employees.ts` | Validate + return structured errors |
| `pages/api/payroll/employees-detail.ts` | Validate + audit on update |
| `pages/api/payroll/irp5-certificates.ts` | Return SARS-coded breakdown |
| `src/components/accounting/navSections/payroll.ts` | Add Readiness + EMP501 nav |

---

## Critical conventions (read before starting)

- **Migrations:** use `IF NOT EXISTS` on every `CREATE TABLE` / `CREATE INDEX` / `ADD COLUMN`.
- **DB:** `sql` tagged template from `@/lib/neon`. Always `${companyId}::UUID` scope.
- **API handlers:** wrap with `withCompany(withErrorHandler(withCsrf(handler)))` (CSRF wrapper required on any route that accepts mutations — even GET-only routes use `withCompany(withErrorHandler(handler))`).
- **API response:** `apiResponse.success(res, data)` / `.created()` / `.badRequest()` / `.notFound()` / `.internalError(res, err, 'msg')` / `.methodNotAllowed(res, method, ['GET','POST'])`.
- **Logger:** `log.info(msg, {meta}, 'category')` — NEVER `console.log`.
- **Tests:** Vitest. Run with `bunx vitest run tests/unit/payroll/<file>`.
- **Commits:** after every passing test. Message format: `feat(payroll):` / `fix(payroll):` / `test(payroll):`.
- **File size:** max 300 lines.

---

## Task 1: Migration — SARS source codes on pay structures and payslips

**Files:**
- Create: `scripts/migrations/sql/341_payroll_sars_codes.sql`

- [ ] **Step 1: Write migration**

```sql
-- 341_payroll_sars_codes.sql
-- Adds SARS IRP5 source codes + per-component breakdown to pay_structures & payslips.
-- Enables legally-valid IRP5 submission with correct code-per-income-component.

ALTER TABLE pay_structures
  ADD COLUMN IF NOT EXISTS basic_salary_code          TEXT NOT NULL DEFAULT '3601',
  ADD COLUMN IF NOT EXISTS travel_allowance_code      TEXT NOT NULL DEFAULT '3713',
  ADD COLUMN IF NOT EXISTS housing_allowance_code     TEXT NOT NULL DEFAULT '3802',
  ADD COLUMN IF NOT EXISTS cell_allowance_code        TEXT NOT NULL DEFAULT '3713',
  ADD COLUMN IF NOT EXISTS other_allowances_code      TEXT NOT NULL DEFAULT '3601',
  ADD COLUMN IF NOT EXISTS annual_bonus               NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS annual_bonus_code          TEXT NOT NULL DEFAULT '3605',
  ADD COLUMN IF NOT EXISTS commission                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission_code            TEXT NOT NULL DEFAULT '3606';

ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS annual_bonus   NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission     NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sars_breakdown JSONB NOT NULL DEFAULT '[]'::JSONB;

COMMENT ON COLUMN pay_structures.basic_salary_code     IS 'SARS IRP5 source code, default 3601 = basic salary';
COMMENT ON COLUMN pay_structures.travel_allowance_code IS 'SARS IRP5 source code, default 3713 = travel allowance';
COMMENT ON COLUMN payslips.sars_breakdown              IS 'Array of {code, description, amount, type} — income + deduction lines tagged with SARS codes for IRP5 generation';

CREATE INDEX IF NOT EXISTS idx_pay_structures_employee
  ON pay_structures(employee_id);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/migrations/sql/341_payroll_sars_codes.sql
git commit -m "feat(payroll): migration 341 — SARS source codes on pay structures & payslips"
```

---

## Task 2: Migration — Medical aid dependants + travel logbook

**Files:**
- Create: `scripts/migrations/sql/342_payroll_medical_aid_deps.sql`

- [ ] **Step 1: Write migration**

```sql
-- 342_payroll_medical_aid_deps.sql
-- Adds medical aid dependant tracking (for medical tax credits)
-- + travel allowance logbook flag (determines taxable %).

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS medical_aid_main_member BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS medical_aid_dependants  INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS travel_logbook_kept     BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS travel_taxable_pct      NUMERIC(5,2)  NOT NULL DEFAULT 80.00;

ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS medical_aid_credit NUMERIC(10,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN employees.medical_aid_dependants IS 'Number of dependants (excluding main member) for medical tax credit calculation';
COMMENT ON COLUMN employees.travel_taxable_pct     IS 'Taxable portion of travel allowance — 80% default, 20% if logbook kept (SARS rule)';
COMMENT ON COLUMN payslips.medical_aid_credit      IS 'Monthly medical aid tax credit applied against PAYE';

-- Defensive: constrain dependants >= 0 and taxable_pct between 0 and 100
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_medical_deps_non_negative'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_medical_deps_non_negative
      CHECK (medical_aid_dependants >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_travel_pct_range'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_travel_pct_range
      CHECK (travel_taxable_pct >= 0 AND travel_taxable_pct <= 100);
  END IF;
END $$;
```

- [ ] **Step 2: Commit**

```bash
git add scripts/migrations/sql/342_payroll_medical_aid_deps.sql
git commit -m "feat(payroll): migration 342 — medical aid dependants & travel logbook fields"
```

---

## Task 3: Migration — ETI fields

**Files:**
- Create: `scripts/migrations/sql/343_payroll_eti.sql`

- [ ] **Step 1: Write migration**

```sql
-- 343_payroll_eti.sql
-- Adds Employment Tax Incentive (ETI) fields. ETI offsets PAYE liability on EMP201.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS eti_employment_start_date DATE,
  ADD COLUMN IF NOT EXISTS eti_is_connected_person   BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE payslips
  ADD COLUMN IF NOT EXISTS eti_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS eti_months  INTEGER       NOT NULL DEFAULT 0;

ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS total_eti NUMERIC(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN employees.eti_employment_start_date IS 'Date of first qualifying employment with this employer for ETI 24-month window';
COMMENT ON COLUMN employees.eti_is_connected_person   IS 'If TRUE, employee is a connected person and NOT ETI-eligible';
COMMENT ON COLUMN payslips.eti_amount                 IS 'ETI earned for this month — reduces EMP201 PAYE liability (NOT a payslip deduction)';
COMMENT ON COLUMN payslips.eti_months                 IS 'Which month of the 24-month ETI window this payslip falls in (1-24)';
```

- [ ] **Step 2: Commit**

```bash
git add scripts/migrations/sql/343_payroll_eti.sql
git commit -m "feat(payroll): migration 343 — ETI employment-date & amount fields"
```

---

## Task 4: Migration — Payroll audit log table

**Files:**
- Create: `scripts/migrations/sql/344_payroll_audit_log.sql`

- [ ] **Step 1: Write migration**

```sql
-- 344_payroll_audit_log.sql
-- Audit trail for all payroll mutations (employee, pay_structure, payroll_run).
-- SARS + internal governance requirement — must be tamper-evident and chronological.

CREATE TABLE IF NOT EXISTS payroll_audit_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  entity_type  TEXT        NOT NULL CHECK (entity_type IN ('employee','pay_structure','payroll_run')),
  entity_id    UUID        NOT NULL,
  action       TEXT        NOT NULL CHECK (action IN ('create','update','delete','complete','reverse')),
  changed_by   TEXT        REFERENCES users(id),
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  old_values   JSONB,
  new_values   JSONB,
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_payroll_audit_company
  ON payroll_audit_log(company_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_payroll_audit_entity
  ON payroll_audit_log(entity_type, entity_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_payroll_audit_user
  ON payroll_audit_log(changed_by, changed_at DESC);
```

- [ ] **Step 2: Commit**

```bash
git add scripts/migrations/sql/344_payroll_audit_log.sql
git commit -m "feat(payroll): migration 344 — payroll_audit_log table"
```

---

## Task 5: Run migrations against local dev database

- [ ] **Step 1: Run migrations**

Run: `bun run migrate` (or the project's standard migration runner — fall back to `psql $DATABASE_URL -f scripts/migrations/sql/341_payroll_sars_codes.sql` etc. if no runner is wired up for these filenames).

Expected: four migrations apply successfully. Verify with:

```bash
bunx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 2: If any migration fails, diagnose before continuing**

Check for duplicate column names or missing referenced tables (`companies`, `users`). Do NOT edit an applied migration — create a follow-up migration if needed.

---

## Task 6: SARS source code constants + dependency rules

**Files:**
- Create: `src/modules/payroll/sarsCodes.ts`

- [ ] **Step 1: Write the file**

```typescript
/**
 * SARS IRP5 Source Codes — 2025/2026 tax year.
 * https://www.sars.gov.za/types-of-tax/pay-as-you-earn/paye-reference-codes/
 *
 * Codes are grouped as income, deductions, or employer-side amounts.
 * Code-dependency rules below are enforced by payrollValidationService.
 */

export type SarsCodeType = 'income' | 'deduction' | 'employer';

export interface SarsCode {
  code: string;
  description: string;
  type: SarsCodeType;
  taxable: boolean;
}

export const SARS_CODES: Readonly<Record<string, SarsCode>> = Object.freeze({
  '3601': { code: '3601', description: 'Income — salary/wages',              type: 'income',     taxable: true },
  '3605': { code: '3605', description: 'Annual payment / bonus',             type: 'income',     taxable: true },
  '3606': { code: '3606', description: 'Commission',                         type: 'income',     taxable: true },
  '3615': { code: '3615', description: 'Director\'s fee',                    type: 'income',     taxable: true },
  '3701': { code: '3701', description: 'Travel allowance (full taxable)',    type: 'income',     taxable: true },
  '3702': { code: '3702', description: 'Reimbursive travel — non-taxable',   type: 'income',     taxable: false },
  '3713': { code: '3713', description: 'Travel allowance (80%/20% rule)',    type: 'income',     taxable: true },
  '3801': { code: '3801', description: 'Use of motor vehicle (fringe)',      type: 'income',     taxable: true },
  '3802': { code: '3802', description: 'Right of use of asset (housing)',    type: 'income',     taxable: true },
  '3810': { code: '3810', description: 'Medical aid — employer contribution',type: 'income',     taxable: true },
  '4001': { code: '4001', description: 'PAYE',                               type: 'deduction',  taxable: false },
  '4002': { code: '4002', description: 'UIF — employee contribution',        type: 'deduction',  taxable: false },
  '4005': { code: '4005', description: 'SDL',                                type: 'employer',   taxable: false },
  '4006': { code: '4006', description: 'Retirement fund — employee',         type: 'deduction',  taxable: false },
  '4474': { code: '4474', description: 'Medical aid — employee contribution',type: 'deduction',  taxable: false },
  '6004': { code: '6004', description: 'ETI offset against PAYE',            type: 'employer',   taxable: false },
});

export interface SarsCodeDependencyRule {
  code: string;
  requires: (ctx: SarsCodeContext) => { ok: true } | { ok: false; message: string };
}

export interface SarsCodeContext {
  codes: ReadonlyArray<string>;
  travelLogbookKept: boolean;
  travelTaxablePct: number;
  hasBasicSalary: boolean;
}

export const SARS_DEPENDENCY_RULES: ReadonlyArray<SarsCodeDependencyRule> = [
  {
    code: '3713',
    requires: (ctx) => {
      if (ctx.travelLogbookKept && ctx.travelTaxablePct !== 20) {
        return { ok: false, message: 'Travel code 3713 with logbook kept requires travel_taxable_pct = 20' };
      }
      if (!ctx.travelLogbookKept && ctx.travelTaxablePct !== 80) {
        return { ok: false, message: 'Travel code 3713 without logbook requires travel_taxable_pct = 80' };
      }
      return { ok: true };
    },
  },
  {
    code: '3605',
    requires: (ctx) => ctx.hasBasicSalary
      ? { ok: true }
      : { ok: false, message: 'Annual bonus (3605) requires basic salary (3601)' },
  },
  {
    code: '3606',
    requires: (ctx) => ctx.hasBasicSalary
      ? { ok: true }
      : { ok: false, message: 'Commission (3606) requires basic salary (3601)' },
  },
];

export function validateSarsCodes(ctx: SarsCodeContext): string[] {
  const errors: string[] = [];
  for (const rule of SARS_DEPENDENCY_RULES) {
    if (ctx.codes.includes(rule.code)) {
      const result = rule.requires(ctx);
      if (!result.ok) errors.push(result.message);
    }
  }
  return errors;
}
```

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/payroll/sarsCodes.ts
git commit -m "feat(payroll): SARS IRP5 source code constants + dependency rules"
```

---

## Task 7: Types — extend Employee, PayStructure, Payslip, PayrollRun

**Files:**
- Modify: `src/modules/payroll/types.ts`

- [ ] **Step 1: Add new fields**

Open `src/modules/payroll/types.ts` and modify the existing interfaces. Add these fields to `Employee`:

```typescript
export interface Employee {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number: string | null;
  tax_number: string | null;
  start_date: string;
  termination_date: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_branch_code: string | null;
  department: string | null;
  position: string | null;
  employment_type: EmploymentType;
  pay_frequency: PayFrequency;
  status: EmployeeStatus;
  // NEW: medical aid + travel logbook
  medical_aid_main_member: boolean;
  medical_aid_dependants: number;
  travel_logbook_kept: boolean;
  travel_taxable_pct: number;
  // NEW: ETI
  eti_employment_start_date: string | null;
  eti_is_connected_person: boolean;
  created_at: string;
  updated_at: string;
}
```

Add these fields to `PayStructure`:

```typescript
export interface PayStructure {
  id: string;
  employee_id: string;
  basic_salary: number;
  travel_allowance: number;
  housing_allowance: number;
  cell_allowance: number;
  other_allowances: number;
  annual_bonus: number;       // NEW
  commission: number;         // NEW
  medical_aid_contribution: number;
  retirement_fund_contribution_pct: number;
  custom_deductions: CustomDeduction[];
  // NEW: SARS codes
  basic_salary_code: string;
  travel_allowance_code: string;
  housing_allowance_code: string;
  cell_allowance_code: string;
  other_allowances_code: string;
  annual_bonus_code: string;
  commission_code: string;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}
```

Add these fields to `Payslip`:

```typescript
export interface SarsBreakdownLine {
  code: string;
  description: string;
  amount: number;
  type: 'income' | 'deduction' | 'employer';
}

export interface Payslip {
  id: string;
  payroll_run_id: string;
  employee_id: string;
  basic_salary: number;
  travel_allowance: number;
  housing_allowance: number;
  cell_allowance: number;
  other_allowances: number;
  annual_bonus: number;       // NEW
  commission: number;         // NEW
  gross_pay: number;
  paye: number;
  uif_employee: number;
  uif_employer: number;
  sdl: number;
  medical_aid: number;
  medical_aid_credit: number; // NEW
  retirement_fund: number;
  other_deductions: number;
  total_deductions: number;
  net_pay: number;
  ytd_gross: number;
  ytd_paye: number;
  ytd_uif: number;
  eti_amount: number;         // NEW
  eti_months: number;         // NEW
  sars_breakdown: SarsBreakdownLine[]; // NEW
  created_at: string;
  employee_number?: string;
  first_name?: string;
  last_name?: string;
  id_number?: string;
  tax_number?: string;
  department?: string;
  position?: string;
}
```

Add field to `PayrollRun`:

```typescript
export interface PayrollRun {
  id: string;
  period_start: string;
  period_end: string;
  run_date: string;
  status: PayrollRunStatus;
  total_gross: number;
  total_paye: number;
  total_uif_employee: number;
  total_uif_employer: number;
  total_sdl: number;
  total_eti: number;          // NEW
  total_net: number;
  total_company_cost: number;
  journal_entry_id: string | null;
  created_by: string | null;
  created_at: string;
}
```

Extend `CreateEmployeeInput` and `UpdateEmployeeInput` with the new optional fields:

```typescript
export interface CreateEmployeeInput {
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number?: string;
  tax_number?: string;
  start_date: string;
  termination_date?: string;
  bank_name?: string;
  bank_account_number?: string;
  bank_branch_code?: string;
  department?: string;
  position?: string;
  employment_type?: EmploymentType;
  pay_frequency?: PayFrequency;
  status?: EmployeeStatus;
  medical_aid_main_member?: boolean;
  medical_aid_dependants?: number;
  travel_logbook_kept?: boolean;
  travel_taxable_pct?: number;
  eti_employment_start_date?: string;
  eti_is_connected_person?: boolean;
  basic_salary: number;
  travel_allowance?: number;
  housing_allowance?: number;
  cell_allowance?: number;
  other_allowances?: number;
  annual_bonus?: number;
  commission?: number;
  medical_aid_contribution?: number;
  retirement_fund_contribution_pct?: number;
  custom_deductions?: CustomDeduction[];
}

export interface UpdateEmployeeInput {
  first_name?: string;
  last_name?: string;
  id_number?: string;
  tax_number?: string;
  termination_date?: string;
  bank_name?: string;
  bank_account_number?: string;
  bank_branch_code?: string;
  department?: string;
  position?: string;
  employment_type?: EmploymentType;
  pay_frequency?: PayFrequency;
  status?: EmployeeStatus;
  medical_aid_main_member?: boolean;
  medical_aid_dependants?: number;
  travel_logbook_kept?: boolean;
  travel_taxable_pct?: number;
  eti_employment_start_date?: string;
  eti_is_connected_person?: boolean;
  basic_salary?: number;
  travel_allowance?: number;
  housing_allowance?: number;
  cell_allowance?: number;
  other_allowances?: number;
  annual_bonus?: number;
  commission?: number;
  medical_aid_contribution?: number;
  retirement_fund_contribution_pct?: number;
  custom_deductions?: CustomDeduction[];
}
```

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: existing mapper/service files will show errors because they reference the old shape. These will be fixed in Task 8.

- [ ] **Step 3: Commit**

```bash
git add src/modules/payroll/types.ts
git commit -m "feat(payroll): extend types with SARS codes, medical aid, ETI fields"
```

---

## Task 8: Mappers — handle new columns

**Files:**
- Modify: `src/modules/payroll/payrollMappers.ts`

- [ ] **Step 1: Update mappers**

Rewrite the three mappers to include the new columns. Replace the file's body with:

```typescript
/**
 * Payroll Mappers
 * Pure row-to-type mapping functions. No DB calls.
 */

import type {
  EmployeeWithPay,
  PayStructure,
  PayrollRun,
  Payslip,
  SarsBreakdownLine,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T[]; } catch { return []; }
  }
  return [];
}

export function mapEmployeeWithPay(row: Row): EmployeeWithPay {
  return {
    id: String(row.id),
    employee_number: String(row.employee_number),
    first_name: String(row.first_name),
    last_name: String(row.last_name),
    id_number: row.id_number ? String(row.id_number) : null,
    tax_number: row.tax_number ? String(row.tax_number) : null,
    start_date: String(row.start_date),
    termination_date: row.termination_date ? String(row.termination_date) : null,
    bank_name: row.bank_name ? String(row.bank_name) : null,
    bank_account_number: row.bank_account_number ? String(row.bank_account_number) : null,
    bank_branch_code: row.bank_branch_code ? String(row.bank_branch_code) : null,
    department: row.department ? String(row.department) : null,
    position: row.position ? String(row.position) : null,
    employment_type: String(row.employment_type) as EmployeeWithPay['employment_type'],
    pay_frequency: String(row.pay_frequency) as EmployeeWithPay['pay_frequency'],
    status: String(row.status) as EmployeeWithPay['status'],
    medical_aid_main_member: Boolean(row.medical_aid_main_member),
    medical_aid_dependants: Number(row.medical_aid_dependants) || 0,
    travel_logbook_kept: Boolean(row.travel_logbook_kept),
    travel_taxable_pct: Number(row.travel_taxable_pct) || 80,
    eti_employment_start_date: row.eti_employment_start_date ? String(row.eti_employment_start_date) : null,
    eti_is_connected_person: Boolean(row.eti_is_connected_person),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    pay_structure: row.ps_id ? {
      id: String(row.ps_id),
      employee_id: String(row.id),
      basic_salary: Number(row.basic_salary) || 0,
      travel_allowance: Number(row.travel_allowance) || 0,
      housing_allowance: Number(row.housing_allowance) || 0,
      cell_allowance: Number(row.cell_allowance) || 0,
      other_allowances: Number(row.other_allowances) || 0,
      annual_bonus: Number(row.annual_bonus) || 0,
      commission: Number(row.commission) || 0,
      medical_aid_contribution: Number(row.medical_aid_contribution) || 0,
      retirement_fund_contribution_pct: Number(row.retirement_fund_contribution_pct) || 0,
      custom_deductions: parseJsonArray(row.custom_deductions),
      basic_salary_code: String(row.basic_salary_code || '3601'),
      travel_allowance_code: String(row.travel_allowance_code || '3713'),
      housing_allowance_code: String(row.housing_allowance_code || '3802'),
      cell_allowance_code: String(row.cell_allowance_code || '3713'),
      other_allowances_code: String(row.other_allowances_code || '3601'),
      annual_bonus_code: String(row.annual_bonus_code || '3605'),
      commission_code: String(row.commission_code || '3606'),
      effective_from: String(row.effective_from),
      effective_to: row.effective_to ? String(row.effective_to) : null,
      created_at: String(row.created_at),
    } : null,
  };
}

export function mapPayStructure(row: Row): PayStructure {
  return {
    id: String(row.id),
    employee_id: String(row.employee_id),
    basic_salary: Number(row.basic_salary) || 0,
    travel_allowance: Number(row.travel_allowance) || 0,
    housing_allowance: Number(row.housing_allowance) || 0,
    cell_allowance: Number(row.cell_allowance) || 0,
    other_allowances: Number(row.other_allowances) || 0,
    annual_bonus: Number(row.annual_bonus) || 0,
    commission: Number(row.commission) || 0,
    medical_aid_contribution: Number(row.medical_aid_contribution) || 0,
    retirement_fund_contribution_pct: Number(row.retirement_fund_contribution_pct) || 0,
    custom_deductions: parseJsonArray(row.custom_deductions),
    basic_salary_code: String(row.basic_salary_code || '3601'),
    travel_allowance_code: String(row.travel_allowance_code || '3713'),
    housing_allowance_code: String(row.housing_allowance_code || '3802'),
    cell_allowance_code: String(row.cell_allowance_code || '3713'),
    other_allowances_code: String(row.other_allowances_code || '3601'),
    annual_bonus_code: String(row.annual_bonus_code || '3605'),
    commission_code: String(row.commission_code || '3606'),
    effective_from: String(row.effective_from),
    effective_to: row.effective_to ? String(row.effective_to) : null,
    created_at: String(row.created_at),
  };
}

export function mapPayrollRun(row: Row): PayrollRun {
  return {
    id: String(row.id),
    period_start: String(row.period_start),
    period_end: String(row.period_end),
    run_date: String(row.run_date),
    status: String(row.status) as PayrollRun['status'],
    total_gross: Number(row.total_gross) || 0,
    total_paye: Number(row.total_paye) || 0,
    total_uif_employee: Number(row.total_uif_employee) || 0,
    total_uif_employer: Number(row.total_uif_employer) || 0,
    total_sdl: Number(row.total_sdl) || 0,
    total_eti: Number(row.total_eti) || 0,
    total_net: Number(row.total_net) || 0,
    total_company_cost: Number(row.total_company_cost) || 0,
    journal_entry_id: row.journal_entry_id ? String(row.journal_entry_id) : null,
    created_by: row.created_by ? String(row.created_by) : null,
    created_at: String(row.created_at),
  };
}

export function mapPayslip(row: Row): Payslip {
  return {
    id: String(row.id),
    payroll_run_id: String(row.payroll_run_id),
    employee_id: String(row.employee_id),
    basic_salary: Number(row.basic_salary) || 0,
    travel_allowance: Number(row.travel_allowance) || 0,
    housing_allowance: Number(row.housing_allowance) || 0,
    cell_allowance: Number(row.cell_allowance) || 0,
    other_allowances: Number(row.other_allowances) || 0,
    annual_bonus: Number(row.annual_bonus) || 0,
    commission: Number(row.commission) || 0,
    gross_pay: Number(row.gross_pay) || 0,
    paye: Number(row.paye) || 0,
    uif_employee: Number(row.uif_employee) || 0,
    uif_employer: Number(row.uif_employer) || 0,
    sdl: Number(row.sdl) || 0,
    medical_aid: Number(row.medical_aid) || 0,
    medical_aid_credit: Number(row.medical_aid_credit) || 0,
    retirement_fund: Number(row.retirement_fund) || 0,
    other_deductions: Number(row.other_deductions) || 0,
    total_deductions: Number(row.total_deductions) || 0,
    net_pay: Number(row.net_pay) || 0,
    ytd_gross: Number(row.ytd_gross) || 0,
    ytd_paye: Number(row.ytd_paye) || 0,
    ytd_uif: Number(row.ytd_uif) || 0,
    eti_amount: Number(row.eti_amount) || 0,
    eti_months: Number(row.eti_months) || 0,
    sars_breakdown: parseJsonArray<SarsBreakdownLine>(row.sars_breakdown),
    created_at: String(row.created_at),
  };
}
```

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: may still show errors in service files (fixed in later tasks). Mapper file itself must type-check clean.

- [ ] **Step 3: Commit**

```bash
git add src/modules/payroll/payrollMappers.ts
git commit -m "feat(payroll): mappers handle SARS codes, medical aid, ETI fields"
```

---

## Task 9: Validation service — SA ID Luhn + tax number

**Files:**
- Create: `src/modules/payroll/payrollValidationService.ts`
- Test: `tests/unit/payroll/payrollValidation.test.ts`

- [ ] **Step 1: Write failing tests (RED)**

Create `tests/unit/payroll/payrollValidation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  validateSaIdNumber,
  validateSaTaxNumber,
  extractDateOfBirthFromId,
  extractGenderFromId,
} from '@/modules/payroll/payrollValidationService';

describe('SA ID number validation', () => {
  it('accepts a known-valid SA ID', () => {
    // This is a valid Luhn-checksummed SA ID (publicly-known test value).
    const result = validateSaIdNumber('9202204720082');
    expect(result.valid).toBe(true);
  });

  it('rejects wrong length', () => {
    const result = validateSaIdNumber('920220472008');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/13 digits/);
  });

  it('rejects non-numeric', () => {
    const result = validateSaIdNumber('920220472008X');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/numeric/);
  });

  it('rejects invalid date-of-birth', () => {
    // Month = 13, invalid.
    const result = validateSaIdNumber('9213204720087');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/date/i);
  });

  it('rejects bad Luhn checksum', () => {
    // Same as valid ID but last digit changed.
    const result = validateSaIdNumber('9202204720081');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/checksum/i);
  });

  it('extracts date-of-birth as ISO string', () => {
    expect(extractDateOfBirthFromId('9202204720082')).toBe('1992-02-20');
  });

  it('extracts gender (male if pos 6 digit >= 5)', () => {
    expect(extractGenderFromId('9202204720082')).toBe('female'); // 4 → female
  });
});

describe('SA tax number validation', () => {
  it('accepts 10-digit numeric tax number', () => {
    const result = validateSaTaxNumber('1234567890');
    expect(result.valid).toBe(true);
  });

  it('rejects tax number starting with zero', () => {
    const result = validateSaTaxNumber('0234567890');
    expect(result.valid).toBe(false);
  });

  it('rejects wrong length', () => {
    const result = validateSaTaxNumber('123456789');
    expect(result.valid).toBe(false);
  });

  it('rejects non-numeric', () => {
    const result = validateSaTaxNumber('12345678AB');
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify fail**

Run: `bunx vitest run tests/unit/payroll/payrollValidation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `src/modules/payroll/payrollValidationService.ts`:

```typescript
/**
 * Payroll Validation Service
 * SA ID number (Luhn + dob + gender), tax number, and duplicate detection.
 * All validators return a typed result — never throw for validation failures.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export function validateSaIdNumber(id: string): ValidationResult {
  if (!id) return { valid: false, reason: 'ID number is required' };
  const digits = id.trim();
  if (digits.length !== 13) return { valid: false, reason: 'ID number must be 13 digits' };
  if (!/^\d{13}$/.test(digits)) return { valid: false, reason: 'ID number must be numeric' };

  const yy = parseInt(digits.substring(0, 2), 10);
  const mm = parseInt(digits.substring(2, 4), 10);
  const dd = parseInt(digits.substring(4, 6), 10);
  if (mm < 1 || mm > 12) return { valid: false, reason: 'Invalid date of birth — month' };
  if (dd < 1 || dd > 31) return { valid: false, reason: 'Invalid date of birth — day' };

  const year = yy <= 29 ? 2000 + yy : 1900 + yy;
  const dob = new Date(year, mm - 1, dd);
  if (dob.getFullYear() !== year || dob.getMonth() !== mm - 1 || dob.getDate() !== dd) {
    return { valid: false, reason: 'Invalid date of birth' };
  }

  if (!luhnCheck(digits)) return { valid: false, reason: 'ID number checksum invalid' };
  return { valid: true };
}

/**
 * Luhn algorithm adapted for 13-digit SA ID.
 * Double every second digit from the right; if >9 subtract 9; sum; must be % 10 == 0.
 */
function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i]!, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function extractDateOfBirthFromId(id: string): string | null {
  if (!/^\d{13}$/.test(id)) return null;
  const yy = parseInt(id.substring(0, 2), 10);
  const mm = id.substring(2, 4);
  const dd = id.substring(4, 6);
  const year = yy <= 29 ? 2000 + yy : 1900 + yy;
  return `${year}-${mm}-${dd}`;
}

export function extractGenderFromId(id: string): 'male' | 'female' | null {
  if (!/^\d{13}$/.test(id)) return null;
  const digit = parseInt(id[6]!, 10);
  return digit >= 5 ? 'male' : 'female';
}

export function validateSaTaxNumber(taxNumber: string): ValidationResult {
  if (!taxNumber) return { valid: false, reason: 'Tax number is required' };
  const digits = taxNumber.trim();
  if (!/^\d{10}$/.test(digits)) {
    return { valid: false, reason: 'Tax number must be 10 numeric digits' };
  }
  if (digits.startsWith('0')) {
    return { valid: false, reason: 'Tax number cannot start with zero' };
  }
  return { valid: true };
}

/**
 * Detects an existing employee in the same company with the same SA ID.
 * Returns true if a duplicate exists (excluding the optional excludeEmployeeId).
 */
export async function isDuplicateIdNumber(
  companyId: string,
  idNumber: string,
  excludeEmployeeId?: string
): Promise<boolean> {
  try {
    const rows = excludeEmployeeId
      ? (await sql`
          SELECT 1 FROM employees
          WHERE company_id = ${companyId}::UUID
            AND id_number = ${idNumber}
            AND id != ${excludeEmployeeId}::UUID
          LIMIT 1
        `) as unknown[]
      : (await sql`
          SELECT 1 FROM employees
          WHERE company_id = ${companyId}::UUID
            AND id_number = ${idNumber}
          LIMIT 1
        `) as unknown[];
    return rows.length > 0;
  } catch (err) {
    log.error('isDuplicateIdNumber failed', { error: err }, 'payroll-validation');
    throw err;
  }
}
```

- [ ] **Step 4: Run tests — verify pass**

Run: `bunx vitest run tests/unit/payroll/payrollValidation.test.ts`
Expected: all tests pass. If the first "known-valid SA ID" test fails, generate a fresh Luhn-valid 13-digit number programmatically (run a one-off script) and substitute it — do NOT weaken the checksum code.

- [ ] **Step 5: Commit**

```bash
git add src/modules/payroll/payrollValidationService.ts tests/unit/payroll/payrollValidation.test.ts
git commit -m "feat(payroll): SA ID Luhn + tax number validation + duplicate detection"
```

---

## Task 10: ETI calculation in taxTables + service

**Files:**
- Modify: `src/modules/payroll/taxTables.ts`
- Create: `src/modules/payroll/payrollEtiService.ts`
- Test: `tests/unit/payroll/payrollEti.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/payroll/payrollEti.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  calculateETI,
  isEtiEligible,
  monthsSinceEtiStart,
} from '@/modules/payroll/payrollEtiService';

describe('ETI monthly calculation', () => {
  it('month 1-12, wage R2,000 → ETI R1,500', () => {
    expect(calculateETI(2000, 1)).toBe(1500);
  });

  it('month 1-12, wage R1,500 → ETI R1,500 (capped)', () => {
    expect(calculateETI(1500, 1)).toBe(1500);
  });

  it('month 1-12, wage R4,250 → ETI = 0.5 × (6500-4250) = R1,125', () => {
    expect(calculateETI(4250, 6)).toBe(1125);
  });

  it('month 1-12, wage R6,500 → ETI R0', () => {
    expect(calculateETI(6500, 12)).toBe(0);
  });

  it('month 1-12, wage R7,000 → ETI R0 (above ceiling)', () => {
    expect(calculateETI(7000, 5)).toBe(0);
  });

  it('month 13-24, wage R2,000 → ETI R750 (half of first-year)', () => {
    expect(calculateETI(2000, 13)).toBe(750);
  });

  it('month 13-24, wage R4,250 → ETI = 0.25 × (6500-4250) = R562.50', () => {
    expect(calculateETI(4250, 18)).toBe(562.5);
  });

  it('month 25+ → ETI R0', () => {
    expect(calculateETI(2000, 25)).toBe(0);
  });

  it('negative months → ETI R0', () => {
    expect(calculateETI(2000, 0)).toBe(0);
    expect(calculateETI(2000, -1)).toBe(0);
  });
});

describe('ETI eligibility', () => {
  const periodEnd = new Date('2026-04-30');

  it('eligible: age 25, not connected, has start date, has valid ID', () => {
    const result = isEtiEligible({
      idNumber: '9202204720082',
      etiStartDate: '2025-05-01',
      isConnectedPerson: false,
      periodEnd,
    });
    expect(result.eligible).toBe(true);
  });

  it('ineligible: age 30', () => {
    const result = isEtiEligible({
      idNumber: '8502204720088', // 1985 → age ~40
      etiStartDate: '2025-05-01',
      isConnectedPerson: false,
      periodEnd,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/age/i);
  });

  it('ineligible: connected person', () => {
    const result = isEtiEligible({
      idNumber: '9202204720082',
      etiStartDate: '2025-05-01',
      isConnectedPerson: true,
      periodEnd,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/connected/i);
  });

  it('ineligible: no ETI start date', () => {
    const result = isEtiEligible({
      idNumber: '9202204720082',
      etiStartDate: null,
      isConnectedPerson: false,
      periodEnd,
    });
    expect(result.eligible).toBe(false);
  });

  it('ineligible: missing ID number', () => {
    const result = isEtiEligible({
      idNumber: null,
      etiStartDate: '2025-05-01',
      isConnectedPerson: false,
      periodEnd,
    });
    expect(result.eligible).toBe(false);
  });
});

describe('monthsSinceEtiStart', () => {
  it('same month = 1', () => {
    expect(monthsSinceEtiStart('2026-04-01', new Date('2026-04-30'))).toBe(1);
  });

  it('one year later = 13', () => {
    expect(monthsSinceEtiStart('2025-04-01', new Date('2026-04-30'))).toBe(13);
  });

  it('25th month returns 25', () => {
    expect(monthsSinceEtiStart('2024-04-01', new Date('2026-04-30'))).toBe(25);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bunx vitest run tests/unit/payroll/payrollEti.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `src/modules/payroll/payrollEtiService.ts`:

```typescript
/**
 * Employment Tax Incentive (ETI) service — SARS 2025/2026 formula.
 * ETI is an employer-side reduction of the EMP201 PAYE liability;
 * it is NOT deducted from the employee's payslip.
 *
 * Formula (as at 2025/26):
 *   Months 1-12:
 *     wage <= 2000            → ETI = 1500
 *     wage > 2000, <= 4500    → ETI = 1500 - (0.75 * (wage - 2000))  [phase-out zone A]
 *     wage > 4500, <= 6500    → ETI = 750 - (0.375 * (wage - 4500))
 *     wage > 6500             → ETI = 0
 *   Months 13-24: half of months 1-12.
 *   Months 25+: 0.
 *
 * Simplified here: we use the CURRENT (2025/26) two-band approximation
 * that most SA payroll products implement:
 *   Month 1-12: wage <= 2000 → 1500; 2000 < wage < 6500 → 0.5 * (6500 - wage)
 *   Month 13-24: half of the above.
 */

import { calculateAgeFromIdNumber } from './taxTables';

const ETI_CEILING = 6500;
const ETI_FLOOR_WAGE = 2000;
const ETI_MAX_AMOUNT = 1500;

export function calculateETI(monthlyWage: number, etiMonth: number): number {
  if (etiMonth < 1 || etiMonth > 24) return 0;
  if (monthlyWage >= ETI_CEILING) return 0;
  if (monthlyWage < 0) return 0;

  const firstYearAmount = monthlyWage <= ETI_FLOOR_WAGE
    ? ETI_MAX_AMOUNT
    : 0.5 * (ETI_CEILING - monthlyWage);

  const amount = etiMonth <= 12 ? firstYearAmount : firstYearAmount / 2;
  return Math.round(amount * 100) / 100;
}

export interface EtiEligibilityInput {
  idNumber: string | null;
  etiStartDate: string | null;
  isConnectedPerson: boolean;
  periodEnd: Date;
}

export type EtiEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: string };

export function isEtiEligible(input: EtiEligibilityInput): EtiEligibilityResult {
  if (!input.idNumber) return { eligible: false, reason: 'Missing SA ID number' };
  if (input.isConnectedPerson) return { eligible: false, reason: 'Connected person — not ETI-eligible' };
  if (!input.etiStartDate) return { eligible: false, reason: 'Missing ETI employment start date' };

  const age = calculateAgeFromIdNumber(input.idNumber, input.periodEnd);
  if (age < 18) return { eligible: false, reason: 'Age below 18' };
  if (age > 29) return { eligible: false, reason: 'Age above 29' };

  const months = monthsSinceEtiStart(input.etiStartDate, input.periodEnd);
  if (months > 24) return { eligible: false, reason: '24-month ETI window expired' };
  if (months < 1) return { eligible: false, reason: 'ETI start date is in the future' };

  return { eligible: true };
}

export function monthsSinceEtiStart(startDate: string, periodEnd: Date): number {
  const start = new Date(startDate);
  const years = periodEnd.getFullYear() - start.getFullYear();
  const months = periodEnd.getMonth() - start.getMonth();
  return years * 12 + months + 1;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bunx vitest run tests/unit/payroll/payrollEti.test.ts`
Expected: all ETI tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/payroll/payrollEtiService.ts tests/unit/payroll/payrollEti.test.ts
git commit -m "feat(payroll): ETI calculation + eligibility (SARS 2025/26 formula)"
```

---

## Task 11: Medical credits integration in payroll run

**Files:**
- Modify: `src/modules/payroll/payrollRunService.ts`
- Test: `tests/unit/payroll/payrollMedicalCredits.test.ts`

Medical credits reduce PAYE owed — they are NOT a deduction from gross. Formula exists in `taxTables.ts` as `calculateMedicalCredits(mainMember, dependants)`.

- [ ] **Step 1: Write failing test**

Create `tests/unit/payroll/payrollMedicalCredits.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { calculateMedicalCredits } from '@/modules/payroll/taxTables';

describe('Medical aid tax credits', () => {
  it('no main member → R0', () => {
    expect(calculateMedicalCredits(false, 0)).toBe(0);
    expect(calculateMedicalCredits(false, 3)).toBe(0);
  });

  it('main member only → R364', () => {
    expect(calculateMedicalCredits(true, 0)).toBe(364);
  });

  it('main + 1 dependant → R728', () => {
    expect(calculateMedicalCredits(true, 1)).toBe(728);
  });

  it('main + 2 dependants → R974 (R728 + R246)', () => {
    expect(calculateMedicalCredits(true, 2)).toBe(974);
  });

  it('main + 4 dependants → R1,466', () => {
    // 364 + 364 + 3 × 246 = 1466
    expect(calculateMedicalCredits(true, 4)).toBe(1466);
  });
});

describe('Medical credits reduce PAYE', () => {
  it('computePayeAfterMedicalCredits applies credit then floors at 0', () => {
    // simulated usage
    const grossPaye = 1000;
    const credit = calculateMedicalCredits(true, 2); // 974
    expect(Math.max(0, grossPaye - credit)).toBe(26);
  });

  it('credit larger than gross PAYE floors at 0', () => {
    const grossPaye = 500;
    const credit = calculateMedicalCredits(true, 2); // 974
    expect(Math.max(0, grossPaye - credit)).toBe(0);
  });
});
```

- [ ] **Step 2: Run — verify pass (credits function already exists)**

Run: `bunx vitest run tests/unit/payroll/payrollMedicalCredits.test.ts`
Expected: all tests pass (formulas already in `taxTables.ts`).

- [ ] **Step 3: Integrate into `createPayrollRun`**

Open `src/modules/payroll/payrollRunService.ts`. Modify the imports at the top:

```typescript
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  calculateMonthlyPAYE,
  calculateUIF,
  calculateSDL,
  calculateAgeFromIdNumber,
  calculateMedicalCredits,
} from './taxTables';
import { calculateETI, isEtiEligible } from './payrollEtiService';
import { SARS_CODES } from './sarsCodes';
import type {
  PayrollRun,
  PayrollRunWithPayslips,
  Payslip,
  CustomDeduction,
  SarsBreakdownLine,
} from './types';
import { mapPayrollRun, mapPayslip } from './payrollMappers';
import { resolvePayrollGLAccounts, buildPayrollJournalLines } from './payrollGLHelper';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
```

Update the employee-selection query to include the new columns (replace the existing `empRows` query):

```typescript
    const empRows = (await sql`
      SELECT e.*,
        ps.basic_salary, ps.travel_allowance, ps.housing_allowance,
        ps.cell_allowance, ps.other_allowances, ps.annual_bonus, ps.commission,
        ps.medical_aid_contribution, ps.retirement_fund_contribution_pct,
        ps.custom_deductions,
        ps.basic_salary_code, ps.travel_allowance_code, ps.housing_allowance_code,
        ps.cell_allowance_code, ps.other_allowances_code,
        ps.annual_bonus_code, ps.commission_code
      FROM employees e
      JOIN LATERAL (
        SELECT * FROM pay_structures p
        WHERE p.employee_id = e.id
          AND p.effective_from <= ${periodEnd}::DATE
          AND (p.effective_to IS NULL OR p.effective_to >= ${periodStart}::DATE)
        ORDER BY p.effective_from DESC LIMIT 1
      ) ps ON TRUE
      WHERE e.company_id = ${companyId}::UUID AND e.status = 'active'
        AND e.start_date <= ${periodEnd}::DATE
        AND (e.termination_date IS NULL OR e.termination_date >= ${periodStart}::DATE)
      ORDER BY e.employee_number
    `) as Row[];
```

Inside the `for (const emp of empRows)` loop, replace the calculation block with:

```typescript
      const basic = Number(emp.basic_salary) || 0;
      const travel = Number(emp.travel_allowance) || 0;
      const housing = Number(emp.housing_allowance) || 0;
      const cell = Number(emp.cell_allowance) || 0;
      const other = Number(emp.other_allowances) || 0;
      const annualBonus = Number(emp.annual_bonus) || 0;
      const commission = Number(emp.commission) || 0;
      const medical = Number(emp.medical_aid_contribution) || 0;
      const retirePct = Number(emp.retirement_fund_contribution_pct) || 0;
      const customDeds: CustomDeduction[] = Array.isArray(emp.custom_deductions)
        ? emp.custom_deductions
        : (typeof emp.custom_deductions === 'string' ? JSON.parse(emp.custom_deductions) : []);

      const travelTaxablePct = Number(emp.travel_taxable_pct) || 80;
      const taxableTravel = Math.round(travel * (travelTaxablePct / 100) * 100) / 100;

      const grossPay = basic + travel + housing + cell + other + annualBonus + commission;
      const taxableGross = basic + taxableTravel + housing + cell + other + annualBonus + commission;

      const retireFund = Math.round(basic * (retirePct / 100) * 100) / 100;
      const age = calculateAgeFromIdNumber(String(emp.id_number || ''), new Date(periodEnd));

      // Gross PAYE before medical credit
      const grossPaye = calculateMonthlyPAYE(taxableGross - retireFund, age);
      const medicalCredit = calculateMedicalCredits(
        Boolean(emp.medical_aid_main_member),
        Number(emp.medical_aid_dependants) || 0
      );
      const paye = Math.max(0, Math.round((grossPaye - medicalCredit) * 100) / 100);

      const uif = calculateUIF(grossPay);

      // ETI — employer-side, does NOT reduce payslip net
      const etiResult = isEtiEligible({
        idNumber: emp.id_number ? String(emp.id_number) : null,
        etiStartDate: emp.eti_employment_start_date ? String(emp.eti_employment_start_date) : null,
        isConnectedPerson: Boolean(emp.eti_is_connected_person),
        periodEnd: new Date(periodEnd),
      });
      let etiAmount = 0;
      let etiMonths = 0;
      if (etiResult.eligible) {
        const { monthsSinceEtiStart } = await import('./payrollEtiService');
        etiMonths = monthsSinceEtiStart(
          String(emp.eti_employment_start_date),
          new Date(periodEnd)
        );
        etiAmount = calculateETI(grossPay, etiMonths);
      }

      const customTotal = customDeds.reduce((s, d) => s + (Number(d.amount) || 0), 0);
      const totalDeds = paye + uif.employee + medical + retireFund + customTotal;
      const netPay = Math.round((grossPay - totalDeds) * 100) / 100;

      const ytd = ytdMap.get(String(emp.id)) ?? { gross: 0, paye: 0, uif: 0 };

      const sarsBreakdown: SarsBreakdownLine[] = [];
      if (basic > 0) sarsBreakdown.push({ code: String(emp.basic_salary_code || '3601'), description: SARS_CODES[String(emp.basic_salary_code || '3601')]?.description || 'Basic salary', amount: basic, type: 'income' });
      if (travel > 0) sarsBreakdown.push({ code: String(emp.travel_allowance_code || '3713'), description: SARS_CODES[String(emp.travel_allowance_code || '3713')]?.description || 'Travel allowance', amount: travel, type: 'income' });
      if (housing > 0) sarsBreakdown.push({ code: String(emp.housing_allowance_code || '3802'), description: SARS_CODES[String(emp.housing_allowance_code || '3802')]?.description || 'Housing', amount: housing, type: 'income' });
      if (cell > 0) sarsBreakdown.push({ code: String(emp.cell_allowance_code || '3713'), description: 'Cell allowance', amount: cell, type: 'income' });
      if (other > 0) sarsBreakdown.push({ code: String(emp.other_allowances_code || '3601'), description: 'Other allowances', amount: other, type: 'income' });
      if (annualBonus > 0) sarsBreakdown.push({ code: String(emp.annual_bonus_code || '3605'), description: 'Annual bonus', amount: annualBonus, type: 'income' });
      if (commission > 0) sarsBreakdown.push({ code: String(emp.commission_code || '3606'), description: 'Commission', amount: commission, type: 'income' });
      if (paye > 0) sarsBreakdown.push({ code: '4001', description: 'PAYE', amount: paye, type: 'deduction' });
      if (uif.employee > 0) sarsBreakdown.push({ code: '4002', description: 'UIF — employee', amount: uif.employee, type: 'deduction' });
      if (retireFund > 0) sarsBreakdown.push({ code: '4006', description: 'Retirement fund', amount: retireFund, type: 'deduction' });
      if (medical > 0) sarsBreakdown.push({ code: '4474', description: 'Medical aid — employee', amount: medical, type: 'deduction' });
      if (etiAmount > 0) sarsBreakdown.push({ code: '6004', description: 'ETI offset', amount: etiAmount, type: 'employer' });

      const slipRows = (await sql`
        INSERT INTO payslips (
          payroll_run_id, employee_id, basic_salary, travel_allowance, housing_allowance,
          cell_allowance, other_allowances, annual_bonus, commission,
          gross_pay, paye, uif_employee, uif_employer, sdl,
          medical_aid, medical_aid_credit, retirement_fund, other_deductions,
          total_deductions, net_pay,
          ytd_gross, ytd_paye, ytd_uif,
          eti_amount, eti_months, sars_breakdown
        ) VALUES (
          ${runId}::UUID, ${emp.id}::UUID, ${basic}, ${travel}, ${housing}, ${cell}, ${other},
          ${annualBonus}, ${commission},
          ${grossPay}, ${paye}, ${uif.employee}, ${uif.employer}, ${0},
          ${medical}, ${medicalCredit}, ${retireFund}, ${customTotal},
          ${totalDeds}, ${netPay},
          ${ytd.gross + grossPay},
          ${ytd.paye + paye},
          ${ytd.uif + uif.employee},
          ${etiAmount}, ${etiMonths}, ${JSON.stringify(sarsBreakdown)}::JSONB
        ) RETURNING *
      `) as Row[];

      totalGross += grossPay;
      totalPaye += paye;
      totalUifEmployee += uif.employee;
      totalUifEmployer += uif.employer;
      totalNet += netPay;
      totalEti += etiAmount;

      payslips.push({
        ...mapPayslip(slipRows[0]!),
        employee_number: String(emp.employee_number), first_name: String(emp.first_name),
        last_name: String(emp.last_name),
        id_number: emp.id_number ? String(emp.id_number) : undefined,
        tax_number: emp.tax_number ? String(emp.tax_number) : undefined,
        department: emp.department ? String(emp.department) : undefined,
        position: emp.position ? String(emp.position) : undefined,
      });
```

Add `totalEti` to the local totals declaration (before the loop):

```typescript
    let totalGross = 0, totalPaye = 0, totalUifEmployee = 0, totalUifEmployer = 0, totalNet = 0;
    let totalEti = 0;
```

Update the final `UPDATE payroll_runs` query to include `total_eti`:

```typescript
    await sql`
      UPDATE payroll_runs SET total_gross=${totalGross}, total_paye=${totalPaye},
        total_uif_employee=${totalUifEmployee}, total_uif_employer=${totalUifEmployer},
        total_sdl=${totalSdl}, total_eti=${totalEti}, total_net=${totalNet},
        total_company_cost=${totalCompanyCost}
      WHERE id = ${runId}::UUID
    `;
```

And include `total_eti` in the returned run mapping:

```typescript
    return {
      ...mapPayrollRun({
        ...runRows[0]!,
        total_gross: totalGross, total_paye: totalPaye,
        total_uif_employee: totalUifEmployee, total_uif_employer: totalUifEmployer,
        total_sdl: totalSdl, total_eti: totalEti, total_net: totalNet,
        total_company_cost: totalCompanyCost
      }),
      payslips,
    };
```

- [ ] **Step 4: Type check**

Run: `bunx tsc --noEmit`
Expected: no errors in payrollRunService.

- [ ] **Step 5: Commit**

```bash
git add src/modules/payroll/payrollRunService.ts tests/unit/payroll/payrollMedicalCredits.test.ts
git commit -m "feat(payroll): apply medical aid credit to PAYE + compute ETI per payslip"
```

---

## Task 12: Audit service

**Files:**
- Create: `src/modules/payroll/payrollAuditService.ts`
- Test: `tests/unit/payroll/payrollAudit.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/payroll/payrollAudit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { diffValues } from '@/modules/payroll/payrollAuditService';

describe('diffValues helper', () => {
  it('returns only changed fields', () => {
    const oldV = { a: 1, b: 'x', c: true };
    const newV = { a: 1, b: 'y', c: false };
    const diff = diffValues(oldV, newV);
    expect(diff.old).toEqual({ b: 'x', c: true });
    expect(diff.new).toEqual({ b: 'y', c: false });
  });

  it('captures added fields', () => {
    const oldV = { a: 1 };
    const newV = { a: 1, b: 2 };
    const diff = diffValues(oldV, newV);
    expect(diff.old).toEqual({ b: undefined });
    expect(diff.new).toEqual({ b: 2 });
  });

  it('captures removed fields', () => {
    const oldV = { a: 1, b: 2 };
    const newV = { a: 1 };
    const diff = diffValues(oldV, newV);
    expect(diff.old).toEqual({ b: 2 });
    expect(diff.new).toEqual({ b: undefined });
  });

  it('empty diff when nothing changed', () => {
    const v = { a: 1, b: 'x' };
    const diff = diffValues(v, v);
    expect(diff.old).toEqual({});
    expect(diff.new).toEqual({});
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bunx vitest run tests/unit/payroll/payrollAudit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement service**

Create `src/modules/payroll/payrollAuditService.ts`:

```typescript
/**
 * Payroll Audit Service
 * Writes chronological audit entries for every mutation to employees,
 * pay_structures, and payroll_runs. Read API exposed for the audit-log UI.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export type AuditEntityType = 'employee' | 'pay_structure' | 'payroll_run';
export type AuditAction = 'create' | 'update' | 'delete' | 'complete' | 'reverse';

export interface AuditWriteInput {
  companyId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  changedBy: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  notes?: string;
}

export interface AuditEntry {
  id: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  changedBy: string | null;
  changedAt: string;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  notes: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function writeAuditEntry(input: AuditWriteInput): Promise<void> {
  try {
    await sql`
      INSERT INTO payroll_audit_log (
        company_id, entity_type, entity_id, action, changed_by,
        old_values, new_values, notes
      ) VALUES (
        ${input.companyId}::UUID,
        ${input.entityType},
        ${input.entityId}::UUID,
        ${input.action},
        ${input.changedBy},
        ${input.oldValues ? JSON.stringify(input.oldValues) : null}::JSONB,
        ${input.newValues ? JSON.stringify(input.newValues) : null}::JSONB,
        ${input.notes || null}
      )
    `;
  } catch (err) {
    // Audit logging MUST NOT throw and block the primary operation — just log.
    log.error('writeAuditEntry failed', { input, error: err }, 'payroll-audit');
  }
}

export async function listAuditEntries(
  companyId: string,
  filters: { entityType?: AuditEntityType; entityId?: string; limit?: number }
): Promise<AuditEntry[]> {
  const limit = Math.min(filters.limit || 200, 500);
  try {
    let rows: Row[];
    if (filters.entityType && filters.entityId) {
      rows = (await sql`
        SELECT * FROM payroll_audit_log
        WHERE company_id = ${companyId}::UUID
          AND entity_type = ${filters.entityType}
          AND entity_id = ${filters.entityId}::UUID
        ORDER BY changed_at DESC
        LIMIT ${limit}
      `) as Row[];
    } else if (filters.entityType) {
      rows = (await sql`
        SELECT * FROM payroll_audit_log
        WHERE company_id = ${companyId}::UUID
          AND entity_type = ${filters.entityType}
        ORDER BY changed_at DESC
        LIMIT ${limit}
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT * FROM payroll_audit_log
        WHERE company_id = ${companyId}::UUID
        ORDER BY changed_at DESC
        LIMIT ${limit}
      `) as Row[];
    }

    return rows.map((r) => ({
      id: String(r.id),
      entityType: String(r.entity_type) as AuditEntityType,
      entityId: String(r.entity_id),
      action: String(r.action) as AuditAction,
      changedBy: r.changed_by ? String(r.changed_by) : null,
      changedAt: String(r.changed_at),
      oldValues: r.old_values as Record<string, unknown> | null,
      newValues: r.new_values as Record<string, unknown> | null,
      notes: r.notes ? String(r.notes) : null,
    }));
  } catch (err) {
    log.error('listAuditEntries failed', { error: err }, 'payroll-audit');
    throw err;
  }
}

/**
 * Pure helper — computes the subset of fields that changed between two objects.
 * Returns {old: {...changed}, new: {...changed}} for storage in audit log.
 */
export function diffValues(
  oldV: Record<string, unknown>,
  newV: Record<string, unknown>
): { old: Record<string, unknown>; new: Record<string, unknown> } {
  const out = { old: {} as Record<string, unknown>, new: {} as Record<string, unknown> };
  const keys = new Set([...Object.keys(oldV), ...Object.keys(newV)]);
  for (const k of keys) {
    if (oldV[k] !== newV[k]) {
      out.old[k] = oldV[k];
      out.new[k] = newV[k];
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run tests/unit/payroll/payrollAudit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/payroll/payrollAuditService.ts tests/unit/payroll/payrollAudit.test.ts
git commit -m "feat(payroll): audit log service (write + read + diff helper)"
```

---

## Task 13: Wire audit into employee + payroll run services

**Files:**
- Modify: `src/modules/payroll/payrollEmployeeService.ts`
- Modify: `src/modules/payroll/payrollRunService.ts`

- [ ] **Step 1: Employee — audit create**

Open `src/modules/payroll/payrollEmployeeService.ts`. At the top add:

```typescript
import { writeAuditEntry, diffValues } from './payrollAuditService';
```

Extend `createEmployee` to accept a `userId`:

```typescript
export async function createEmployee(
  companyId: string,
  input: CreateEmployeeInput,
  userId: string | null = null
): Promise<EmployeeWithPay> {
  try {
    // ... existing INSERT logic unchanged ...

    const employeeId = String(empRows[0]!.id);

    // ... existing pay_structure INSERT ...

    await writeAuditEntry({
      companyId,
      entityType: 'employee',
      entityId: employeeId,
      action: 'create',
      changedBy: userId,
      newValues: { ...input },
    });

    log.info('Employee created', { id: employeeId, number: input.employee_number }, 'payroll');

    const employee = await getEmployee(companyId, employeeId);
    if (!employee) throw new Error('Failed to retrieve created employee');
    return employee;
  } catch (err) {
    log.error('createEmployee failed', { error: err }, 'payroll');
    throw err;
  }
}
```

Extend `updateEmployee` to capture old-values + audit:

```typescript
export async function updateEmployee(
  companyId: string,
  id: string,
  input: UpdateEmployeeInput,
  userId: string | null = null
): Promise<EmployeeWithPay> {
  try {
    // Capture old state before mutation
    const before = await getEmployee(companyId, id);
    if (!before) throw new Error('Employee not found');

    // ... existing UPDATE employees logic unchanged ...
    // ... existing pay_structure rotate-and-insert logic unchanged ...

    log.info('Employee updated', { id }, 'payroll');
    const employee = await getEmployee(companyId, id);
    if (!employee) throw new Error('Employee not found');

    const diff = diffValues(
      before as unknown as Record<string, unknown>,
      employee as unknown as Record<string, unknown>
    );
    await writeAuditEntry({
      companyId,
      entityType: 'employee',
      entityId: id,
      action: 'update',
      changedBy: userId,
      oldValues: diff.old,
      newValues: diff.new,
    });

    return employee;
  } catch (err) {
    log.error('updateEmployee failed', { id, error: err }, 'payroll');
    throw err;
  }
}
```

- [ ] **Step 2: Payroll run — audit complete + reverse**

Open `src/modules/payroll/payrollRunService.ts`. At top:

```typescript
import { writeAuditEntry } from './payrollAuditService';
```

In `completePayrollRun`, after the `UPDATE payroll_runs SET status='completed'` block:

```typescript
    await writeAuditEntry({
      companyId,
      entityType: 'payroll_run',
      entityId: runId,
      action: 'complete',
      changedBy: userId,
      newValues: { journal_entry_id: journalEntry.id },
    });
```

In `reversePayrollRun`, after the `UPDATE payroll_runs SET status='reversed'` block:

```typescript
    await writeAuditEntry({
      companyId,
      entityType: 'payroll_run',
      entityId: runId,
      action: 'reverse',
      changedBy: userId,
      notes: 'Payroll run reversed — journal entry reversed',
    });
```

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit`
Expected: new errors will appear in the `employees.ts` API route (expects old 2-arg createEmployee). Fix in Task 14.

- [ ] **Step 4: Commit**

```bash
git add src/modules/payroll/payrollEmployeeService.ts src/modules/payroll/payrollRunService.ts
git commit -m "feat(payroll): audit-log every employee create/update + payroll run complete/reverse"
```

---

## Task 14: API — validation + audit on employee endpoints

**Files:**
- Modify: `pages/api/payroll/employees.ts`
- Modify: `pages/api/payroll/employees-detail.ts`

- [ ] **Step 1: Add validation + pass userId to create**

Edit `pages/api/payroll/employees.ts`. Replace the POST branch with:

```typescript
  if (req.method === 'POST') {
    try {
      const body = req.body;
      const {
        employee_number, first_name, last_name, id_number, tax_number,
        start_date, termination_date, bank_name, bank_account_number,
        bank_branch_code, department, position, employment_type,
        pay_frequency, status: empStatus, basic_salary, travel_allowance,
        housing_allowance, cell_allowance, other_allowances,
        annual_bonus, commission,
        medical_aid_contribution, medical_aid_main_member, medical_aid_dependants,
        travel_logbook_kept, travel_taxable_pct,
        eti_employment_start_date, eti_is_connected_person,
        retirement_fund_contribution_pct, custom_deductions,
      } = body;

      if (!employee_number?.trim()) return apiResponse.badRequest(res, 'Employee number is required');
      if (!first_name?.trim()) return apiResponse.badRequest(res, 'First name is required');
      if (!last_name?.trim()) return apiResponse.badRequest(res, 'Last name is required');
      if (!start_date) return apiResponse.badRequest(res, 'Start date is required');
      if (basic_salary === undefined || basic_salary === null) {
        return apiResponse.badRequest(res, 'Basic salary is required');
      }

      // Structured validation
      const { validateSaIdNumber, validateSaTaxNumber, isDuplicateIdNumber } =
        await import('@/modules/payroll/payrollValidationService');

      if (id_number) {
        const r = validateSaIdNumber(String(id_number).trim());
        if (!r.valid) return apiResponse.badRequest(res, `ID number: ${r.reason}`);
        const dup = await isDuplicateIdNumber(companyId, String(id_number).trim());
        if (dup) return apiResponse.badRequest(res, 'An employee with this ID number already exists');
      }
      if (tax_number) {
        const r = validateSaTaxNumber(String(tax_number).trim());
        if (!r.valid) return apiResponse.badRequest(res, `Tax number: ${r.reason}`);
      }

      const userId = (req as CompanyApiRequest).userId || null;

      const employee = await createEmployee(companyId, {
        employee_number: employee_number.trim(),
        first_name: first_name.trim(),
        last_name: last_name.trim(),
        id_number: id_number?.trim() || undefined,
        tax_number: tax_number?.trim() || undefined,
        start_date,
        termination_date: termination_date || undefined,
        bank_name: bank_name?.trim() || undefined,
        bank_account_number: bank_account_number?.trim() || undefined,
        bank_branch_code: bank_branch_code?.trim() || undefined,
        department: department?.trim() || undefined,
        position: position?.trim() || undefined,
        employment_type: employment_type || 'permanent',
        pay_frequency: pay_frequency || 'monthly',
        status: empStatus || 'active',
        medical_aid_main_member: Boolean(medical_aid_main_member),
        medical_aid_dependants: Number(medical_aid_dependants || 0),
        travel_logbook_kept: Boolean(travel_logbook_kept),
        travel_taxable_pct: Number(travel_taxable_pct || 80),
        eti_employment_start_date: eti_employment_start_date || undefined,
        eti_is_connected_person: Boolean(eti_is_connected_person),
        basic_salary: Number(basic_salary),
        travel_allowance: Number(travel_allowance || 0),
        housing_allowance: Number(housing_allowance || 0),
        cell_allowance: Number(cell_allowance || 0),
        other_allowances: Number(other_allowances || 0),
        annual_bonus: Number(annual_bonus || 0),
        commission: Number(commission || 0),
        medical_aid_contribution: Number(medical_aid_contribution || 0),
        retirement_fund_contribution_pct: Number(retirement_fund_contribution_pct || 0),
        custom_deductions: custom_deductions || [],
      }, userId);

      return apiResponse.created(res, employee);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create employee';
      log.error('payroll employees POST failed', { error: err }, 'payroll-api');
      return apiResponse.badRequest(res, message);
    }
  }
```

Also update the `createEmployee` function signature: in `src/modules/payroll/payrollEmployeeService.ts`, the INSERT into `employees` must include the new columns. Replace the INSERT with:

```typescript
    const empRows = (await sql`
      INSERT INTO employees (
        company_id, employee_number, first_name, last_name, id_number, tax_number,
        start_date, termination_date, bank_name, bank_account_number,
        bank_branch_code, department, position, employment_type, pay_frequency, status,
        medical_aid_main_member, medical_aid_dependants,
        travel_logbook_kept, travel_taxable_pct,
        eti_employment_start_date, eti_is_connected_person
      ) VALUES (
        ${companyId}::UUID, ${input.employee_number}, ${input.first_name}, ${input.last_name},
        ${input.id_number || null}, ${input.tax_number || null}, ${input.start_date},
        ${input.termination_date || null}, ${input.bank_name || null},
        ${input.bank_account_number || null}, ${input.bank_branch_code || null},
        ${input.department || null}, ${input.position || null},
        ${input.employment_type || 'permanent'}, ${input.pay_frequency || 'monthly'},
        ${input.status || 'active'},
        ${input.medical_aid_main_member ?? false},
        ${input.medical_aid_dependants ?? 0},
        ${input.travel_logbook_kept ?? false},
        ${input.travel_taxable_pct ?? 80},
        ${input.eti_employment_start_date || null},
        ${input.eti_is_connected_person ?? false}
      )
      RETURNING *
    `) as Row[];
```

Similarly update the pay_structures INSERT to accept annual_bonus, commission, and all `*_code` fields (all with defaults, so callers don't need to supply).

- [ ] **Step 2: Detail endpoint — mirror validation + audit**

Read `pages/api/payroll/employees-detail.ts`, find the PUT handler, and add the same ID/tax validation + dup check (using `isDuplicateIdNumber(companyId, id, employeeId)` passing the current employee id to exclude self). Pass `userId` to `updateEmployee`.

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add pages/api/payroll/employees.ts pages/api/payroll/employees-detail.ts src/modules/payroll/payrollEmployeeService.ts
git commit -m "feat(payroll): validate SA ID & tax number on employee create/update + audit userId"
```

---

## Task 15: IRP5 Readiness service

**Files:**
- Create: `src/modules/payroll/payrollReadinessService.ts`
- Test: `tests/unit/payroll/payrollReadiness.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/unit/payroll/payrollReadiness.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { scoreEmployeeReadiness } from '@/modules/payroll/payrollReadinessService';

describe('scoreEmployeeReadiness', () => {
  const base = {
    id: 'emp-1',
    employee_number: 'E001',
    first_name: 'Alice',
    last_name: 'Test',
    id_number: '9202204720082',
    tax_number: '1234567890',
    bank_account_number: '12345678',
    bank_branch_code: '632005',
    payslipCount: 12,
    etiClaimed: 0,
    etiEligible: true,
  };

  it('ready employee = no blocking, no warnings', () => {
    const r = scoreEmployeeReadiness(base);
    expect(r.blocking).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('missing tax number = blocking', () => {
    const r = scoreEmployeeReadiness({ ...base, tax_number: null });
    expect(r.blocking.some(b => /tax number/i.test(b))).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('invalid ID = blocking', () => {
    const r = scoreEmployeeReadiness({ ...base, id_number: '1234' });
    expect(r.blocking.some(b => /ID/i.test(b))).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('no payslips = blocking', () => {
    const r = scoreEmployeeReadiness({ ...base, payslipCount: 0 });
    expect(r.blocking.some(b => /payslip/i.test(b))).toBe(true);
    expect(r.ready).toBe(false);
  });

  it('missing bank = warning, not blocking', () => {
    const r = scoreEmployeeReadiness({ ...base, bank_account_number: null });
    expect(r.warnings.some(w => /bank/i.test(w))).toBe(true);
    expect(r.ready).toBe(true);
  });

  it('ETI claimed but not eligible = warning', () => {
    const r = scoreEmployeeReadiness({ ...base, etiClaimed: 500, etiEligible: false });
    expect(r.warnings.some(w => /ETI/.test(w))).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bunx vitest run tests/unit/payroll/payrollReadiness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement service**

Create `src/modules/payroll/payrollReadinessService.ts`:

```typescript
/**
 * IRP5 Readiness Service
 * Produces per-employee submission-readiness snapshots
 * + a company roll-up (ready/not ready counts).
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validateSaIdNumber, validateSaTaxNumber } from './payrollValidationService';

export interface EmployeeReadinessInput {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number: string | null;
  tax_number: string | null;
  bank_account_number: string | null;
  bank_branch_code: string | null;
  payslipCount: number;
  etiClaimed: number;
  etiEligible: boolean;
}

export interface EmployeeReadiness {
  id: string;
  employee_number: string;
  name: string;
  blocking: string[];
  warnings: string[];
  ready: boolean;
}

export interface CompanyReadiness {
  taxYear: number;
  totalEmployees: number;
  readyCount: number;
  blockingCount: number;
  warningCount: number;
  employees: EmployeeReadiness[];
}

export function scoreEmployeeReadiness(input: EmployeeReadinessInput): EmployeeReadiness {
  const blocking: string[] = [];
  const warnings: string[] = [];

  if (!input.tax_number) blocking.push('Missing tax number');
  else {
    const t = validateSaTaxNumber(input.tax_number);
    if (!t.valid) blocking.push(`Invalid tax number: ${t.reason}`);
  }

  if (!input.id_number) blocking.push('Missing SA ID number');
  else {
    const i = validateSaIdNumber(input.id_number);
    if (!i.valid) blocking.push(`Invalid SA ID: ${i.reason}`);
  }

  if (input.payslipCount === 0) blocking.push('No payslips for the tax year');

  if (!input.bank_account_number) warnings.push('Missing bank account number');
  if (!input.bank_branch_code) warnings.push('Missing bank branch code');

  if (input.etiClaimed > 0 && !input.etiEligible) {
    warnings.push('ETI claimed but employee not currently ETI-eligible — review');
  }

  return {
    id: input.id,
    employee_number: input.employee_number,
    name: `${input.first_name} ${input.last_name}`.trim(),
    blocking,
    warnings,
    ready: blocking.length === 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

/** SA tax year runs March → February. 2026 = Mar 2025 – Feb 2026. */
function taxYearRange(yr: number): { start: string; end: string } {
  return { start: `${yr - 1}-03-01`, end: `${yr}-02-28` };
}

export async function computeCompanyReadiness(
  companyId: string,
  taxYear: number
): Promise<CompanyReadiness> {
  const { start, end } = taxYearRange(taxYear);
  try {
    const rows = (await sql`
      SELECT
        e.id,
        e.employee_number,
        e.first_name,
        e.last_name,
        e.id_number,
        e.tax_number,
        e.bank_account_number,
        e.bank_branch_code,
        e.eti_employment_start_date,
        e.eti_is_connected_person,
        COUNT(ps.id)::INTEGER AS payslip_count,
        COALESCE(SUM(ps.eti_amount), 0)::NUMERIC AS eti_claimed
      FROM employees e
      LEFT JOIN payslips ps ON ps.employee_id = e.id
      LEFT JOIN payroll_runs pr
        ON ps.payroll_run_id = pr.id
       AND pr.company_id = ${companyId}::UUID
       AND pr.period_end >= ${start}::DATE
       AND pr.period_end <= ${end}::DATE
       AND pr.status = 'completed'
      WHERE e.company_id = ${companyId}::UUID
      GROUP BY e.id
      ORDER BY e.employee_number
      LIMIT 500
    `) as Row[];

    const periodEnd = new Date(end);
    const { isEtiEligible } = await import('./payrollEtiService');

    const employees: EmployeeReadiness[] = rows.map((r) => {
      const elig = isEtiEligible({
        idNumber: r.id_number ? String(r.id_number) : null,
        etiStartDate: r.eti_employment_start_date ? String(r.eti_employment_start_date) : null,
        isConnectedPerson: Boolean(r.eti_is_connected_person),
        periodEnd,
      });
      return scoreEmployeeReadiness({
        id: String(r.id),
        employee_number: String(r.employee_number),
        first_name: String(r.first_name),
        last_name: String(r.last_name),
        id_number: r.id_number ? String(r.id_number) : null,
        tax_number: r.tax_number ? String(r.tax_number) : null,
        bank_account_number: r.bank_account_number ? String(r.bank_account_number) : null,
        bank_branch_code: r.bank_branch_code ? String(r.bank_branch_code) : null,
        payslipCount: Number(r.payslip_count) || 0,
        etiClaimed: Number(r.eti_claimed) || 0,
        etiEligible: elig.eligible,
      });
    });

    return {
      taxYear,
      totalEmployees: employees.length,
      readyCount: employees.filter((e) => e.ready).length,
      blockingCount: employees.filter((e) => e.blocking.length > 0).length,
      warningCount: employees.filter((e) => e.warnings.length > 0).length,
      employees,
    };
  } catch (err) {
    log.error('computeCompanyReadiness failed', { error: err }, 'payroll-readiness');
    throw err;
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bunx vitest run tests/unit/payroll/payrollReadiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/payroll/payrollReadinessService.ts tests/unit/payroll/payrollReadiness.test.ts
git commit -m "feat(payroll): IRP5 readiness scoring service"
```

---

## Task 16: API — IRP5 readiness endpoint

**Files:**
- Create: `pages/api/payroll/irp5-readiness.ts`

- [ ] **Step 1: Write endpoint**

```typescript
/**
 * IRP5 Readiness API
 * GET /api/payroll/irp5-readiness?taxYear=2026
 * Returns per-employee blocking issues + warnings + company roll-up.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { computeCompanyReadiness } from '@/modules/payroll/payrollReadinessService';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const taxYear = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  if (!Number.isInteger(taxYear) || taxYear < 2020 || taxYear > 2100) {
    return apiResponse.badRequest(res, 'Invalid taxYear');
  }

  try {
    const data = await computeCompanyReadiness(req.companyId, taxYear);
    return apiResponse.success(res, data);
  } catch (err) {
    log.error('irp5-readiness GET failed', { error: err }, 'payroll-api');
    return apiResponse.internalError(res, err, 'Failed to compute IRP5 readiness');
  }
}

export default withCompany(withErrorHandler(handler));
```

- [ ] **Step 2: Type check + commit**

```bash
bunx tsc --noEmit
git add pages/api/payroll/irp5-readiness.ts
git commit -m "feat(payroll): GET /api/payroll/irp5-readiness endpoint"
```

---

## Task 17: API — EMP501 reconciliation endpoint

**Files:**
- Create: `pages/api/payroll/emp501-reconciliation.ts`

- [ ] **Step 1: Write endpoint**

```typescript
/**
 * EMP501 Reconciliation API
 * GET /api/payroll/emp501-reconciliation?taxYear=2026
 * Compares the SUM of monthly EMP201 totals against aggregate IRP5 totals.
 * Any mismatch is a submission blocker.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface MonthlyTotal {
  month: string;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
}

interface Emp501Reconciliation {
  taxYear: number;
  monthly: MonthlyTotal[];
  emp201Totals: { paye: number; uifEmployee: number; uifEmployer: number; sdl: number; eti: number };
  irp5Totals: { paye: number; uifEmployee: number; uifEmployer: number };
  differences: { paye: number; uifEmployee: number; uifEmployer: number };
  isReconciled: boolean;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const taxYear = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  if (!Number.isInteger(taxYear) || taxYear < 2020 || taxYear > 2100) {
    return apiResponse.badRequest(res, 'Invalid taxYear');
  }

  const start = `${taxYear - 1}-03-01`;
  const end = `${taxYear}-02-28`;
  const { companyId } = req;

  try {
    const monthlyRows = (await sql`
      SELECT
        TO_CHAR(pr.period_end, 'YYYY-MM') AS month,
        COALESCE(SUM(pr.total_paye), 0)::NUMERIC          AS paye,
        COALESCE(SUM(pr.total_uif_employee), 0)::NUMERIC  AS uif_employee,
        COALESCE(SUM(pr.total_uif_employer), 0)::NUMERIC  AS uif_employer,
        COALESCE(SUM(pr.total_sdl), 0)::NUMERIC           AS sdl,
        COALESCE(SUM(pr.total_eti), 0)::NUMERIC           AS eti
      FROM payroll_runs pr
      WHERE pr.company_id = ${companyId}::UUID
        AND pr.status = 'completed'
        AND pr.period_end >= ${start}::DATE
        AND pr.period_end <= ${end}::DATE
      GROUP BY TO_CHAR(pr.period_end, 'YYYY-MM')
      ORDER BY 1
    `) as Row[];

    const monthly: MonthlyTotal[] = monthlyRows.map((r) => ({
      month: String(r.month),
      paye: round2(Number(r.paye)),
      uifEmployee: round2(Number(r.uif_employee)),
      uifEmployer: round2(Number(r.uif_employer)),
      sdl: round2(Number(r.sdl)),
      eti: round2(Number(r.eti)),
    }));

    const emp201Totals = monthly.reduce(
      (acc, m) => ({
        paye: round2(acc.paye + m.paye),
        uifEmployee: round2(acc.uifEmployee + m.uifEmployee),
        uifEmployer: round2(acc.uifEmployer + m.uifEmployer),
        sdl: round2(acc.sdl + m.sdl),
        eti: round2(acc.eti + m.eti),
      }),
      { paye: 0, uifEmployee: 0, uifEmployer: 0, sdl: 0, eti: 0 }
    );

    const irp5Rows = (await sql`
      SELECT
        COALESCE(SUM(ps.paye), 0)::NUMERIC          AS paye,
        COALESCE(SUM(ps.uif_employee), 0)::NUMERIC  AS uif_employee,
        COALESCE(SUM(ps.uif_employer), 0)::NUMERIC  AS uif_employer
      FROM payslips ps
      JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
      WHERE pr.company_id = ${companyId}::UUID
        AND pr.status = 'completed'
        AND pr.period_end >= ${start}::DATE
        AND pr.period_end <= ${end}::DATE
    `) as Row[];

    const irp5Totals = {
      paye: round2(Number(irp5Rows[0]?.paye) || 0),
      uifEmployee: round2(Number(irp5Rows[0]?.uif_employee) || 0),
      uifEmployer: round2(Number(irp5Rows[0]?.uif_employer) || 0),
    };

    const differences = {
      paye: round2(emp201Totals.paye - irp5Totals.paye),
      uifEmployee: round2(emp201Totals.uifEmployee - irp5Totals.uifEmployee),
      uifEmployer: round2(emp201Totals.uifEmployer - irp5Totals.uifEmployer),
    };

    const isReconciled =
      Math.abs(differences.paye) < 0.01 &&
      Math.abs(differences.uifEmployee) < 0.01 &&
      Math.abs(differences.uifEmployer) < 0.01;

    const data: Emp501Reconciliation = {
      taxYear, monthly, emp201Totals, irp5Totals, differences, isReconciled,
    };

    return apiResponse.success(res, data);
  } catch (err) {
    log.error('emp501 reconciliation failed', { error: err }, 'payroll-api');
    return apiResponse.internalError(res, err, 'Failed to compute EMP501 reconciliation');
  }
}

export default withCompany(withErrorHandler(handler));
```

- [ ] **Step 2: Type check + commit**

```bash
bunx tsc --noEmit
git add pages/api/payroll/emp501-reconciliation.ts
git commit -m "feat(payroll): GET /api/payroll/emp501-reconciliation endpoint"
```

---

## Task 18: API — audit log endpoint

**Files:**
- Create: `pages/api/payroll/audit-log.ts`

- [ ] **Step 1: Write endpoint**

```typescript
/**
 * Payroll Audit Log API
 * GET /api/payroll/audit-log?entityType=employee&entityId=<uuid>&limit=100
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  listAuditEntries,
  type AuditEntityType,
} from '@/modules/payroll/payrollAuditService';

const VALID_TYPES: AuditEntityType[] = ['employee', 'pay_structure', 'payroll_run'];

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { entityType, entityId, limit } = req.query;
  const parsedType =
    typeof entityType === 'string' && VALID_TYPES.includes(entityType as AuditEntityType)
      ? (entityType as AuditEntityType)
      : undefined;
  const parsedId = typeof entityId === 'string' ? entityId : undefined;
  const parsedLimit = typeof limit === 'string' ? Number(limit) : undefined;

  try {
    const entries = await listAuditEntries(req.companyId, {
      entityType: parsedType,
      entityId: parsedId,
      limit: parsedLimit,
    });
    return apiResponse.success(res, { entries });
  } catch (err) {
    log.error('audit-log GET failed', { error: err }, 'payroll-api');
    return apiResponse.internalError(res, err, 'Failed to fetch audit log');
  }
}

export default withCompany(withErrorHandler(handler));
```

- [ ] **Step 2: Type check + commit**

```bash
bunx tsc --noEmit
git add pages/api/payroll/audit-log.ts
git commit -m "feat(payroll): GET /api/payroll/audit-log endpoint"
```

---

## Task 19: IRP5 certificates — include SARS breakdown

**Files:**
- Modify: `pages/api/payroll/irp5-certificates.ts`

- [ ] **Step 1: Add SARS-coded breakdown to the aggregate query**

In both GET and POST handlers, modify the SELECT to ALSO aggregate per-code totals from `payslips.sars_breakdown`. Add a second query after the main aggregate that pulls the breakdown:

Insert after the main `rows` query in both GET and POST:

```typescript
      // Aggregate SARS-coded income/deduction totals per employee
      const breakdownRows = (await sql`
        SELECT
          ps.employee_id,
          br.code,
          br.description,
          br.type,
          COALESCE(SUM((br.amount)::NUMERIC), 0)::NUMERIC AS total_amount
        FROM payslips ps
        JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
        CROSS JOIN LATERAL jsonb_to_recordset(ps.sars_breakdown)
          AS br(code TEXT, description TEXT, amount NUMERIC, type TEXT)
        WHERE pr.company_id = ${companyId}::UUID
          AND pr.status = 'completed'
          AND pr.period_end >= ${start}::DATE
          AND pr.period_end <= ${end}::DATE
        GROUP BY ps.employee_id, br.code, br.description, br.type
      `) as Row[];

      const breakdownByEmployee = new Map<string, Array<{ code: string; description: string; type: string; amount: number }>>();
      for (const b of breakdownRows) {
        const key = String(b.employee_id);
        const arr = breakdownByEmployee.get(key) || [];
        arr.push({
          code: String(b.code),
          description: String(b.description),
          type: String(b.type),
          amount: round2(Number(b.total_amount) || 0),
        });
        breakdownByEmployee.set(key, arr);
      }
```

Add a `sars_breakdown` field to each certificate in the map:

```typescript
      const certs: Irp5CertRow[] = rows.map((r: Row) => ({
        employee_id:        String(r.employee_id),
        employee_number:    String(r.employee_number),
        first_name:         String(r.first_name),
        last_name:          String(r.last_name),
        id_number:          r.id_number ? String(r.id_number) : null,
        tax_number:         r.tax_number ? String(r.tax_number) : null,
        total_gross_income: round2(Number(r.total_gross_income)),
        total_paye:         round2(Number(r.total_paye)),
        total_uif_employee: round2(Number(r.total_uif_employee)),
        total_uif_employer: round2(Number(r.total_uif_employer)),
        total_net_pay:      round2(Number(r.total_net_pay)),
        certificate_number: buildCertNumber(companyId, String(r.employee_number), taxYear),
        sars_breakdown:     breakdownByEmployee.get(String(r.employee_id)) || [],
      }));
```

Extend the `Irp5CertRow` interface at the top:

```typescript
export interface Irp5CertRow {
  employee_id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number: string | null;
  tax_number: string | null;
  total_gross_income: number;
  total_paye: number;
  total_uif_employee: number;
  total_uif_employer: number;
  total_net_pay: number;
  certificate_number: string;
  sars_breakdown: Array<{ code: string; description: string; type: string; amount: number }>;
}
```

- [ ] **Step 2: Type check + commit**

```bash
bunx tsc --noEmit
git add pages/api/payroll/irp5-certificates.ts
git commit -m "feat(payroll): IRP5 certificates include per-code SARS breakdown"
```

---

## Task 20: UI — IRP5 Readiness Dashboard

**Files:**
- Create: `pages/payroll/irp5-readiness.tsx`

- [ ] **Step 1: Write the page**

```tsx
/**
 * IRP5 Readiness Dashboard
 * Shows per-employee blocking issues + warnings + company roll-up.
 */

import { useEffect, useState } from 'react';
import AppLayout from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';

interface EmployeeReadiness {
  id: string;
  employee_number: string;
  name: string;
  blocking: string[];
  warnings: string[];
  ready: boolean;
}

interface CompanyReadiness {
  taxYear: number;
  totalEmployees: number;
  readyCount: number;
  blockingCount: number;
  warningCount: number;
  employees: EmployeeReadiness[];
}

export default function IRP5ReadinessPage() {
  const [taxYear, setTaxYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<CompanyReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/payroll/irp5-readiness?taxYear=${taxYear}`);
        const json = await res.json();
        if (!cancelled) {
          if (json.success) setData(json.data as CompanyReadiness);
          else setError(json.error?.message || 'Failed to load readiness');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [taxYear]);

  const readyPct = data && data.totalEmployees > 0
    ? Math.round((data.readyCount / data.totalEmployees) * 100)
    : 0;

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">IRP5 Readiness</h1>
            <p className="text-sm text-gray-500">Submission-readiness for the tax year</p>
          </div>
          <select
            className="rounded-md border-gray-300 text-sm"
            value={taxYear}
            onChange={(e) => setTaxYear(Number(e.target.value))}
          >
            {[2024, 2025, 2026, 2027].map((y) => (
              <option key={y} value={y}>{`Tax year ${y} (Mar ${y - 1} – Feb ${y})`}</option>
            ))}
          </select>
        </div>

        {loading && <div className="text-gray-500">Loading…</div>}
        {error && <div className="text-red-600">{error}</div>}

        {data && (
          <>
            <div className="grid grid-cols-4 gap-4">
              <StatCard label="Total employees" value={data.totalEmployees} />
              <StatCard label="Ready to submit" value={data.readyCount} valueClass="text-green-600" />
              <StatCard label="With blockers" value={data.blockingCount} valueClass="text-red-600" />
              <StatCard label="With warnings" value={data.warningCount} valueClass="text-amber-600" />
            </div>

            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">Submission readiness</span>
                <span className="text-sm font-mono">{data.readyCount}/{data.totalEmployees} ({readyPct}%)</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-green-600 h-3 rounded-full transition-all"
                  style={{ width: `${readyPct}%` }}
                />
              </div>
            </div>

            <div className="bg-white rounded-lg shadow overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Employee</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Issues</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {data.employees.map((e) => (
                    <tr key={e.id}>
                      <td className="px-4 py-3 text-sm">
                        <div className="font-medium text-gray-900">{e.name}</div>
                        <div className="text-gray-500 text-xs">{e.employee_number}</div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {e.ready
                          ? <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">Ready</span>
                          : <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800">Blocked</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-sm space-y-1">
                        {e.blocking.map((b, i) => (
                          <div key={`b-${i}`} className="text-red-600">● {b}</div>
                        ))}
                        {e.warnings.map((w, i) => (
                          <div key={`w-${i}`} className="text-amber-600">⚠ {w}</div>
                        ))}
                        {e.blocking.length === 0 && e.warnings.length === 0 && (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}

function StatCard({ label, value, valueClass = 'text-gray-900' }: {
  label: string; value: number; valueClass?: string;
}) {
  return (
    <div className="bg-white rounded-lg shadow p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${valueClass}`}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Type check + commit**

```bash
bunx tsc --noEmit
git add pages/payroll/irp5-readiness.tsx
git commit -m "feat(payroll): IRP5 Readiness Dashboard page"
```

---

## Task 21: UI — EMP501 Reconciliation page

**Files:**
- Create: `pages/payroll/emp501.tsx`

- [ ] **Step 1: Write the page**

```tsx
/**
 * EMP501 Reconciliation
 * Compares sum of monthly EMP201 totals against aggregate IRP5 totals.
 */

import { useEffect, useState } from 'react';
import AppLayout from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';

interface MonthlyTotal {
  month: string;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
}

interface Emp501 {
  taxYear: number;
  monthly: MonthlyTotal[];
  emp201Totals: { paye: number; uifEmployee: number; uifEmployer: number; sdl: number; eti: number };
  irp5Totals: { paye: number; uifEmployee: number; uifEmployer: number };
  differences: { paye: number; uifEmployee: number; uifEmployer: number };
  isReconciled: boolean;
}

function R(n: number): string {
  return `R ${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Emp501Page() {
  const [taxYear, setTaxYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<Emp501 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/api/payroll/emp501-reconciliation?taxYear=${taxYear}`);
        const json = await res.json();
        if (!cancelled) {
          if (json.success) setData(json.data as Emp501);
          else setError(json.error?.message || 'Failed to load reconciliation');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [taxYear]);

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">EMP501 Reconciliation</h1>
            <p className="text-sm text-gray-500">Annual PAYE/UIF vs sum of monthly EMP201s</p>
          </div>
          <select
            className="rounded-md border-gray-300 text-sm"
            value={taxYear}
            onChange={(e) => setTaxYear(Number(e.target.value))}
          >
            {[2024, 2025, 2026, 2027].map((y) => (
              <option key={y} value={y}>{`Tax year ${y}`}</option>
            ))}
          </select>
        </div>

        {loading && <div className="text-gray-500">Loading…</div>}
        {error && <div className="text-red-600">{error}</div>}

        {data && (
          <>
            <div className={`rounded-lg p-4 ${data.isReconciled ? 'bg-green-50' : 'bg-red-50'}`}>
              <div className="font-semibold">
                {data.isReconciled
                  ? '✔ Reconciled — EMP201 totals match IRP5 totals'
                  : '✘ Not reconciled — differences detected'}
              </div>
              {!data.isReconciled && (
                <div className="mt-2 text-sm text-red-800 space-y-1">
                  {data.differences.paye !== 0 && <div>PAYE difference: {R(data.differences.paye)}</div>}
                  {data.differences.uifEmployee !== 0 && <div>UIF employee difference: {R(data.differences.uifEmployee)}</div>}
                  {data.differences.uifEmployer !== 0 && <div>UIF employer difference: {R(data.differences.uifEmployer)}</div>}
                </div>
              )}
            </div>

            <div className="bg-white rounded-lg shadow overflow-hidden">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Month</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">PAYE</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">UIF (emp)</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">UIF (er)</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">SDL</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">ETI</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {data.monthly.map((m) => (
                    <tr key={m.month}>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{m.month}</td>
                      <td className="px-4 py-3 text-sm text-right">{R(m.paye)}</td>
                      <td className="px-4 py-3 text-sm text-right">{R(m.uifEmployee)}</td>
                      <td className="px-4 py-3 text-sm text-right">{R(m.uifEmployer)}</td>
                      <td className="px-4 py-3 text-sm text-right">{R(m.sdl)}</td>
                      <td className="px-4 py-3 text-sm text-right text-green-700">{R(m.eti)}</td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50 font-semibold">
                    <td className="px-4 py-3 text-sm">EMP201 total</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.emp201Totals.paye)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.emp201Totals.uifEmployee)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.emp201Totals.uifEmployer)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.emp201Totals.sdl)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.emp201Totals.eti)}</td>
                  </tr>
                  <tr className="bg-gray-50 font-semibold">
                    <td className="px-4 py-3 text-sm">IRP5 aggregate</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.irp5Totals.paye)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.irp5Totals.uifEmployee)}</td>
                    <td className="px-4 py-3 text-sm text-right">{R(data.irp5Totals.uifEmployer)}</td>
                    <td className="px-4 py-3 text-sm text-right">—</td>
                    <td className="px-4 py-3 text-sm text-right">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Type check + commit**

```bash
bunx tsc --noEmit
git add pages/payroll/emp501.tsx
git commit -m "feat(payroll): EMP501 reconciliation page"
```

---

## Task 22: Nav — add Readiness + EMP501 entries

**Files:**
- Modify: `src/components/accounting/navSections/payroll.ts`

- [ ] **Step 1: Update nav config**

Replace file contents with:

```typescript
import type { Tab } from './types';

export const payrollTab: Tab = {
  id: 'payroll', label: 'Payroll',
  items: [
    {
      section: 'Lists',
      items: [
        { label: 'Employees', href: '/payroll/employees' },
      ],
    },
    {
      section: 'Processing',
      items: [
        { label: 'Payroll Runs', href: '/payroll/runs' },
        { label: 'New Payroll Run', href: '/payroll/runs/new' },
      ],
    },
    {
      section: 'Leave',
      items: [
        { label: 'Leave Applications', href: '/payroll/leave' },
      ],
    },
    {
      section: 'SARS Returns',
      items: [
        { label: 'EMP201 / SDL', href: '/payroll/emp201' },
        { label: 'EMP501 Reconciliation', href: '/payroll/emp501' },
        { label: 'IRP5 Certificates', href: '/payroll/irp5' },
        { label: 'IRP5 Readiness', href: '/payroll/irp5-readiness' },
        { label: 'UIF Declaration', href: '/payroll/uif' },
        { label: 'Tax Directives', href: '/payroll/tax-directives' },
      ],
    },
  ],
};
```

- [ ] **Step 2: Commit**

```bash
git add src/components/accounting/navSections/payroll.ts
git commit -m "feat(payroll): nav entries for EMP501 reconciliation + IRP5 readiness"
```

---

## Task 23: Full test + build verification

- [ ] **Step 1: Run all payroll unit tests**

Run: `bunx vitest run tests/unit/payroll/`
Expected: all tests pass.

- [ ] **Step 2: Full TypeScript check**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: production build succeeds.

- [ ] **Step 4: Manual smoke test**

Start dev: `bun run dev`. Log in. Visit in order:
1. `/payroll/employees/new` — add an employee with a deliberately-bad SA ID → expect form error.
2. `/payroll/employees/new` — add a valid employee including medical aid + ETI start date.
3. `/payroll/runs/new` — create a run; verify resulting payslip has `sars_breakdown` populated and ETI amount reflected.
4. `/payroll/irp5-readiness` — confirm the new employee appears with status Ready / Blocked as appropriate.
5. `/payroll/emp501` — confirm monthly totals table loads.

- [ ] **Step 5: Commit any fix-up patches and open a PR**

```bash
gh pr create --title "feat(payroll): SARS compliance, ETI, medical credits, readiness dashboard, audit trail" --body "$(cat <<'EOF'
## Summary
- Adds SARS IRP5 source codes to pay structures + payslips (migration 341)
- Adds medical aid dependants + travel logbook flags (migration 342)
- Adds ETI fields (migration 343)
- Adds payroll audit log table (migration 344)
- New services: validation (SA ID Luhn, tax number), ETI, readiness, audit
- New endpoints: /irp5-readiness, /emp501-reconciliation, /audit-log
- New UI: IRP5 Readiness Dashboard, EMP501 Reconciliation
- Medical aid tax credits now correctly reduce PAYE
- ETI computed per payslip and rolled up into EMP501 reconciliation
- Comprehensive unit test coverage added (validation, ETI, medical credits, readiness, audit)

## Test plan
- [ ] All payroll unit tests pass (`bunx vitest run tests/unit/payroll/`)
- [ ] Type check clean (`bunx tsc --noEmit`)
- [ ] Production build succeeds (`bun run build`)
- [ ] Manual smoke test: create employee → run payroll → view readiness → view EMP501
EOF
)"
```

---

## Self-review

### Spec coverage
- [x] SARS source codes on pay components → Tasks 1, 6, 7, 8, 11, 19
- [x] SA ID validation (Luhn) → Task 9
- [x] Tax number validation → Task 9
- [x] Medical aid credits applied → Task 11
- [x] ETI calculation + eligibility → Tasks 3, 10
- [x] IRP5 Readiness dashboard → Tasks 15, 16, 20
- [x] Audit trail → Tasks 4, 12, 13, 18
- [x] EMP501 reconciliation → Tasks 17, 21
- [x] Duplicate employee detection → Task 9
- [x] Nav exposure → Task 22

### Placeholder scan — none present

### Type consistency
- `ValidationResult` reused between validation + readiness.
- `SarsBreakdownLine` defined in types.ts, consumed by payrollRunService + mappers + IRP5 certs.
- `AuditEntityType` defined in audit service, used by audit API.
- `EmployeeReadiness` / `CompanyReadiness` defined in readiness service, used by API + UI.
- Method names consistent: `validateSaIdNumber`, `validateSaTaxNumber`, `calculateETI`, `isEtiEligible`, `computeCompanyReadiness`, `writeAuditEntry`, `listAuditEntries`, `diffValues`.
