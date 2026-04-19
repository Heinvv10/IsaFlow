# PRD-02: Payroll — SA Compliance Engine

**Status:** `PLANNED`  
**Priority:** P1 — High-value differentiator, competitive gap vs Sage/VIP/SimplePay  
**Source specs:** `Payroll.docx`, `Payroll That Actually Works — Built for South Africa.docx`  
**Related modules:** Payroll (partial — `pages/payroll/`, `payrollPdfBuilders`, `payslipVerificationService.ts`), SARS (`pages/accounting/sars/`), Tax

---

## 1. Problem Statement

SA payroll has a double-validation problem: errors only surface at year-end (IRP5/EMP501 submission time), by which point fixing them requires cycles of: fix → regenerate → re-export → re-import → resubmit. This is the #1 pain point across Sage VIP, SimplePay, PaySpace, and VIP users.

Secondary issues:
- Technical/cryptic error messages (SARS source codes, validation file errors)
- EMP501 reconciliation failures (cent-level PAYE/UIF/SDL/ETI mismatches)
- Dependency on clean historical data (old mistakes appear at year-end)
- Manual IRP5 generation process with too many steps
- No guided "am I SARS-ready?" readiness check
- Poor ETI (Employment Tax Incentive) calculation and reconciliation

The existing IsaFlow payroll module has the structural skeleton (payroll runs, employees, payslips, leave) but lacks the SA compliance engine that makes it production-ready vs Sage/VIP.

---

## 2. Strategic Position

> "Payroll that is always SARS-ready. No surprises. No rework. Just control."

ISaFlow's differentiator: **continuous validation** instead of year-end panic. Every payroll run validates in real time. The system tells the user *what is wrong, where, and how to fix it* — in plain English, not SARS error codes.

---

## 3. What Already Exists

| Component | Status | Notes |
|-----------|--------|-------|
| `pages/payroll/runs/` | ✅ Exists | Basic payroll run pages |
| `pages/payroll/employees/` | ✅ Exists | Employee list |
| `pages/payroll/leave/` | ✅ Exists | Leave applications |
| `payrollPdfBuilders1.ts` / `payrollPdfBuilders2.ts` | ✅ Exists | Payslip PDF generation |
| `payslipVerificationService.ts` | ✅ Exists | Basic payslip verification |
| `pages/accounting/sars/emp201.tsx` | ✅ Exists | Basic EMP201 page |
| `reports/emp201Service.ts` | ✅ Exists | EMP201 data |
| `reports/irp5Service.ts` | ✅ Exists | Basic IRP5 service |
| Real-time SARS validation engine | ❌ Missing | Net-new |
| Source code intelligence | ❌ Missing | Net-new |
| EMP501 reconciliation engine | ❌ Missing | Net-new |
| ETI engine | ❌ Missing | Net-new |
| IRP5 readiness dashboard | ❌ Missing | Net-new |
| Year-end guided workflow | ❌ Missing | Net-new |
| Leave management (full) | ❌ Partial | Needs comprehensive leave types |
| Multi-rate/component payroll | ❌ Partial | Needs full component model |

---

## 4. Module Specifications

### 4.1 Employee Payroll Profile

**What it must do:**
- Full SA-required employee master: ID/passport, tax number, tax directive, employment type (permanent/contract/casual), start date, department, cost centre
- Banking details (for EFT payment)
- UIF registration status, UIF number
- Employment equity classification (for EEA reporting)
- Remuneration components: basic salary, medical aid, pension/provident, travel allowance, cell allowance, commission
- Each component carries: SARS source code, taxable/non-taxable flag, UIF-applicable flag, SDL-applicable flag
- Effective-date history for salary changes (IRP5 must reflect correct amounts per period)

**SARS Source Code Engine:**
- Embedded source code lookup with validation rules
- Prevent invalid source code combinations (system knows which codes conflict)
- Suggest the correct source code based on component type
- Warn when a code requires a corresponding code (e.g. code 3601 requires code 4001 for PAYE)

**Data entities:**
```
payroll_employees (id, company_id, user_id, id_number, passport_number, tax_number, 
  tax_directive_number, employment_type, start_date, end_date, department_id, cost_centre_id,
  uif_number, equity_race, equity_gender, equity_disability)
payroll_bank_details (id, employee_id, bank_name, account_number, account_type, branch_code, 
  is_active, effective_from)
payroll_components (id, company_id, name, sars_source_code, component_type, 
  is_taxable, is_uif_applicable, is_sdl_applicable, is_active)
payroll_employee_components (id, employee_id, component_id, amount, effective_from, effective_to)
```

---

### 4.2 Payroll Run Engine

**What it must do:**
- Monthly payroll run: select period → system pre-populates all active employees with their component values
- Override individual components per period (ad-hoc allowances, deductions, bonuses)
- Calculate per employee: gross earnings, taxable income, PAYE, UIF (employer + employee), SDL, net pay
- PAYE calculation: correct SA tax table for the financial year, with correct tax rebates (primary, secondary, tertiary), medical tax credits
- Bonus / 13th cheque: trigger annual equivalent tax computation
- Retrospective adjustments: handle pay corrections for prior periods within the tax year (must recalculate cumulative PAYE)
- Calculation engine is deterministic: same inputs → same outputs always

**ETI (Employment Tax Incentive) Engine:**
- Determine ETI eligibility per employee: age 18–35, wage < threshold, first/second year of employment, not domestic worker
- Calculate ETI monthly incentive correctly per SARS formula
- Track cumulative ETI per employee per tax year
- ETI reduces EMP201 PAYE liability
- Warn when ETI eligibility expires

**Continuous Validation (runs after every change):**
- Missing/invalid tax numbers (SARS format validation)
- Missing bank details for employees with EFT payment
- PAYE computation sanity check (employee's effective rate shouldn't be 0% for taxable income above threshold)
- UIF ceiling check
- Duplicate tax numbers across employees
- Each validation has: severity (error/warning/info), plain-English message, "Fix it" deep-link to the exact field

---

### 4.3 EMP201 — Monthly PAYE Submission

**What it must do:**
- Generate EMP201 values: PAYE, SDL, UIF, ETI from payroll run totals
- Reconcile computed EMP201 vs previously submitted (detect if payroll changes affect a closed period)
- Export EMP201 in SARS-required format
- Track submission status: Not Started → Submitted → Accepted / Rejected
- Integration path with e@syFile (manual export initially; direct API Phase 2)
- Payment reference number tracking

---

### 4.4 IRP5 / EMP501 Engine

This is the highest-risk, highest-value component.

**IRP5 Certificate Generation:**
- Compute per employee, per tax year: all income / deduction / tax source code totals
- Auto-populate from payroll run data — zero manual input
- Source code validation: every amount must be on a valid source code, no conflicts, no missing mandatory counterparts
- Tax certificate types: IRP5 (employed) and IT3(a) (no tax deducted)
- Certificate number generation and tracking

**IRP5 Readiness Dashboard:**
- Live "readiness score" (0–100%) for the tax year
- Checklist items: all employees have tax numbers ✓, no duplicate tax numbers ✓, PAYE reconciles to EMP201 submissions ✓, all source codes valid ✓, no outstanding corrections ✓
- Items show exact count of failures and direct links to fix them
- Can be run any time during the year — not just at year-end

**EMP501 Reconciliation:**
- Reconcile: Σ monthly EMP201 PAYE paid = total PAYE on all IRP5 certificates
- Reconcile: Σ SDL submitted = total SDL on certificates  
- Reconcile: Σ UIF submitted = total UIF on certificates
- ETI reconciliation: confirm ETI claimed matches EMP201 reductions
- Highlight cent-level differences with drill-down to the source period/employee
- Automated reconciliation statement: show system totals vs SARS totals side-by-side

**Export:**
- Generate `.zip` file in SARS e@syFile format (IRP5 import format)
- Export EMP501 submission CSV
- PDF payroll summaries per period

---

### 4.5 Leave Management

**What it must do:**
- Leave types: annual leave, sick leave, family responsibility, maternity/paternity, unpaid leave (BCEA-compliant defaults)
- Leave accrual: correct BCEA accrual rules (annual leave = 1.25 days/month; sick leave = 1 day per 26 days worked in first 6 months, then 30 days per 36-month cycle)
- Leave requests: employee → manager approval workflow
- Leave calendar: team view showing approved leave
- Leave on payslip: deduction of unpaid leave, leave pay on termination (accrued leave payout)
- Leave balance report
- Carry-over rules (configurable)

**Data entities:**
```
payroll_leave_types (id, company_id, name, accrual_rule, max_carry_over, is_paid, bcea_type)
payroll_leave_balances (id, employee_id, leave_type_id, year, accrued, taken, pending, balance)
payroll_leave_requests (id, employee_id, leave_type_id, start_date, end_date, days, 
  reason, status, approved_by, approved_at)
```

---

### 4.6 Payslip & Reporting

**Payslip:**
- Professional SA payslip format (BCEA compliant — employer details, employee details, period, all components itemised, PAYE/UIF/SDL, net pay)
- Email payslips to employees (bulk + individual)
- Payslip verification: employee can confirm receipt via portal link
- PDF download per payslip

**Reports:**
- Payroll summary by period (all employees, all components)
- PAYE schedule (monthly, annual)
- UIF declaration (UI-19 format)
- SDL schedule
- Leave balance report
- Cost centre / department payroll allocation
- Payroll audit trail

---

## 5. SA Compliance Specifics

| Requirement | Detail |
|-------------|--------|
| Tax year | March to February |
| PAYE tables | Annual SARS tables (updated each year) |
| Tax rebates | Primary (all), secondary (age 65+), tertiary (age 75+) |
| Medical tax credits | Per month per beneficiary |
| UIF ceiling | Capped at R17,712/month (2024 — must update annually) |
| SDL rate | 1% of leviable amount |
| ETI | Youth wage subsidy, SARS formula, Phase 1/2 year amounts |
| NCA | No payroll implications |
| POPIA | Employee PII encrypted at rest, field-level audit, right-to-erasure workflow |

---

## 6. Implementation Phases

### Phase 1 — Payroll Engine (5 weeks)
- Employee master with SA fields + source codes
- Component model with SARS source code lookup
- PAYE/UIF/SDL/ETI calculation engine
- Payroll run with override support
- Payslip generation (extend existing PDF builders)
- Continuous validation engine with readiness checks

### Phase 2 — EMP201 & Reporting (3 weeks)
- EMP201 generation and export
- Monthly payroll reports
- Leave management (full BCEA accrual)
- Payslip email delivery
- UIF declaration export

### Phase 3 — IRP5 / EMP501 (4 weeks)
- IRP5 certificate generation from run history
- IRP5 readiness dashboard
- EMP501 reconciliation engine
- e@syFile export (ZIP format)
- Source code validation engine
- Year-end guided workflow

### Phase 4 — Hardening (2 weeks)
- Tax table updates (annual SARS tables)
- Performance: large payrolls (500+ employees)
- Sentry error tracking on all payroll calculations
- Audit trail on all payroll changes

**Total estimate: ~14 weeks with 1 backend + 1 fullstack engineer**

---

## 7. Competitive Positioning

| Feature | Sage VIP | SimplePay | PaySpace | ISaFlow Target |
|---------|----------|-----------|---------|----------------|
| SA compliance depth | ✅ Deep | ✅ Good | ✅ Deep | ✅ Deep |
| Real-time validation | ❌ No | ❌ No | ❌ No | ✅ Yes |
| Plain-language errors | ❌ Technical codes | ✅ Better | ❌ Technical | ✅ Best |
| IRP5 readiness dashboard | ❌ No | ❌ No | ❌ No | ✅ Yes |
| ETI engine | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| Integrated with GL/AR | ❌ Export only | ❌ Export only | ❌ Export only | ✅ Native |
| UX quality | ❌ Outdated | ✅ Good | ✅ Good | ✅ Best |
| Price | Expensive | Moderate | Expensive | Competitive |

---

## 8. Success Criteria

- Zero year-end IRP5 surprises: any error surfaced by the readiness dashboard is resolvable without payroll reconstruction
- EMP501 reconciles to zero on first attempt in 95%+ of submissions
- A payroll administrator can complete a full month-end run in < 30 minutes
- No payslip that reaches an employee has a SARS source code error

---

## 9. Open Questions

1. Direct SARS API integration (real-time e@syFile submission) — when to prioritise?
2. Third-party HR system integration (leave, headcount from BambooHR, etc.) — Phase 3?
3. Should ETI employer-side application be automated or manually reviewed?
4. Multi-rate / split-period employees (started mid-month) — handle in Phase 1 or Phase 2?
