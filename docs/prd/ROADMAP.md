# ISaFlow Product Roadmap
## From App Specs Review — April 2026

> Source: `/home/hein/Downloads/App Specs.zip` — reviewed 2026-04-19

---

## Module Status Overview

### Already Shipped (production-ready)

| Module | Status | Notes |
|--------|--------|-------|
| General Ledger | ✅ Shipped | Full double-entry, journal entries, fiscal periods, year-end |
| Accounts Receivable | ✅ Shipped | Customers, invoices, payments, credit notes, statements, aging |
| Accounts Payable | ✅ Shipped | Suppliers, invoices, payments, batch payments, aging |
| Banking | ✅ Shipped | Bank feeds, reconciliation, rules, multi-doc match |
| Inventory | ✅ Shipped | Items, stock levels, adjustments, pricing |
| Fixed Assets (basic) | ⚠️ Partial | Asset register, basic depreciation — missing dual policy/tax, deferred tax, AFS note |
| Annual Financial Statements (AFS) | ✅ Shipped | Full IFRS AFS engine, notes, portal, Signum signing |
| Reports | ✅ Shipped | Income statement, balance sheet, cash flow, management packs |
| Tax / SARS | ✅ Shipped | VAT201, EMP201 basic, DRC VAT, compliance calendar |
| Multi-company / Consolidation | ✅ Shipped | Group reporting, eliminations, intercompany |
| Bank Reconciliation | ✅ Shipped | Full reconciliation workflow with rules |
| Migration / Sage Import | ✅ Shipped | Sage auto-import, 15 endpoints |
| Document Capture | ✅ Shipped | OCR, AI invoice pipeline, document storage |
| Admin Platform | ✅ Shipped | admin.isaflow.co.za — companies, billing, plans |
| Auth (GoTrue/Supabase) | ✅ Shipped | Phase 1+2 complete, RLS live |

### Partial / Needs Major Work

| Module | Current State | Gap |
|--------|--------------|-----|
| Time Tracking | Basic form exists | Needs full practice management upgrade |
| Payroll | Skeleton pages, PDF builders | Needs full SA compliance engine |
| Projects | Basic service exists | Needs integration with Practice Management |

### New / Major Enhancements (from spec review)

| Module | PRD | Priority | Estimate |
|--------|-----|----------|----------|
| Practice Management Suite | [PRD-01](PRD-01-practice-management.md) | P0 | 13 weeks |
| Payroll SA Compliance Engine | [PRD-02](PRD-02-payroll-sa-compliance.md) | P1 | 14 weeks |
| Fixed Asset Register — Enhanced FAR | [PRD-04](PRD-04-fixed-asset-register.md) | P1 | 9 weeks |
| Loan Amortisation Module | [PRD-03](PRD-03-loan-amortisation.md) | P2 | 14 weeks |

---

## Roadmap Options

Three roadmap options depending on business priorities:

---

### Option A: Practice-First (Recommended for accounting firm users)

**Rationale:** The Practice Management Suite directly addresses the daily pain of the accounting firm team. It's a retention and adoption driver — firms that use ISaFlow for their own practice operations become deeply embedded. Payroll follows because it's closely linked to practice billing.

```
Q2 2026 (now → Aug)
  └── PRD-01: Practice Management Suite
        Phase 1: Foundation (4w) — CRM, job codes, rate profiles
        Phase 2: Time Entry & WIP (4w) — enhanced time, billing pipeline
        Phase 3: Jobs & Workflow (3w) — job/task engine
        Phase 4: Reports (2w) — utilisation, WIP aging

Q3 2026 (Sep → Nov)
  └── PRD-02: Payroll SA Compliance
        Phase 1: Payroll Engine (5w) — components, PAYE/UIF/SDL/ETI, continuous validation
        Phase 2: EMP201 & Reporting (3w)
        Phase 3: IRP5 / EMP501 (4w)
        Phase 4: Hardening (2w)

Q4 2026 (Dec → Feb 2027)
  └── PRD-03: Loan Amortisation Module
        Phase 0: Engine (2w) — pure TS function, golden file test
        Phase 1: Data & API (3w)
        Phase 2: Frontend (4w)
        Phase 3: GL Integration (3w)
        Phase 4: IFRS 9 / NCA (2w)
```

---

### Option B: Payroll-First (Recommended if tax season timing matters)

**Rationale:** IRP5 year-end is February. If you want payroll production-ready for the Feb 2027 submission cycle, start it now and have it live by Q3 2026.

```
Q2 2026 (now → Aug)
  └── PRD-02: Payroll SA Compliance (Phases 1-3 = 12w)
        Focus: get IRP5/EMP501 engine live before year-end rush

Q3 2026 (Sep → Nov)
  └── PRD-01: Practice Management Suite (Phases 1-3 = 11w)

Q4 2026 (Dec → Feb 2027)
  └── PRD-03: Loan Amortisation (Phases 0-3 = 12w)
  └── PRD-01: Practice Reports (Phase 4 = 2w)
```

---

### Option C: Parallel Streams (Requires 2 engineering streams)

**Rationale:** If team has capacity for two parallel streams, ship Practice Management and Payroll simultaneously.

```
Q2 2026:
  Stream A → PRD-01 Phases 1-2 (CRM + Time Entry)
  Stream B → PRD-02 Phases 1-2 (Payroll Engine + EMP201)

Q3 2026:
  Stream A → PRD-01 Phases 3-4 (Jobs + Reports)
  Stream B → PRD-02 Phases 3-4 (IRP5/EMP501 + Hardening)

Q4 2026:
  Stream A → PRD-03 (Loan Amortisation)
```

---

## PRD Tracking

> Last updated: 2026-04-20

| PRD | Title | Phase | Status | Notes |
|-----|-------|-------|--------|-------|
| PRD-01 | Practice Management Suite | 1 — Foundation (CRM, rate profiles, job codes) | ✅ Shipped | practice_clients, staff rate profiles, job categories live |
| PRD-01 | Practice Management Suite | 2 — Time Entry & WIP | ✅ Shipped | Day/week time entry, WIP workflow, billing pipeline |
| PRD-01 | Practice Management Suite | 3 — Jobs & Workflow | ✅ Shipped | Jobs, tasks, Kanban DnD, practice staff directory |
| PRD-01 | Practice Management Suite | 4 — Reports | ✅ Shipped | Utilisation, WIP aging, profitability, pipeline, compliance, service mix |
| PRD-01 | Practice Management Suite | 5A — Extras | ✅ Shipped | Client rate overrides (mig 395), bulk CSV export + import for clients |
| PRD-02 | Payroll SA Compliance | 1 — Payroll Engine | ✅ Shipped | Employee master, payslip engine, PAYE/UIF/SDL/ETI, runs |
| PRD-02 | Payroll SA Compliance | 2 — EMP201 & Reporting | ✅ Shipped | EMP201 generation, payroll components config |
| PRD-02 | Payroll SA Compliance | 3 — IRP5 / EMP501 | 🔲 Not Started | No IRP5 dashboard or EMP501 page |
| PRD-02 | Payroll SA Compliance | 4 — Leave Management | 🔲 Not Started | No leave module; BCEA accruals not implemented |
| PRD-03 | Loan Amortisation | 0 — Engine | ✅ Shipped | Pure TS amortisation engine, golden-file tests |
| PRD-03 | Loan Amortisation | 1 — Data & API | ✅ Shipped | Loans, schedules, rate curves API |
| PRD-03 | Loan Amortisation | 2 — Frontend | ✅ Shipped | Portfolio, detail, new loan, rate curves pages |
| PRD-03 | Loan Amortisation | 3 — GL Integration | ✅ Shipped | GL auto-posting, journal entries |
| PRD-03 | Loan Amortisation | 4 — Period Close / IFRS 9 | ⚠️ Partial | Schedule API exists; no period close UI page |
| PRD-04 | Fixed Asset Register | 1 — Data Model & Dual Engine | ✅ Shipped | IAS 16 + SARS tax depreciation, migration 360-362 |
| PRD-04 | Fixed Asset Register | 2 — Disposals & Journals | ✅ Shipped | Asset disposals with recoupment, GL posting |
| PRD-04 | Fixed Asset Register | 3 — AFS Integration | ✅ Shipped | PPE movements note auto-populated in AFS |
| PRD-04 | Fixed Asset Register | 4 — UI & Reporting | ✅ Shipped | Asset register, categories, depreciation schedule pages |

---

## Module Map — Existing vs New

```
ISaFlow Suite
├── CORE ACCOUNTING (✅ Shipped)
│   ├── General Ledger
│   ├── Accounts Receivable (Sales)
│   ├── Accounts Payable (Purchases)
│   ├── Banking & Reconciliation
│   ├── Inventory
│   ├── Fixed Assets
│   ├── Multi-company / Consolidation
│   └── Migration & Sage Import
│
├── COMPLIANCE & REPORTING (✅ Shipped)
│   ├── Annual Financial Statements (AFS)
│   ├── Reports (IS, BS, CF, management packs)
│   ├── Tax / SARS (VAT201, EMP201 basic)
│   └── Document Capture / OCR
│
├── PRACTICE MANAGEMENT (🔲 PRD-01 — NEW)
│   ├── Practice CRM (clients, groups, contacts)
│   ├── Job Category & Work Item Registry
│   ├── Enhanced Time Entry (day view, WIP workflow)
│   ├── Staff Rate Management (effective dates, overrides)
│   ├── WIP & Billing Pipeline
│   ├── Job & Task Workflow Engine
│   └── Management Dashboards (utilisation, WIP aging, profitability)
│
├── PAYROLL (⚠️ Partial → PRD-02 — MAJOR ENHANCEMENT)
│   ├── Employee Master (SA fields, source codes)
│   ├── Payroll Component Model
│   ├── PAYE / UIF / SDL / ETI Calculation Engine
│   ├── Continuous SARS Validation (real-time)
│   ├── EMP201 Generation & Export
│   ├── IRP5 Readiness Dashboard
│   ├── EMP501 Reconciliation Engine
│   ├── Leave Management (BCEA-compliant)
│   └── Year-End Guided Workflow
│
├── FIXED ASSET REGISTER (⚠️ PRD-04 — MAJOR ENHANCEMENT)
│   ├── Dual policy (IAS 16) + tax (SARS wear & tear) depreciation
│   ├── Deferred tax per asset class
│   ├── Full SARS wear & tear table (280+ codes)
│   ├── AFS PPE movements note (auto-populated)
│   ├── As-at-date historical register
│   ├── Capitalization threshold (< R5k → expense)
│   ├── Production code / cost-centre allocation
│   ├── Disposal with recoupment detection
│   └── FAR-format Excel export
│
└── LOAN AMORTISATION (🔲 PRD-03 — NEW)
    ├── Amortisation Engine (pure TS, SA Prime rates)
    ├── Rate Curve Management
    ├── Loan Portfolio Dashboard
    ├── Schedule Grid with What-If Preview
    ├── GL Auto-Posting (current/non-current split)
    ├── Period Close Workflow
    └── NCA / IFRS 9 Compliance
```

---

## Open Questions (To Resolve Before Planning)

1. **Roadmap option choice:** Which option — A (Practice-first), B (Payroll-first), or C (Parallel)?
2. **Practice CRM vs Customers:** Are practice clients a separate entity or an extension of AR customers?
3. **Payroll vs Time billing:** Should practice billing generate AR invoices or a separate invoice type?
4. **Loan amortisation scope:** IsaFlow module (recommended) or separate standalone product?
5. **SA Prime rate curve:** System-maintained (ISaFlow ops updates it monthly) or per-tenant?
6. **Practice Management plan tier:** Included in all plans or premium/add-on?
7. **Payroll plan tier:** Standalone payroll product or bundled?
8. **Engineering capacity:** How many engineers available for new modules?

---

## Glossary

| Term | Meaning |
|------|---------|
| WIP | Work in Progress — approved but not-yet-billed time |
| EMP201 | Monthly PAYE/UIF/SDL declaration to SARS |
| EMP501 | Annual reconciliation of EMP201 submissions to IRP5 totals |
| IRP5 | Employee tax certificate issued annually |
| ETI | Employment Tax Incentive — youth wage subsidy reducing PAYE |
| SDL | Skills Development Levy — 1% of leviable payroll |
| UIF | Unemployment Insurance Fund |
| NCA | National Credit Act — in-duplum rule limits total interest |
| ECL | Expected Credit Loss — IFRS 9 impairment model |
| ST Liability | Short-term liability — current portion of long-term debt |
| SA Prime | South African Reserve Bank prime lending rate |
