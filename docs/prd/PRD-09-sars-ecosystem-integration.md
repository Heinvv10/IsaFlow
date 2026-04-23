# PRD-09: SARS Ecosystem Integration

**Status:** `DRAFT`
**Priority:** P0 for SA market expansion — eFiling + e@syFile are where every SA business ultimately lands. Today IsaFlow ends at "here's your CSV / PDF, go upload it manually". This PRD closes the loop: submissions happen from inside IsaFlow, statuses come back, balances reconcile, and the tax year rolls over without a single manual SARS portal visit.
**Source specs:** SARS eFiling API docs (v4), e@syFile BRS v25.2, VAT201 / EMP201 / EMP501 specs, Income Tax Act §1, TAA §§25–26, existing PRD-02 Phase 3 (IRP5 / EMP501 MVP).
**Related modules:** Tax (`vat_returns`, `emp201_returns`, `emp501_reconciliations`), Payroll (PRD-02), AFS (PRD-05 Phase 12), AR (PRD-06).

---

## 1. Problem Statement

SA accounting ends at SARS. Every module we've shipped produces something that eventually has to land in eFiling or e@syFile. Today the handoff is:

| Module | What we produce | How it gets to SARS |
|---|---|---|
| VAT | VAT201 CSV | Bookkeeper logs into eFiling, pastes |
| PAYE / UIF / SDL | EMP201 CSV | Same |
| Annual payroll recon | EMP501 XML + IRP5 batch | e@syFile upload, then eFiling |
| Income tax | ITR14 data (manual) | Tax practitioner enters on eFiling |
| Provisional tax | IRP6 estimates | Manual calc + eFiling |
| SARS account balance | Nothing | Bookkeeper checks SARS statement monthly |

Six manual portal visits per month, per client, per module. One competent bookkeeping firm managing 40 clients spends ~60 hours/month just on SARS logistics. None of it is judgment work — it's typing the same numbers twice.

What nobody else in SA does (Xero, Sage, QuickBooks none of them):

| Only available if you integrate directly with SARS | Why IsaFlow can |
|---|---|
| One-click submit VAT201 / EMP201 / EMP501 from the close workflow | Agent (PRD-08) can trigger it; ledger data is already there |
| Reconcile the SARS statement balance against our own tax-liability accounts nightly | Own both sides of the reconciliation |
| IRP6 provisional-tax estimates driven by live P&L forecast (not prior-year ×2) | Own the ledger and cashflow forecast |
| Auto-apply tax directives without manual lookup | Already have employee data + payroll engine |
| Tax-year rollover including new SARS tables, depreciation rates, medical aid credits, etc. | Own calendar scope |
| Status dashboard showing "VAT201 for Feb assessed, penalty R0" per client across the firm | Cross-tenant query is native |

Pricing consequence: this is what makes tax practitioners pay for IsaFlow instead of only accountants. Tax practice licences at ~R1,500/month/practitioner become unlockable.

---

## 2. What Already Exists

| Component | Status | Path |
|---|---|---|
| VAT201 generation | ✅ Shipped | `vatReturnService.ts` |
| EMP201 generation | ✅ Shipped (PRD-02) | `emp201Service.ts` |
| IRP5 CSV export | ✅ Shipped (PRD-02 Phase 3) | `irp5ExportService.ts` |
| EMP501 reconciliation | ✅ Shipped | `emp501ReconciliationService.ts` |
| Tax directive lookup UI | ⚠️ Partial | manual entry; no API call |
| e@syFile import of IRP5 batches | ✅ Shipped (MVP) | with gaps: ETI codes, directives, foreign nationals, fringe benefits |
| SARS VAT Vendor Search API (read-only) | ✅ Shipped (PRD-05) | `sarsVatVendorService.ts` |
| eFiling submission | ❌ Missing | — |
| eFiling status polling | ❌ Missing | — |
| SARS account balance reconciliation | ❌ Missing | — |
| IRP6 provisional tax calculation | ❌ Missing | — |
| Tax-year rollover automation | ❌ Missing | — |
| SARS 2FA / OTP handling | ❌ Missing | — |
| Practitioner-firm SARS profile linking | ❌ Missing | — |

---

## 3. Strategic Bet

> **The module that closes the loop on SARS wins the SA market outright. Every incumbent is structurally blocked because they don't own the ledger that produces the return AND the filing flow that submits it.**

Three structural points:

- **Lock-in through workflow.** Once a firm routes 40 clients' VAT through IsaFlow eFiling, moving off costs a quarter of compliance work.
- **Telemetry advantage.** Cross-tenant view of SARS verification rates, penalty trends, audit flags → uniquely actionable for tax practitioners.
- **Trust via authorisation.** SARS's API uses delegated authority. Owning that delegation means we're *inside* the compliance perimeter, not merely producing files for someone else to upload.

This is a regulated integration — SARS has strict onboarding, PKI requirements, and limits on non-practitioner access. Phases are conservative with the ramp-up.

---

## 4. Data Model Changes

### 4.1 Practitioner & Tenant Linking

```sql
CREATE TABLE sars_practitioner_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,  -- the firm's tenant
  practitioner_number text NOT NULL,                                    -- PR-…
  trading_name text,
  firm_tax_ref text,
  registered_as text[] NOT NULL DEFAULT '{}',                            -- ['vat','paye','income_tax']
  efiling_username_enc text,                                             -- AES-GCM
  efiling_password_enc text,                                             -- same; rotated per 30d
  pki_cert_path text,                                                    -- storage pointer to SARS-issued cert
  pki_cert_sha256 text,
  last_auth_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','locked','suspended','expired')),
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE sars_client_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_profile_id uuid NOT NULL REFERENCES sars_practitioner_profiles(id) ON DELETE CASCADE,
  client_company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_tax_ref text NOT NULL,
  tax_types text[] NOT NULL,                                             -- ['vat201','emp201','emp501','itr14','irp6']
  delegation_signed_at timestamptz,
  delegation_ref text,                                                   -- SARS reference for the POA
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','revoked','expired')),
  UNIQUE (practitioner_profile_id, client_company_id, client_tax_ref)
);
```

### 4.2 Submissions Table

```sql
CREATE TABLE sars_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  delegation_id uuid REFERENCES sars_client_delegations(id),
  return_type text NOT NULL
    CHECK (return_type IN ('vat201','emp201','emp501','irp6','itr14','irp5_batch')),
  period_start date,
  period_end date,
  tax_year int,                                                          -- for itr14/irp6
  -- What we sent
  payload_ref text NOT NULL,                                             -- points at vat_returns.id etc
  payload_sha256 text NOT NULL,
  -- Submission state
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','accepted','rejected','assessed','paid','penalty_raised')),
  submitted_at timestamptz,
  sars_reference text,                                                   -- the case number SARS returns
  sars_response jsonb,
  -- Outcome
  assessed_amount numeric(18,2),
  penalty_amount numeric(18,2),
  interest_amount numeric(18,2),
  payment_due_date date,
  -- Audit trail
  submitted_by text NOT NULL,                                            -- 'user:…' | 'agent:…'
  last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sars_subs_company
  ON sars_submissions(company_id, return_type, period_end DESC);
CREATE INDEX idx_sars_subs_polling
  ON sars_submissions(last_polled_at)
  WHERE status IN ('submitted','assessed');
```

### 4.3 SARS Account Balance Reconciliation

```sql
CREATE TABLE sars_account_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tax_type text NOT NULL,
  statement_date date NOT NULL,
  -- SARS side
  sars_opening_balance numeric(18,2),
  sars_closing_balance numeric(18,2),
  sars_transactions jsonb NOT NULL,                                      -- parsed statement lines
  -- Our side
  gl_account_balance numeric(18,2),
  variance numeric(18,2),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','reconciled','variance_open','disputed')),
  source_document_id uuid REFERENCES captured_documents(id),
  created_at timestamptz NOT NULL DEFAULT NOW()
);
```

### 4.4 Tax Year Rollover State

```sql
CREATE TABLE sars_tax_year_parameters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year int NOT NULL,
  country_code text NOT NULL DEFAULT 'ZA',
  -- Rate tables (snapshotted from SARS)
  paye_tax_tables jsonb NOT NULL,
  vat_rate numeric(5,4) NOT NULL,
  uif_rate numeric(5,4),
  uif_ceiling numeric(18,2),
  sdl_rate numeric(5,4),
  medical_aid_tax_credit jsonb,                                          -- primary + dependents
  prescribed_km_rate numeric(8,4),
  -- Thresholds
  provisional_tax_threshold numeric(18,2),
  retirement_contribution_cap numeric(18,2),
  -- Effective dates
  effective_from date NOT NULL,
  effective_to date,
  published_at timestamptz,
  source_url text,
  UNIQUE (tax_year, country_code)
);

-- Bootstrap: seed 2024, 2025, 2026 tax years with their respective rates.
```

### 4.5 Fringe Benefits (closing PRD-02 gap)

```sql
CREATE TABLE payroll_fringe_benefits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  benefit_type text NOT NULL,                                            -- 'company_car' | 'housing' | 'loan' | 'medical' | ...
  sars_source_code text NOT NULL,                                        -- maps to IRP5 codes 3801..3816
  tax_year int NOT NULL,
  monthly_value numeric(18,2) NOT NULL,
  taxable_value numeric(18,2) NOT NULL,
  description text,
  start_date date NOT NULL,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE payroll_allowances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  allowance_type text NOT NULL,                                          -- 'travel' | 'subsistence' | 'cellphone'
  sars_source_code text NOT NULL,                                        -- 3701..3718
  tax_year int NOT NULL,
  monthly_value numeric(18,2) NOT NULL,
  taxable_percentage numeric(5,2) NOT NULL,                              -- e.g. 80% taxable on travel
  description text,
  start_date date NOT NULL,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE payroll_lump_sums (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  lump_sum_type text NOT NULL,                                           -- 'retirement' | 'resignation' | 'severance'
  sars_source_code text NOT NULL,                                        -- 3901..3917
  tax_directive_id uuid REFERENCES tax_directives(id),                   -- required for lump sums
  amount numeric(18,2) NOT NULL,
  paid_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
```

---

## 5. Services & APIs

### 5.1 New services (`src/modules/accounting/services/sars/`)

| Service | Responsibility |
|---|---|
| `efilingAuthService.ts` | Practitioner login, 2FA/OTP handling, PKI cert presentation, session caching |
| `efilingSubmissionService.ts` | Wraps the SARS submission endpoint for each return type; idempotent retries |
| `efilingStatusPollerService.ts` | Polls open submissions for assessment / payment state; writes status transitions |
| `sarsStatementService.ts` | Parses SARS account statements (PDF + CSV), stores in `sars_account_statements` |
| `sarsReconciliationService.ts` | Compares SARS balance to our GL; flags variances; drafts clearing journals |
| `taxDirectiveService.ts` (extend) | Real API call to SARS directive endpoint; caches results |
| `irp6CalculatorService.ts` | Provisional tax estimate from live P&L + prior-year assessment |
| `taxYearRolloverService.ts` | Pulls new parameters from SARS, updates `sars_tax_year_parameters`, validates current-year rates |
| `fringeBenefitService.ts` + `allowanceService.ts` + `lumpSumService.ts` | CRUD + payroll-run integration — closes PRD-02 gaps |
| `easyfileBridgeService.ts` | Enhanced IRP5 batch generator including ETI codes + directives + fringes (closes BRS v25.2 gap) |

### 5.2 New endpoints

```
# Practitioner setup
GET    /api/accounting/sars/practitioner-profile
POST   /api/accounting/sars/practitioner-profile
POST   /api/accounting/sars/practitioner-profile/verify-otp
GET    /api/accounting/sars/delegations
POST   /api/accounting/sars/delegations
POST   /api/accounting/sars/delegations/[id]/revoke

# Submission
GET    /api/accounting/sars/submissions                  (filter by return_type, status)
POST   /api/accounting/sars/submissions                  body: { returnType, period, dryRun? }
GET    /api/accounting/sars/submissions/[id]
POST   /api/accounting/sars/submissions/[id]/resubmit    (rejection recovery)
POST   /api/accounting/sars/submissions/[id]/poll        (manual status refresh)

# Statement recon
POST   /api/accounting/sars/statements/import            (PDF + CSV upload)
GET    /api/accounting/sars/statements                   (filter by tax_type)
POST   /api/accounting/sars/statements/[id]/reconcile    (draft clearing journals)

# Tax year & parameters
GET    /api/accounting/sars/tax-years                    list + effective dates
POST   /api/accounting/sars/tax-years/rollover           body: { year }
GET    /api/accounting/sars/tax-years/[year]/parameters

# IRP6
POST   /api/accounting/sars/irp6/estimate                body: { year, periodOfReturn: 1|2|3 }
GET    /api/accounting/sars/irp6/[id]

# Tax directives
POST   /api/accounting/sars/directives/lookup            body: { taxRef, type }

# Fringe benefits / allowances / lump sums
CRUD    /api/accounting/payroll/fringe-benefits
CRUD    /api/accounting/payroll/allowances
CRUD    /api/accounting/payroll/lump-sums

# Cross-tenant dashboards (practitioner firms)
GET    /api/accounting/sars/practice-overview            (clients × return types × status grid)

# Cron
POST   /api/cron/sars-status-poll                        X-Cron-Secret; every 1h
POST   /api/cron/sars-statement-reconcile                X-Cron-Secret; daily
```

### 5.3 Modifications to existing services

- `vatReturnService.generate` — on generate, optionally create a `sars_submissions` draft row linked to `vat_returns`.
- `payrollRunService` — on post, include fringe-benefit + allowance + lump-sum values in each payslip's taxable income.
- PRD-08 agent — adds `stepRunners/submitVat.ts` for fully-autonomous VAT filing (opt-in, paid tier).

---

## 6. UI Pages

### 6.1 New

| Route | Purpose |
|---|---|
| `/accounting/sars/profile` | Practitioner setup wizard, PKI cert upload, 2FA config |
| `/accounting/sars/delegations` | Client POA list per tax type |
| `/accounting/sars/submissions` | All submissions, cross-client filter, status chips |
| `/accounting/sars/submissions/[id]` | Detail — payload, SARS response, resubmit, statement link |
| `/accounting/sars/statements` | Imported statements, variance flag, reconciliation drafts |
| `/accounting/sars/tax-years` | Current year's parameters, rollover preview |
| `/accounting/sars/irp6` | Provisional tax estimates with scenario toggles |
| `/accounting/payroll/fringe-benefits` | FBT register per employee |
| `/accounting/payroll/allowances` | Allowances register |
| `/accounting/payroll/lump-sums` | Lump-sum register with directive links |
| `/accounting/sars/practice-overview` | Firm-wide client × return grid |

### 6.2 Modifications

- **Tax module home:** action buttons "Submit VAT201", "Submit EMP201", etc. (if SARS profile active).
- **IRP5 / EMP501 export:** "Submit to SARS" button alongside "Download CSV".
- **Period-lock UI:** blocks lock if any critical SARS submission for that period is still in draft.
- **Dashboard:** widget "SARS submissions — 3 pending poll, 0 rejected".

---

## 7. Phased Delivery

### Phase 1 — Close e@syFile Gaps (2 weeks) `P0`

- Migrations for `payroll_fringe_benefits`, `payroll_allowances`, `payroll_lump_sums`
- Services + CRUD + UI pages
- `easyfileBridgeService` — IRP5 batch generator with ETI codes + directives + fringes + foreign-national fields
- **Exit criteria:** IRP5 batch for a 20-employee demo company imports cleanly into e@syFile with all SARS source codes populated; BRS v25.2 gaps closed.

### Phase 2 — Practitioner Profile + Delegations (2 weeks) `P0`

- Migrations + service + UI wizard
- eFiling OTP + PKI wiring (SARS pilot onboarding needed — external dep)
- Credentials encrypted via `src/lib/encryption.ts`
- **Exit criteria:** a tax practitioner authenticates; delegations listed from a test SARS sandbox account.

### Phase 3 — VAT201 + EMP201 Submission (2 weeks) `P0`

- `efilingSubmissionService` for both return types
- Dry-run mode (validate without submit) for confidence
- Submission history + resubmit flow
- **Exit criteria:** generate + submit VAT201 for a sandbox company; receive SARS reference; status transitions correctly.

### Phase 4 — Status Polling + Assessment Capture (1 week) `P1`

- Cron poller every hour for open submissions
- Assessment payload parsing (penalty, interest, due date)
- Notifications on rejection
- **Exit criteria:** submitted return reaches `assessed` state within 48h of SARS assessment; penalty/interest visible in UI.

### Phase 5 — SARS Statement Reconciliation (2 weeks) `P1`

- PDF/CSV import via existing VLM pipeline (statement template prompt)
- Daily cron: diff SARS balance vs GL liability account
- Draft clearing journal for variances
- **Exit criteria:** upload 3 months of SARS statements; 95% of transactions reconcile to posted JEs; variances surface as escalations.

### Phase 6 — EMP501 + IRP5 Submission (2 weeks) `P1`

- Extends Phase 3 to annual recon return
- Batch size + chunking for large employers
- e@syFile + eFiling dual-path (depends on SARS recommended channel for the year)
- **Exit criteria:** EMP501 for 50-employee demo company submits; all IRP5s accepted.

### Phase 7 — IRP6 Provisional Tax (2 weeks) `P1`

- Live P&L forecast × prior-year assessment blend
- Scenario toggles: conservative / expected / aggressive
- Integration with cashflow-forecast module
- Submission via Phase 3 infra
- **Exit criteria:** IRP6 for August + February periods; estimate within 5% of actual assessment.

### Phase 8 — Tax-Year Rollover (2 weeks) `P2`

- Fetch new SARS parameters from their publication feed
- Validate current-year rates in use; flag drift
- Rollover wizard: preview changes, apply on cutover date
- **Exit criteria:** Feb 2027 rollover test — new PAYE tables applied, all payroll runs in March use new rates.

### Phase 9 — Practice Overview + Automation (1 week) `P2`

- Cross-tenant grid for practitioner firms
- Agent integration (PRD-08) — add `submitVat` / `submitEmp` step runners
- Firm-wide "submit all due" action
- **Exit criteria:** 20-client practice closes all VAT201s in one click; agent auto-submits for subscribed clients.

### Phase 10 — ITR14 (Company Income Tax) (3 weeks) `P2`

- Pre-fill ITR14 from AFS + tax pack + deferred tax calc
- SARS submission
- Assessment capture
- **Exit criteria:** ITR14 for demo company submits; matched with AFS numbers; assessment captured within 60 days.

**Total estimated effort:** 18–20 engineer-weeks; P0 (Phase 1-3) ships in 6 weeks and unlocks the VAT / PAYE filing loop.

---

## 8. Success Metrics

| Metric | Baseline | Target (12 weeks post P0) |
|---|---|---|
| % VAT201s submitted via IsaFlow (enabled tenants) | 0% | ≥80% |
| % EMP201s submitted via IsaFlow | 0% | ≥80% |
| Manual eFiling logins per client per month | ~6 | ≤1 |
| Rejection rate (submissions requiring resubmit) | n/a | ≤5% |
| SARS balance reconciliation coverage | 0% | ≥95% (closing variances cleared) |
| Practitioners onboarded | 0 | ≥10 |
| Time from period close → VAT submitted (median) | 7 days | ≤24 hours |

---

## 9. Risks & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SARS API changes break submission format | High | High | Version-pin payloads; daily smoke submission on sandbox; fast patch lane |
| PKI cert expiry mid-submission window | Med | High | Proactive 30-day renewal reminder; fallback to practitioner-assisted manual submission |
| eFiling rate-limit during peak (Feb VAT / Sep EMP501) | High | Med | Exponential backoff; queue + resume; submit outside business hours for non-urgent |
| Authorisation revocation without notice | Med | High | Poll delegation status daily; block submission and alert on revoke |
| Penalty raised for late submission due to agent misfire | Low | High | All agent-triggered submissions carry tenant-approved whitelist; above-threshold sits in escalation queue |
| Statement-parsing errors misclassify | Med | Med | Minimum 90% confidence gate; below-threshold opens an exception item |
| POPIA breach — SARS creds or directive data leak | Low | Very High | Encrypted at rest; rotated per 30 days; access-logged; practitioner-level audit trail |
| Dependency on SARS pilot enrolment timeline | High | High (blocks Phase 2+) | Continue Phase 1 (e@syFile gaps) in parallel — ships value without API dep |

---

## 10. Open Questions

1. **Own PKI keystore or third-party (HSM service)?** Recommendation: cloud HSM (AWS KMS or IBM Cloud HSM) — auditable, FIPS 140-2, same provider as Supabase.
2. **Dry-run default** — do all first submissions go through dry-run? Recommendation: yes, warn and require explicit click-to-real-submit for first 3 returns per client.
3. **Agent autonomy for submissions** — opt-in per return type, or one blanket toggle? Recommendation: per return type + per client — VAT aggressive, EMP501 manual-always.
4. **What about RSA resident non-RSA tax returns?** (DWT, STT, etc.) Recommendation: scope limited to VAT / PAYE / ITR14 / IRP6 for MVP.
5. **Provisional-tax estimation input** — rolling 12-month P&L or calendar-to-date forecast? Recommendation: hybrid, with scenario toggle.

---

## 11. Out of Scope (for this PRD)

- **Customs / excise / DWT / STT** — niche; later PRD.
- **Personal income tax (ITR12)** — individual returns, not company scope.
- **SARS audits / disputes / objections** — tracking only, not case management.
- **Payroll garnishee / third-party payments via SARS** — deferred.
- **Non-SA tax regimes** — Namibia, Botswana explored in a separate PRD.

---

## 12. Dependencies

- SARS eFiling API v4 sandbox access (onboarding 4-8 weeks)
- SARS PKI certificate enrolment (external, ~2 weeks)
- e@syFile BRS v25.2 spec (public)
- AWS KMS / Cloud HSM contract
- PRD-02 Phase 3 (payroll recon, shipped with gaps)
- PRD-08 agent (for autonomous submission step runner — Phase 9)
- `captured_documents` + evidence graph (shipped)
- Cashflow-forecast module for IRP6 (shipped)
