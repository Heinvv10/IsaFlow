# PRD-01: Practice Management Suite

**Status:** `PLANNED`  
**Priority:** P0 — Core differentiator, drives daily accounting firm usage  
**Source specs:** `ISAFlow_Developer_Spec_Expanded.docx`, `Technical_Specification_Clean.docx`, `Timekeeping.docx`, `ISAFlow Suite.docx`  
**Related modules:** Time Tracking (partial, `pages/accounting/time-tracking`, `pages/accounting/timesheets`), Projects (`pages/api/accounting/projects.ts`), Sales Reps

---

## 1. Problem Statement

ISAFlow is used by accounting firms who currently run their entire practice operations out of per-staff-member Excel workbooks. Each workbook handles: time entries, client lists, job codes, billing rates, task tracking, and monthly reports. This model is:

- Not scalable — data is siloed per person per month
- Inaccurate — time is reconstructed from memory after the fact
- Revenue-leaking — billable hours are missed, rates are manually looked up
- Invisible — management cannot see cross-staff utilisation or WIP
- Compliance-fragile — no audit trail, no approval workflow

The existing IsaFlow time tracking (`time-tracking`, `timesheets`) is a basic form. It lacks the workflow, billing pipeline, CRM, and management reporting needed to replace the Excel environment.

---

## 2. Strategic Objective

Transform ISaFlow from an accounting-only tool into a **work-driven accounting operating system** for accounting practices. The shift:

> **Old model:** Track time → Build invoices → Manage work  
> **New model:** Manage work → Capture activity → Generate billing automatically

---

## 3. Modules in Scope

### 3.1 Practice CRM (Client Management)

**What it is:** An authoritative client registry for the *practice* side — distinct from accounting `customers`. A practice client maps to accounting customers but carries practice-specific data (partner assigned, engagement type, billing model, onboarding state).

**What it must do:**
- Manage practice clients with: legal name, trading name, registration/tax number, client group, assigned partner/manager, engagement type, billing model (hourly/fixed/retainer), and status (Prospect → Onboarding → Active → Inactive → Archived)
- Duplicate detection on name + tax number on create
- Client groups for managing related entities (e.g. Marneweck Holdings and all subsidiaries under one group)
- Full activity timeline: time entries, tasks, invoices, documents linked to client
- Bulk import from legacy spreadsheets (CSV template)
- Only Active clients appear in operational dropdowns

**Data entities:**
```
practice_clients (id, company_id, legal_name, trading_name, registration_no, tax_no, 
  client_group_id, assigned_partner_id, assigned_manager_id, billing_model, status, created_at)
practice_client_groups (id, company_id, name, description)
practice_client_contacts (id, client_id, name, email, phone, role, is_primary)
```

**Links to existing:** `customers` table (optional link_customer_id — a practice client may also be an AR customer)

---

### 3.2 Job Category & Work Item Registry

**What it is:** A managed two-level taxonomy replacing the Excel `Codes` / `JOB CODES` sheets.

**What it must do:**
- Two levels: Job Category → Work Item (e.g. Category: "Payroll" → Item: "Monthly Processing", "UIF Submissions", "IRP5 Preparation")
- Admin CRUD with sort order, active/inactive lifecycle
- Cascading selection: selecting a category filters available work items
- Usage analytics (which codes are used most, by which staff)
- Deactivated items remain on historical entries but cannot be selected for new entries
- Default SA accounting firm categories pre-seeded: Accounting, Payroll, SARS, Financial Statements, CIPC, Admin, Meeting, Tax Advisory, Audit Support

**Data entities:**
```
practice_job_categories (id, company_id, name, sort_order, is_active, reporting_tag)
practice_work_items (id, category_id, company_id, name, sort_order, is_active, 
  default_billable, default_rate_override)
```

---

### 3.3 Time Entry Module (Enhanced)

**What it is:** A full replacement for the Excel `Entry` sheet, built on top of existing `time_entries` table but with comprehensive workflow, validation, and billing linkage.

**What it must do:**

**Capture:**
- Day view and list view for time entries
- Per-entry: date, hours, practice_client, job_category, work_item, notes, billable flag, status
- Rate auto-resolved from staff rate history (effective date) — never manually typed
- Total auto-computed server-side
- Duplicate previous entry for recurring work
- Favourites/templates for common entry patterns
- Bulk entry (week or range fill from template)

**Assisted capture:**
- "Suggestions" panel: system recommends entries based on recent tasks, open jobs, calendar events (optional future phase)
- Origin tracked: manual vs system-assisted

**Validation rules:**
| Field | Rule |
|-------|------|
| Date | Not future. Within open period (or override permission) |
| Hours | > 0, ≤ 24. Soft warning if daily total > 12 |
| Client | Active practice client |
| Job Category | Active category |
| Work Item | Active item belonging to selected category |
| Rate | System-resolved from rate history — snapshot stored on entry |
| Total | Server-computed: hours × rate |

**Statuses:** `draft` → `submitted` → `approved` → `billed` / `not_billable` / `leave`

**Data entities:** Extend existing `time_entries` table:
```sql
ALTER TABLE time_entries ADD COLUMN
  practice_client_id uuid REFERENCES practice_clients,
  job_category_id uuid REFERENCES practice_job_categories,
  work_item_id uuid REFERENCES practice_work_items,
  applied_rate numeric(18,4),
  line_total numeric(18,2),
  status text DEFAULT 'draft',
  origin text DEFAULT 'manual', -- 'manual' | 'assisted' | 'recurring'
  invoice_id uuid REFERENCES customer_invoices,
  approved_by uuid REFERENCES users,
  approved_at timestamptz,
  billed_at timestamptz;
```

---

### 3.4 Staff Rate Management

**What it is:** Rate profiles with effective-date history per staff member. Supports client-specific overrides.

**What it must do:**
- Default rate per staff member with effective date (so historical rates don't change)
- Client-specific rate override (some clients billed at different rates)
- Engagement-level override (a specific job has a fixed agreed rate)
- Rate resolution priority: engagement override → client override → staff default → firm default
- Historical integrity: changing future rates does NOT alter past approved/billed entries

**Data entities:**
```
practice_staff_rates (id, company_id, user_id, rate, currency, effective_from, effective_to)
practice_client_rate_overrides (id, company_id, client_id, user_id, rate, effective_from, effective_to)
```

---

### 3.5 WIP & Billing Pipeline

**What it is:** Converts approved time entries into billable items and practice invoices.

**What it must do:**
- WIP view: all approved, not-yet-billed time by client, with subtotals
- Select entries → generate practice invoice (creates a `customer_invoice` in accounting module)
- Billing formats: detailed (one line per time entry) or summarised (grouped by category)
- Invoice line item grouping options: by date, by work item, by category, by task
- WIP aging: how long entries have been approved but unbilled
- Write-off unapproved/unbillable entries with reason code
- Credit and adjustment handled as separate records (no destructive edits)

**Integration:**
- Generated invoices link to existing `customer_invoices` + `customer_invoice_line_items` tables
- Each invoice line item carries `time_entry_id` reference for traceability

---

### 3.6 Task & Job Management

**What it is:** A lightweight workflow engine for tracking client jobs and individual tasks.

**What it must do:**
- Jobs: client-linked work packages (e.g. "Prepare March 2026 management accounts for Marneweck")
  - Fields: client, job category, description, assigned partner, assigned preparer, due date, status, priority
  - Statuses: `new` → `in_progress` → `review` → `approved` → `billed` → `complete`
- Tasks: sub-items on a job or standalone internal tasks
  - Fields: job (optional), assigned to, due date, priority, status, notes
  - Recurring tasks: generate on a schedule (e.g. every month-end)
- Link time entries to jobs (voluntary)
- Dashboard: overdue tasks, upcoming due dates, unassigned work
- Notifications: overdue reminders

**Data entities:**
```
practice_jobs (id, company_id, client_id, category_id, title, description, 
  partner_id, preparer_id, due_date, status, priority, financial_year, billing_type)
practice_tasks (id, company_id, job_id, title, description, assigned_to, 
  due_date, priority, status, recurring_rule, parent_task_id)
```

---

### 3.7 Management Reporting & Dashboards

**What it must do:**
- Staff utilisation: billable hours vs total hours by staff and period
- Client profitability: revenue vs time cost per client
- WIP aging: unbilled approved time, aged by weeks
- Revenue pipeline: estimated billing from open WIP
- Time entry compliance: who has not submitted timesheets
- Service mix: breakdown by job category
- All reports filterable by period, staff, client, category

---

## 4. What Already Exists in IsaFlow

| Component | Status | Notes |
|-----------|--------|-------|
| `time_entries` table + basic CRUD | ✅ Exists | Needs schema extension |
| `pages/accounting/time-tracking` | ✅ Exists (basic) | Needs full redesign |
| `pages/accounting/timesheets` | ✅ Exists (week view) | Keep as quick entry |
| `timeTrackingService.ts` | ✅ Exists | Extend, don't replace |
| `timeTrackingReportService.ts` | ✅ Exists | Extend |
| `projects.ts` API + `projectAccountingService.ts` | ✅ Exists | Could map to `practice_jobs` |
| `salesReps` | ✅ Exists | Maps to staff concept |
| Practice CRM | ❌ Missing | Net-new |
| Job Category / Work Item registry | ❌ Missing | Net-new |
| Staff rate profiles with effective dates | ❌ Missing | Net-new |
| WIP / billing pipeline | ❌ Missing | Net-new |
| Task & job workflow engine | ❌ Missing | Net-new (existing `practice_tasks` concept different) |
| Management dashboards (utilisation, WIP aging) | ❌ Missing | Net-new |

---

## 5. UI/UX Approach

- New top-level nav tab: **"Practice"** (alongside Sales, Purchases, Accounting etc.)
- Practice tab sections: Clients | Time Entry | Jobs & Tasks | WIP & Billing | Reports
- Time entry: day view (calendar-style) as default, list view toggle
- WIP: table with bulk-select → "Generate Invoice" action
- Jobs: Kanban view option by status

---

## 6. Integration Points

- **AR module**: WIP billing generates `customer_invoices` + lines
- **GL module**: billing triggers journal entries
- **Payroll module**: staff hours feed into cost reporting
- **Reporting module**: practice dashboards as new report types
- **User access**: new `practice_*` permission modules

---

## 7. Non-Goals (this PRD)

- AI-assisted time suggestions (Phase 2)
- Client-facing portal for job/task visibility (Phase 2)
- Calendar/scheduling view (Phase 2)
- Integration with external tools (Microsoft 365, Xero, QuickBooks) (Phase 3)
- Mobile native app (future)

---

## 8. Implementation Phases

### Phase 1 — Foundation (4 weeks)
- DB schema migrations: `practice_clients`, `practice_client_groups`, `practice_job_categories`, `practice_work_items`, `practice_staff_rates`
- API: CRUD for all foundation entities
- UI: Practice CRM pages, Job Category admin
- Extend `time_entries` schema

### Phase 2 — Time Entry & WIP (4 weeks)
- Enhanced time entry UI (day view, cascading selects, rate auto-resolve)
- Status workflow: draft → submitted → approved
- WIP table and billing pipeline
- Invoice generation from WIP

### Phase 3 — Jobs, Tasks & Workflow (3 weeks)
- `practice_jobs` + `practice_tasks` schema and API
- Jobs/tasks UI (list + kanban)
- Link time entries to jobs
- Recurring tasks engine

### Phase 4 — Reporting (2 weeks)
- Staff utilisation report
- Client profitability report
- WIP aging report
- Revenue pipeline dashboard

**Total estimate: ~13 weeks with 1 fullstack engineer**

---

## 9. Success Criteria

- An accounting firm can fully replace their Excel-based timekeeping and WIP workflow with IsaFlow
- 100% of billable time is captured and traceable to invoices
- Partners can see real-time utilisation and WIP aging without manual reports
- Zero revenue leakage: approved time is always either billed or explicitly written off

---

## 10. Open Questions

1. Should `practice_clients` be a separate entity or an extension of `customers`? Recommendation: separate with optional link, because practice clients may not be AR customers.
2. Should the "Practice" tab be available to all IsaFlow plans or gated as a premium feature?
3. Calendar integration (Microsoft 365 / Google) — Phase 2 or 3?
