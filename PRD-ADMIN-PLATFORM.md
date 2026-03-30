# PRD: ISAFlow Admin Platform

## Overview

A centralised back-office platform for managing ISAFlow as a SaaS business. Provides ISAFlow staff with full visibility and control over companies, users, subscriptions, billing, support, and internal admin tools — all from a single dashboard at `/admin`.

This is the **business management layer** that sits above the accounting product. It is separate from the per-company accounting UI and is only accessible to ISAFlow staff (super_admin role).

## Problem

ISAFlow currently has no centralised way to:

1. View and manage all customer companies from one place
2. Manage users across companies (add, remove, change roles, reset passwords)
3. Track subscriptions, payments, and revenue
4. Control feature access per plan tier
5. Run admin tools (Sage auto-import, data migrations, bulk operations)
6. Monitor platform health (active users, storage, API usage)
7. Handle customer support without logging into individual companies
8. Enforce compliance (POPIA data exports, account deactivation)

Everything is currently done via direct database access or one-off scripts.

## Target Users

- ISAFlow founders / executives (business metrics, revenue)
- ISAFlow support staff (company management, user issues)
- ISAFlow developers (admin tools, diagnostics)

## Architecture

### Deployment: Separate App on `admin.isaflow.co.za`

The admin platform is a **separate Next.js application** deployed to its own subdomain. It shares the same Neon database as the customer app but has its own codebase, deployment pipeline, and auth enforcement.

**Why separate:**
- Customer JS bundle never includes admin code (smaller, more secure)
- Separate deployment — admin changes don't risk breaking the customer app
- Enforced 2FA, IP whitelist possible at the infrastructure level
- Customers can't discover admin routes exist
- Own rate limits, logging, CSP headers

**Repo structure:**
```
isaflow-admin/                    # Separate repo (or monorepo apps/admin)
  pages/
    index.tsx                     # Dashboard
    companies/                    # Company management
    users/                        # User management
    billing/                      # Subscriptions, invoices, plans
    tools/                        # Sage import, migrations, announcements
    audit.tsx                     # Audit trail
    settings.tsx                  # Platform settings
    api/                          # All API routes
  src/
    modules/admin/                # Admin services
    lib/                          # Shared DB connection (same Neon DB)
    components/admin/             # Admin UI components
```

**Infrastructure:**
```
admin.isaflow.co.za  → Vercel/Cloudflare (separate project)
app.isaflow.co.za    → Vercel/Cloudflare (customer app — unchanged)
                        ↘ Same Neon PostgreSQL database ↙
```

**Auth:** Same `users` table and JWT system. Admin app rejects any user without `super_admin` role at the middleware level. Session cookies scoped to `admin.isaflow.co.za` domain.

### Routes

```
admin.isaflow.co.za/                          → Dashboard
admin.isaflow.co.za/companies                 → Company management
admin.isaflow.co.za/companies/[id]            → Company detail + actions
admin.isaflow.co.za/users                     → User management
admin.isaflow.co.za/users/[id]                → User detail + actions
admin.isaflow.co.za/billing                   → Billing & subscriptions
admin.isaflow.co.za/billing/plans             → Plan management
admin.isaflow.co.za/billing/invoices          → Invoice history
admin.isaflow.co.za/tools                     → Admin tools
admin.isaflow.co.za/tools/sage-import         → Sage auto-import
admin.isaflow.co.za/tools/migrations          → Run migrations for companies
admin.isaflow.co.za/tools/announcements       → System-wide announcements
admin.isaflow.co.za/audit                     → Audit trail & activity logs
admin.isaflow.co.za/settings                  → Platform settings

admin.isaflow.co.za/api/*                     → All admin API routes
```

All routes require `super_admin` role. Unauthenticated requests redirect to login.

---

## Phase 1: Core Platform (MVP)

### 1.1 Admin Dashboard

**Route:** `/admin`

**Features:**
- KPI cards: Total companies, active companies (last 30 days), total users, MRR, ARR
- Revenue chart (monthly, last 12 months)
- New signups chart (weekly, last 3 months)
- Recent activity feed (last 50 events: signups, logins, subscription changes)
- Quick actions: Add company, add user, search

**API:** `GET /api/admin/dashboard-stats`

### 1.2 Company Management

**Route:** `/admin/companies`

**List view:**
- Searchable, sortable table of all companies
- Columns: Name, Plan, Status (active/suspended/trial), Users count, MRR, Created, Last active
- Filters: Plan tier, status, created date range, activity
- Bulk actions: Suspend, activate, change plan
- Export to CSV

**Detail view:** `/admin/companies/[id]`

- Company info card (name, registration, tax number, address, created date)
- Edit company details inline
- Subscription card (current plan, billing cycle, next invoice, payment method)
- Users tab: list of all users in this company with roles
- Activity tab: recent logins, transactions, API calls
- Storage tab: database size, document count, attachment size
- Sage data tab: if migrated from Sage, show migration session details
- Actions:
  - Suspend company (blocks all logins, preserves data)
  - Reactivate company
  - Change plan tier
  - Add/remove users
  - Reset company data (dangerous, requires confirmation)
  - Export company data (POPIA compliance)
  - Delete company (soft delete, 30-day retention)
  - Impersonate (login as company admin for support — audited)

**Database:**

```sql
-- Extend existing companies table
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES plans(id);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'
  CHECK (status IN ('trial', 'active', 'suspended', 'cancelled', 'deleted'));
ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_email VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_contact VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
```

**API:**
- `GET /api/admin/companies` — list with filters, pagination
- `GET /api/admin/companies/[id]` — detail
- `PATCH /api/admin/companies/[id]` — update
- `POST /api/admin/companies/[id]/suspend` — suspend
- `POST /api/admin/companies/[id]/activate` — reactivate
- `POST /api/admin/companies/[id]/change-plan` — change subscription
- `POST /api/admin/companies/[id]/export-data` — POPIA data export
- `DELETE /api/admin/companies/[id]` — soft delete
- `POST /api/admin/companies/[id]/impersonate` — generate impersonation token

### 1.3 User Management

**Route:** `/admin/users`

**List view:**
- All users across all companies
- Columns: Name, Email, Role, Companies (count + names), Last login, Status, Created
- Filters: Role, active/inactive, company, last login range
- Search by name or email

**Detail view:** `/admin/users/[id]`

- Profile card (name, email, phone, role, created, last login)
- Companies tab: all companies this user belongs to, with role per company
- Sessions tab: active sessions, devices, IPs
- Activity tab: recent actions (logins, transactions, settings changes)
- Actions:
  - Edit profile
  - Change global role
  - Change company role
  - Reset password (sends reset email)
  - Force logout (invalidate all sessions)
  - Suspend user
  - Delete user
  - Add to company / remove from company

**Database:**

```sql
-- Extend existing users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active'
  CHECK (status IN ('active', 'suspended', 'deleted'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip VARCHAR(45);
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- Admin audit log
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(50) NOT NULL, -- 'company', 'user', 'plan', 'system'
  target_id UUID,
  details JSONB DEFAULT '{}',
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_admin_audit_admin ON admin_audit_log(admin_user_id);
CREATE INDEX idx_admin_audit_target ON admin_audit_log(target_type, target_id);
CREATE INDEX idx_admin_audit_created ON admin_audit_log(created_at DESC);
```

**API:**
- `GET /api/admin/users` — list with filters
- `GET /api/admin/users/[id]` — detail
- `PATCH /api/admin/users/[id]` — update
- `POST /api/admin/users/[id]/reset-password` — send reset email
- `POST /api/admin/users/[id]/force-logout` — invalidate sessions
- `POST /api/admin/users/[id]/suspend` — suspend
- `POST /api/admin/users/[id]/add-to-company` — assign to company with role
- `DELETE /api/admin/users/[id]/remove-from-company` — remove from company

---

## Phase 2: Billing & Subscriptions

### 2.1 Plan Management

**Route:** `/admin/billing/plans`

**Features:**
- CRUD subscription plans
- Plan fields: name, code, description, monthly_price, annual_price, features (JSONB), limits (max_users, max_companies, max_storage_gb, max_invoices_per_month)
- Feature flags per plan (e.g., payroll, multi-company, API access, bank feeds, document capture)
- Active/archived status

**Database:**

```sql
CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL, -- 'starter', 'professional', 'enterprise'
  name VARCHAR(100) NOT NULL,
  description TEXT,
  monthly_price_cents INT NOT NULL DEFAULT 0,
  annual_price_cents INT NOT NULL DEFAULT 0,
  currency VARCHAR(3) DEFAULT 'ZAR',
  features JSONB DEFAULT '{}',
  limits JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Default plans:**

| Plan | Monthly | Annual | Users | Features |
|------|---------|--------|-------|----------|
| Starter | R299 | R2,990 | 1 | Core accounting, 1 company, invoicing, bank recon |
| Professional | R599 | R5,990 | 5 | + Payroll, multi-company, bank feeds, document capture |
| Enterprise | R1,499 | R14,990 | Unlimited | + API access, custom reports, priority support, SLA |

### 2.2 Subscription Management

**Route:** `/admin/billing`

**Features:**
- Overview: total MRR, ARR, churn rate, ARPU
- Subscription list: company, plan, status (active/past_due/cancelled), next billing date, payment method
- Change plan for any company
- Apply discounts / credits
- Cancel / pause subscriptions
- View payment history per company

**Database:**

```sql
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  plan_id UUID NOT NULL REFERENCES plans(id),
  status VARCHAR(20) DEFAULT 'active'
    CHECK (status IN ('trial', 'active', 'past_due', 'cancelled', 'paused')),
  billing_cycle VARCHAR(10) DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'annual')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN DEFAULT false,
  cancelled_at TIMESTAMPTZ,
  stripe_subscription_id VARCHAR(255),
  discount_percent INT DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_subscriptions_company ON subscriptions(company_id);
CREATE INDEX idx_subscriptions_status ON subscriptions(status);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  subscription_id UUID REFERENCES subscriptions(id),
  invoice_number VARCHAR(20) UNIQUE NOT NULL,
  status VARCHAR(20) DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'cancelled', 'credited')),
  subtotal_cents INT NOT NULL,
  tax_cents INT NOT NULL DEFAULT 0,
  total_cents INT NOT NULL,
  currency VARCHAR(3) DEFAULT 'ZAR',
  due_date DATE,
  paid_at TIMESTAMPTZ,
  payment_method VARCHAR(50),
  stripe_invoice_id VARCHAR(255),
  line_items JSONB DEFAULT '[]',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_invoices_company ON invoices(company_id);
CREATE INDEX idx_invoices_status ON invoices(status);
```

### 2.3 Payment Integration

**Provider:** Stripe (primary) + PayFast (SA fallback)

- Stripe for card payments, subscriptions, invoicing
- PayFast for SA bank payments (EFT, instant EFT)
- Webhook handlers for payment events
- Automatic invoice generation on subscription renewal
- Dunning: email reminders at 1, 3, 7 days overdue, suspend at 14 days

**API:**
- `GET /api/admin/billing/overview` — MRR, ARR, churn metrics
- `GET /api/admin/billing/subscriptions` — list
- `PATCH /api/admin/billing/subscriptions/[id]` — update
- `GET /api/admin/billing/invoices` — list
- `POST /api/admin/billing/invoices/[id]/send` — send to customer
- `POST /api/admin/billing/invoices/[id]/mark-paid` — manual payment recording
- `POST /api/webhooks/stripe` — Stripe webhook handler
- `POST /api/webhooks/payfast` — PayFast ITN handler

---

## Phase 3: Access Control & Feature Flags

### 3.1 Feature Flags

Control which features are available per plan and per company.

**Database:**

```sql
CREATE TABLE IF NOT EXISTS feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(100) UNIQUE NOT NULL, -- 'payroll', 'multi_company', 'bank_feeds', 'api_access'
  name VARCHAR(200) NOT NULL,
  description TEXT,
  is_global BOOLEAN DEFAULT false, -- if true, available to everyone
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plan_features (
  plan_id UUID NOT NULL REFERENCES plans(id),
  feature_id UUID NOT NULL REFERENCES feature_flags(id),
  PRIMARY KEY (plan_id, feature_id)
);

-- Per-company overrides (enable a feature not in their plan, or disable one that is)
CREATE TABLE IF NOT EXISTS company_feature_overrides (
  company_id UUID NOT NULL REFERENCES companies(id),
  feature_id UUID NOT NULL REFERENCES feature_flags(id),
  enabled BOOLEAN NOT NULL,
  reason TEXT,
  set_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (company_id, feature_id)
);
```

**Default feature flags:**

| Code | Name | Starter | Pro | Enterprise |
|------|------|---------|-----|------------|
| `core_accounting` | Core Accounting (GL, AR, AP) | Yes | Yes | Yes |
| `invoicing` | Customer Invoicing | Yes | Yes | Yes |
| `bank_recon` | Bank Reconciliation | Yes | Yes | Yes |
| `bank_feeds` | Automatic Bank Feeds | No | Yes | Yes |
| `payroll` | Payroll Module | No | Yes | Yes |
| `multi_company` | Multiple Companies | No | Yes | Yes |
| `document_capture` | Document Capture / OCR | No | Yes | Yes |
| `api_access` | REST API Access | No | No | Yes |
| `custom_reports` | Custom Report Builder | No | No | Yes |
| `group_consolidation` | Group Consolidation | No | No | Yes |
| `sage_auto_import` | Sage Auto-Import (admin) | Admin | Admin | Admin |
| `priority_support` | Priority Support | No | No | Yes |

### 3.2 Feature Gate Middleware

```typescript
// Usage in API routes:
export default withCompany(withFeature('payroll')(withErrorHandler(handler)));

// Usage in UI:
const { hasFeature } = useFeatureFlags();
if (!hasFeature('bank_feeds')) return <UpgradePrompt feature="bank_feeds" />;
```

**API:**
- `GET /api/admin/features` — list all feature flags
- `PATCH /api/admin/features/[id]` — update
- `GET /api/admin/companies/[id]/features` — company's effective features
- `POST /api/admin/companies/[id]/features/override` — set override

---

## Phase 4: Admin Tools

### 4.1 Sage Auto-Import (Relocated)

Move the existing `/accounting/migration/sage-auto` functionality to `/admin/tools/sage-import`.

The admin logs into the customer's Sage account (with their permission), pulls all data, and pushes it directly into the customer's ISAFlow company — all without the customer needing to touch CSV files.

**Flow:**
1. Admin selects target company from dropdown
2. Admin opens Sage in a popup, logs in with the customer's credentials (shared by customer)
3. Clicks "Pull All Data" — accounts, customers, suppliers, invoices flow in
4. Admin reviews mapped data
5. Clicks "Import into [Company Name]" — data written to the target company

### 4.2 Bulk Migration Tool

**Route:** `/admin/tools/migrations`

Run the migration wizard on behalf of any company. Upload CSVs and import directly.

### 4.3 System Announcements

**Route:** `/admin/tools/announcements`

Create banner notifications shown to all users or specific companies.

**Database:**

```sql
CREATE TABLE IF NOT EXISTS system_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(20) DEFAULT 'info' CHECK (type IN ('info', 'warning', 'maintenance', 'feature')),
  target VARCHAR(20) DEFAULT 'all' CHECK (target IN ('all', 'plan', 'company')),
  target_ids UUID[] DEFAULT '{}',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  is_dismissible BOOLEAN DEFAULT true,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 4.4 Company Impersonation

Admin can "login as" any company for support purposes. Creates a time-limited impersonation token (30 min), logs every action to admin_audit_log. Visible indicator in the UI: "You are viewing as [Company Name] — Exit".

### 4.5 Data Export (POPIA Compliance)

Export all data for a company as a ZIP file containing:
- Company profile (JSON)
- Chart of accounts (CSV)
- All customers and suppliers (CSV)
- All invoices (CSV)
- All journal entries (CSV)
- All bank transactions (CSV)
- All documents/attachments (files)

Required for POPIA Subject Access Requests.

---

## Phase 5: Monitoring & Analytics

### 5.1 Platform Health Dashboard

**Route:** `/admin` (widgets)

- Active users (real-time, last 24h, last 7d)
- API response times (p50, p95, p99)
- Error rate (last 24h)
- Database size per company
- Uptime history

### 5.2 Usage Analytics

**Route:** `/admin/analytics`

- Most used features (page views, API calls per feature)
- User engagement (DAU, WAU, MAU, stickiness)
- Feature adoption rates per plan
- Churn prediction signals (inactive users, declining usage)
- Revenue per feature (which features drive upgrades)

### 5.3 Audit Trail

**Route:** `/admin/audit`

- Filterable log of all admin actions
- Who did what, when, to whom
- Exportable for compliance

---

## Navigation

```
Admin (only visible to super_admin)
  ├── Dashboard (/admin)
  ├── Companies (/admin/companies)
  ├── Users (/admin/users)
  ├── Billing
  │   ├── Overview (/admin/billing)
  │   ├── Plans (/admin/billing/plans)
  │   └── Invoices (/admin/billing/invoices)
  ├── Tools
  │   ├── Sage Auto-Import (/admin/tools/sage-import)
  │   ├── Bulk Migration (/admin/tools/migrations)
  │   └── Announcements (/admin/tools/announcements)
  ├── Audit Trail (/admin/audit)
  └── Settings (/admin/settings)
```

---

## File Structure

```
pages/
  admin/
    index.tsx                       # Admin dashboard
    companies/
      index.tsx                     # Company list
      [id].tsx                      # Company detail
    users/
      index.tsx                     # User list
      [id].tsx                      # User detail
    billing/
      index.tsx                     # Billing overview
      plans.tsx                     # Plan management
      invoices.tsx                  # Invoice list
    tools/
      sage-import.tsx               # Sage auto-import (relocated)
      migrations.tsx                # Bulk migration tool
      announcements.tsx             # System announcements
    audit.tsx                       # Audit trail
    settings.tsx                    # Platform settings

pages/api/admin/
  dashboard-stats.ts
  companies.ts                      # GET list, POST create
  companies/[id].ts                 # GET detail, PATCH update, DELETE
  companies/[id]/suspend.ts
  companies/[id]/activate.ts
  companies/[id]/change-plan.ts
  companies/[id]/export-data.ts
  companies/[id]/impersonate.ts
  companies/[id]/features.ts
  users.ts
  users/[id].ts
  users/[id]/reset-password.ts
  users/[id]/force-logout.ts
  users/[id]/suspend.ts
  users/[id]/add-to-company.ts
  billing/overview.ts
  billing/subscriptions.ts
  billing/subscriptions/[id].ts
  billing/invoices.ts
  billing/invoices/[id]/send.ts
  billing/invoices/[id]/mark-paid.ts
  billing/plans.ts
  billing/plans/[id].ts
  features.ts
  features/[id].ts
  audit.ts
  announcements.ts
  announcements/[id].ts

src/modules/admin/
  services/
    adminCompanyService.ts          # Company CRUD + actions
    adminUserService.ts             # User CRUD + actions
    billingService.ts               # Subscription + invoice management
    planService.ts                  # Plan CRUD
    featureFlagService.ts           # Feature flag resolution
    impersonationService.ts         # Impersonation token management
    auditService.ts                 # Audit log write/query
    announcementService.ts          # Announcement CRUD
    dataExportService.ts            # POPIA data export
    adminDashboardService.ts        # Dashboard stats
  middleware/
    withAdmin.ts                    # Combines withAuth + withRole('super_admin') + audit logging
    withFeature.ts                  # Feature gate middleware for API routes
  types/
    admin.types.ts                  # All admin-specific types

src/components/admin/
  AdminLayout.tsx                   # Admin-specific layout with sidebar nav
  AdminNav.tsx                      # Admin navigation
  CompanyTable.tsx                  # Reusable company data table
  UserTable.tsx                     # Reusable user data table
  StatsCard.tsx                     # KPI card component
  FeatureGate.tsx                   # UI component for feature gating
  ImpersonationBanner.tsx           # "Viewing as [Company]" banner
```

---

## Database Migrations

```
scripts/migrations/sql/
  260_admin_platform_plans.sql          # plans table + default plans
  261_admin_platform_subscriptions.sql  # subscriptions + invoices tables
  262_admin_platform_features.sql       # feature_flags + plan_features + overrides
  263_admin_platform_audit.sql          # admin_audit_log table
  264_admin_platform_announcements.sql  # system_announcements table
  265_admin_platform_company_ext.sql    # ALTER companies + users with new columns
```

---

## Security

- All `/admin` routes gated by `super_admin` role at both API and UI level
- Impersonation creates a separate JWT with `impersonating: true` flag + original admin ID
- All admin actions logged to `admin_audit_log` with IP address
- Impersonation sessions expire after 30 minutes
- Password reset emails go to the user, not the admin
- Company data exports are generated async and delivered via secure download link
- Stripe webhook signature verification required
- No admin can delete their own account or remove their own super_admin role

---

## Implementation Priority

| Phase | Scope | Estimate |
|-------|-------|----------|
| **Phase 1** | Dashboard + Company management + User management + Audit log | Core |
| **Phase 2** | Plans + Subscriptions + Invoices + Stripe/PayFast integration | Revenue |
| **Phase 3** | Feature flags + Feature gate middleware + Upgrade prompts | Monetisation |
| **Phase 4** | Admin tools (Sage import, bulk migration, announcements, impersonation, POPIA export) | Operations |
| **Phase 5** | Analytics + Health monitoring + Churn signals | Growth |

---

## Success Criteria

1. ISAFlow staff can onboard a new customer (create company, add users, assign plan) in under 2 minutes
2. All admin actions are audited with who, what, when, and IP
3. Revenue metrics (MRR, ARR, churn) are visible on the admin dashboard
4. Any customer's data can be exported for POPIA compliance in one click
5. Feature gating prevents access to premium features without the right plan
6. Sage auto-import can be run by ISAFlow staff on behalf of any customer
7. Customer support can impersonate a company to diagnose issues without asking for screenshots
