# Phase 5 — Wave 2 Stream 2D: Auth/CSRF Coverage

**Date:** 2026-04-15
**Auditor:** Wave 2 Stream 2D (automated)
**Scope:** All state-changing API routes in `pages/api/`

---

## Summary

| Metric | Count |
|--------|-------|
| State-changing routes audited (main scan) | 149 |
| Action-only routes (POST-only, missed by `===` scan) | 23 |
| **Total audited** | **172** |
| Routes with `withCsrf` | 9 |
| Routes with Zod validation | 15 |
| **P0 findings** | **18** |
| **P1 findings** | **22** |
| **P2 findings** | **121** |
| **P3 findings** | 0 (read routes excluded) |

### Notes on middleware patterns

- **`withCompany`** — tenant-scoped auth (standard accounting routes)
- **`withAdmin`** — super-admin auth with lightweight CSRF via `X-Admin-Request: true` header (all 26 admin routes)
- **`withAuth`** — authenticated-user auth, no CSRF (auth/profile, portal, invite, cross-company routes)
- **`withCsrf`** — token-based CSRF protection; only 9 routes have it despite BL-22 targeting 8

---

## Per-route Classification

### CSRF Protected (Clean — withCompany + withCsrf + Zod)

| # | Route | Methods | withCompany | withCsrf | Zod | Money-moving | Auth-sensitive | Severity |
|---|-------|---------|-------------|----------|-----|--------------|----------------|----------|
| 1 | `accounting/bank-transactions-action` | POST | ✅ | ✅ | ✅ | ✅ | ❌ | CLEAN |
| 2 | `accounting/bank-rules-action` | POST | ✅ | ✅ | ✅ | ✅ | ❌ | CLEAN |
| 3 | `accounting/credit-notes-action` | POST | ✅ | ✅ | ✅ | ✅ | ❌ | CLEAN |
| 4 | `accounting/journal-entries-action` | POST | ✅ | ✅ | ✅ | ✅ | ❌ | CLEAN |
| 5 | `accounting/supplier-invoices-action` | POST | ✅ | ✅ | ✅ | ✅ | ❌ | CLEAN |
| 6 | `accounting/write-offs-action` | POST | ✅ | ✅ | ✅ | ✅ | ❌ | CLEAN |
| 7 | `accounting/customer-invoices-detail` | GET/PUT/POST | ✅ | ✅ | ✅ | ✅ | ❌ | CLEAN |
| 8 | `accounting/customer-payments` | GET/POST | ✅ | ✅ | ✅ | ✅ | ❌ | CLEAN |
| 9 | `accounting/supplier-payments` | GET/POST | ✅ | ✅ | ✅ | ✅ | ❌ | CLEAN |

### Auth Routes with Zod (BL-33 covered)

| # | Route | Methods | withCompany | withCsrf | Zod | Money-moving | Auth-sensitive | Severity |
|---|-------|---------|-------------|----------|-----|--------------|----------------|----------|
| 10 | `auth/login` | POST | ❌ | ❌ | ✅ | ❌ | ✅ | P2 |
| 11 | `auth/register` | POST | ❌ | ❌ | ✅ | ❌ | ✅ | P2 |
| 12 | `auth/forgot-password` | POST | ❌ | ❌ | ✅ | ❌ | ✅ | P2 |
| 13 | `auth/do-reset-password` | POST | ❌ | ❌ | ✅ | ❌ | ✅ | P2 |

---

## P0 Gaps — Money-moving state-change, missing withCsrf

### P0-A: Money-moving CRUD routes missing withCsrf

| # | Route | Methods | withCompany | withCsrf | Zod | Notes |
|---|-------|---------|-------------|----------|-----|-------|
| 1 | `accounting/journal-entries` | GET/POST | ✅ | ❌ | ❌ | Posts full journal entries |
| 2 | `accounting/credit-notes` | GET/POST | ✅ | ❌ | ❌ | Creates credit notes |
| 3 | `accounting/supplier-invoices` | GET/POST | ✅ | ❌ | ❌ | Creates supplier invoices |
| 4 | `accounting/supplier-invoices-detail` | GET/PUT/PATCH | ✅ | ❌ | ❌ | Updates supplier invoice detail |
| 5 | `accounting/supplier-credit-notes` | GET/POST | ✅ | ❌ | ❌ | Creates supplier credit notes |
| 6 | `accounting/customer-allocations` | GET/POST | ✅ | ❌ | ❌ | Creates customer allocations |
| 7 | `accounting/supplier-allocations` | GET/POST | ✅ | ❌ | ❌ | Creates supplier allocations |
| 8 | `accounting/bank-reconciliations` | GET/POST | ✅ | ❌ | ❌ | Creates bank reconciliations |
| 9 | `accounting/batch-payments` | GET/POST | ✅ | ❌ | ❌ | Creates batch payments |
| 10 | `accounting/write-offs` | GET/POST | ✅ | ❌ | ❌ | Creates write-offs |
| 11 | `accounting/vat-adjustments` | GET/POST | ✅ | ❌ | ❌ | Creates VAT adjustments |
| 12 | `accounting/adjustments` | GET/POST | ✅ | ❌ | ❌ | Creates adjustment entries |
| 13 | `accounting/year-end` | GET/POST | ✅ | ❌ | ❌ | Year-end close (HIGH IMPACT) |
| 14 | `accounting/opening-balances` | GET/POST | ✅ | ❌ | ❌ | Sets opening balances |
| 15 | `accounting/payment-gateway` | GET/POST/PUT | ✅ | ❌ | ❌ | Payment gateway config |

### P0-B: Money-moving action routes missing withCsrf

| # | Route | Methods | withCompany | withCsrf | Zod | Notes |
|---|-------|---------|-------------|----------|-----|-------|
| 16 | `accounting/batch-payments-action` | POST | ✅ | ❌ | ❌ | approve/process/cancel payments |
| 17 | `accounting/bank-reconciliations-action` | POST | ✅ | ❌ | ❌ | reconcile/undo reconciliations |
| 18 | `accounting/customer-payments-action` | POST | ✅ | ❌ | ❌ | approve/reverse customer payments |
| 19 | `accounting/supplier-payments-action` | POST | ✅ | ❌ | ❌ | approve/reverse supplier payments |
| 20 | `accounting/vat-adjustments-action` | POST | ✅ | ❌ | ❌ | submit/undo VAT adjustments |
| 21 | `accounting/adjustments-action` | POST | ✅ | ❌ | ❌ | approve/reverse adjustments |

---

## P1 Gaps — Missing Zod validation

### P1-A: Money-moving routes missing Zod

All P0 routes above also lack Zod (listed separately for priority tracking):

| # | Route | withCsrf | Zod | Impact |
|---|-------|----------|-----|--------|
| 1 | `accounting/journal-entries` | ❌ | ❌ | Unvalidated journal body |
| 2 | `accounting/credit-notes` | ❌ | ❌ | Unvalidated credit note amounts |
| 3 | `accounting/supplier-invoices` | ❌ | ❌ | Unvalidated invoice data |
| 4 | `accounting/supplier-invoices-detail` | ❌ | ❌ | Unvalidated PUT body |
| 5 | `accounting/supplier-credit-notes` | ❌ | ❌ | Unvalidated body |
| 6 | `accounting/customer-allocations` | ❌ | ❌ | Unvalidated allocation amounts |
| 7 | `accounting/supplier-allocations` | ❌ | ❌ | Unvalidated allocation amounts |
| 8 | `accounting/bank-reconciliations` | ❌ | ❌ | Unvalidated reconciliation data |
| 9 | `accounting/batch-payments` | ❌ | ❌ | Unvalidated payment batch |
| 10 | `accounting/write-offs` | ❌ | ❌ | Unvalidated write-off amounts |
| 11 | `accounting/vat-adjustments` | ❌ | ❌ | Unvalidated VAT figures |
| 12 | `accounting/adjustments` | ❌ | ❌ | Unvalidated adjustment |
| 13 | `accounting/year-end` | ❌ | ❌ | Unvalidated year-end params |
| 14 | `accounting/opening-balances` | ❌ | ❌ | Unvalidated opening balance data |
| 15 | `accounting/payment-gateway` | ❌ | ❌ | Unvalidated gateway config |
| 16 | `accounting/batch-payments-action` | ❌ | ❌ | Unvalidated action payload |
| 17 | `accounting/bank-reconciliations-action` | ❌ | ❌ | Unvalidated action payload |
| 18 | `accounting/customer-payments-action` | ❌ | ❌ | Unvalidated action payload |
| 19 | `accounting/supplier-payments-action` | ❌ | ❌ | Unvalidated action payload |
| 20 | `accounting/vat-adjustments-action` | ❌ | ❌ | Unvalidated action payload |
| 21 | `accounting/adjustments-action` | ❌ | ❌ | Unvalidated action payload |

### P1-B: Auth-sensitive routes missing Zod

| # | Route | withAuth | withCsrf | Zod | Issue |
|---|-------|----------|----------|-----|-------|
| 22 | `auth/2fa-disable` | ✅ withAuth | ❌ | ❌ | No validation of disable request |
| 23 | `auth/2fa-setup` | ✅ withAuth | ❌ | ❌ | No validation of TOTP setup |
| 24 | `auth/2fa-verify` | public | ❌ | ❌ | No validation of verify token |
| 25 | `auth/2fa-verify-setup` | ✅ withAuth | ❌ | ❌ | No validation of setup verify |
| 26 | `auth/change-password` | ✅ withAuth | ❌ | ❌ | No validation of new password |
| 27 | `auth/profile` | ✅ withAuth | ❌ | ❌ | No validation of profile PUT |
| 28 | `auth/preferences` | ✅ withAuth | ❌ | ❌ | No validation of preferences PUT |
| 29 | `invite/[token]` | ✅ withAuth (POST) | ❌ | ❌ | No validation of invite accept body |

---

## P2 Gaps — Non-money state-change routes missing withCsrf

The following routes have `withCompany` (or `withAuth`) but no `withCsrf`. Listed by category:

### Accounting Config / Setup

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 1 | `accounting/accounting-settings` | POST/PUT | ✅ | ❌ | ❌ |
| 2 | `accounting/account-mappings` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 3 | `accounting/account-reporting-groups` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 4 | `accounting/account-reporting-groups/[id]/members` | POST/DELETE | ✅ | ❌ | ❌ |
| 5 | `accounting/chart-of-accounts` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 6 | `accounting/chart-of-accounts-detail` | PUT/PATCH | ✅ | ❌ | ❌ |
| 7 | `accounting/default-accounts` | PUT/POST | ✅ | ❌ | ❌ |
| 8 | `accounting/currencies` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 9 | `accounting/exchange-rates` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 10 | `accounting/fiscal-periods` | POST/PUT | ✅ | ❌ | ❌ |
| 11 | `accounting/fiscal-periods-action` | POST | ✅ | ❌ | ❌ |
| 12 | `accounting/company-settings` | PUT/PATCH | ✅ | ❌ | ❌ |
| 13 | `accounting/permissions` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 14 | `accounting/bank-accounts` | POST/PUT/DELETE | ✅ | ❌ | ❌ |

### Customer / Sales

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 15 | `accounting/customers` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 16 | `accounting/customer-categories` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 17 | `accounting/customer-contacts` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 18 | `accounting/customer-delivery-addresses` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 19 | `accounting/customer-quotes` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 20 | `accounting/customer-quotes-action` | POST | ✅ | ❌ | ❌ |
| 21 | `accounting/customer-sales-orders` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 22 | `accounting/customer-sales-orders-action` | POST | ✅ | ❌ | ❌ |
| 23 | `accounting/customer-activities` | POST | ✅ | ❌ | ❌ |
| 24 | `accounting/delivery-notes` | POST/PUT | ✅ | ❌ | ❌ |
| 25 | `accounting/recurring-invoices` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 26 | `accounting/recurring-invoices-action` | POST | ✅ | ❌ | ❌ |
| 27 | `accounting/customer-invoices-create` | POST | ✅ | ❌ | ❌ |
| 28 | `accounting/customer-invoices-gl` | POST | ✅ | ❌ | ❌ |

### Supplier / Procurement

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 29 | `accounting/suppliers-list` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 30 | `accounting/supplier-categories` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 31 | `accounting/supplier-contacts` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 32 | `accounting/supplier-activities` | POST | ✅ | ❌ | ❌ |
| 33 | `accounting/supplier-purchase-orders` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 34 | `accounting/supplier-returns` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 35 | `accounting/purchase-orders` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 36 | `accounting/purchase-orders/[id]` | PUT/DELETE | ✅ | ❌ | ❌ |
| 37 | `accounting/goods-received` | POST/PUT/DELETE | ✅ | ❌ | ❌ |

### Inventory / Items

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 38 | `accounting/items` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 39 | `accounting/item-categories` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 40 | `accounting/item-pricing` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 41 | `accounting/item-bundles` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 42 | `accounting/item-adjustments` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 43 | `accounting/item-opening-balances` | POST/PUT | ✅ | ❌ | ❌ |
| 44 | `accounting/stock-adjustments` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 45 | `accounting/products` | POST/PUT/DELETE | ✅ | ❌ | ❌ |

### Reporting / Analytics

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 46 | `accounting/budgets` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 47 | `accounting/budgets-action` | POST | ✅ | ❌ | ❌ |
| 48 | `accounting/custom-reports` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 49 | `accounting/consolidated-reports` | POST | ✅(withAuth) | ❌ | ❌ |
| 50 | `accounting/disclosure-notes-manual` | POST/PUT | ✅ | ❌ | ❌ |

### Projects / Time

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 51 | `accounting/projects` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 52 | `accounting/project-time-entries` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 53 | `accounting/time-entries` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 54 | `accounting/time-entries-action` | POST | ✅ | ❌ | ❌ |
| 55 | `accounting/sales-reps` | POST/PUT/DELETE | ✅ | ❌ | ❌ |

### Assets / Fixed Assets

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 56 | `accounting/assets` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 57 | `accounting/asset-locations` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 58 | `accounting/assets-disposals` | POST/PUT/DELETE | ✅ | ❌ | ❌ |

### HR / Payroll

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 59 | `payroll/employees` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 60 | `payroll/employees-detail` | POST/PUT | ✅ | ❌ | ❌ |
| 61 | `payroll/irp5-certificates` | POST/PUT | ✅ | ❌ | ❌ |
| 62 | `payroll/irp5-generate` | POST | ✅ | ❌ | ❌ |
| 63 | `payroll/leave-applications` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 64 | `payroll/payroll-runs` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 65 | `payroll/uif-declaration` | POST | ✅ | ❌ | ❌ |

### Company Management

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 66 | `accounting/companies` | POST/PUT | ✅(withAuth) | ❌ | ❌ |
| 67 | `accounting/company-directors` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 68 | `accounting/company-documents` | POST/PUT/DELETE | ✅(withAuth) | ❌ | ❌ |
| 69 | `accounting/company-groups` | POST/PUT/DELETE | ✅(withAuth) | ❌ | ❌ |
| 70 | `accounting/company-invitations` | POST/DELETE | ✅ | ❌ | ❌ |
| 71 | `accounting/company-users` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 72 | `accounting/consolidation/companies` | POST/PUT | ✅ | ❌ | ❌ |
| 73 | `accounting/cost-centres` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 74 | `accounting/cost-centres-action` | POST | ✅ | ❌ | ❌ |
| 75 | `accounting/business-units` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 76 | `accounting/business-units-action` | POST | ✅ | ❌ | ❌ |

### SARS / Tax

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 77 | `accounting/sars/irp6` | POST/PUT | ✅ | ❌ | ❌ |
| 78 | `accounting/sars/sars-emp201` | POST/PUT | ✅ | ❌ | ❌ |
| 79 | `accounting/sars/sars-submissions` | POST/PUT | ✅ | ❌ | ❌ |
| 80 | `accounting/sars/sars-vat201` | POST/PUT | ✅ | ❌ | ❌ |
| 81 | `accounting/drc-vat` | POST/PUT | ✅ | ❌ | ❌ |
| 82 | `accounting/tax-directives` | POST/PUT | ✅ | ❌ | ❌ |

### Documents / Misc

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 83 | `accounting/documents` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 84 | `accounting/document-capture` | POST/PUT | ✅ | ❌ | ❌ |
| 85 | `accounting/document-capture-action` | POST | ✅ | ❌ | ❌ |
| 86 | `accounting/description-templates` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 87 | `accounting/udf-definitions` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 88 | `accounting/webhooks` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 89 | `accounting/approval-requests` | POST/PUT | ✅ | ❌ | ❌ |
| 90 | `accounting/approval-rules` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 91 | `accounting/soft-delete` | POST | ✅ | ❌ | ❌ |
| 92 | `accounting/data-archiving` | POST/DELETE | ✅ | ❌ | ❌ |
| 93 | `accounting/data-subject-rights` | POST | ✅ | ❌ | ❌ |
| 94 | `accounting/smart-categorize` | POST | ✅ | ❌ | ❌ |
| 95 | `accounting/recurring-journals` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 96 | `accounting/recurring-journals-action` | POST | ✅ | ❌ | ❌ |
| 97 | `accounting/recurring-transactions` | POST/PUT/DELETE | ✅ | ❌ | ❌ |
| 98 | `accounting/intercompany-transactions` | POST | ✅(withAuth) | ❌ | ❌ |
| 99 | `accounting/page-visits` | POST | ✅ | ❌ | ❌ |
| 100 | `accounting/widget-layout` | POST/PUT | ✅ | ❌ | ❌ |
| 101 | `accounting/cache-stats` | POST | ✅ | ❌ | ❌ |

### Bank Feeds

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 102 | `accounting/bank-feeds/index` | POST | ✅ | ❌ | ❌ |
| 103 | `accounting/bank-feeds/[id]` | DELETE | ✅ | ❌ | ❌ |
| 104 | `accounting/bank-feeds/[id]/sync` | POST | ✅ | ❌ | ❌ |
| 105 | `bank-feeds/connections` | POST | ✅ | ❌ | ❌ |

### Migration / Admin

| # | Route | Methods | withCompany | withCsrf | Zod |
|---|-------|---------|-------------|----------|-----|
| 106 | `accounting/migration/sage-pull` | POST | ✅ | ❌ | ❌ |
| 107 | `accounting/migration/session` | POST/DELETE | ✅ | ❌ | ❌ |
| 108 | `accounting/sage-migration-action` | POST | ✅ | ✅(Zod only) | ✅ |

### Portal (Public / Token-gated)

| # | Route | Methods | withCompany | withCsrf | Zod | Notes |
|---|-------|---------|-------------|----------|-----|-------|
| 109 | `portal/payment-link` | POST | ❌(withAuth) | ❌ | ❌ | Creates payment links |
| 110 | `portal/invoice/[token]` | POST | ❌(public) | ❌ | ❌ | Generates tokens (public) |

### Admin Routes (withAdmin — custom CSRF via X-Admin-Request header)

All 26 admin routes use `withAdmin` which enforces `X-Admin-Request: true` header as CSRF mitigation and `super_admin` role. No Zod validation on any admin routes.

| # | Route | Methods | withAdmin | Custom-CSRF | Zod |
|---|-------|---------|-----------|-------------|-----|
| 111 | `admin/alert-settings` | PATCH | ✅ | ✅(header) | ❌ |
| 112 | `admin/announcements` | POST/PUT/DELETE | ✅ | ✅(header) | ❌ |
| 113 | `admin/announcements/[id]` | PUT/DELETE | ✅ | ✅(header) | ❌ |
| 114 | `admin/billing/invoices` | POST/PUT | ✅ | ✅(header) | ❌ |
| 115 | `admin/billing/invoices/[id]/mark-paid` | POST | ✅ | ✅(header) | ❌ |
| 116 | `admin/billing/invoices/[id]/send` | POST | ✅ | ✅(header) | ❌ |
| 117 | `admin/billing/plans` | POST/PUT/DELETE | ✅ | ✅(header) | ❌ |
| 118 | `admin/billing/plans/[id]` | PUT/DELETE | ✅ | ✅(header) | ❌ |
| 119 | `admin/billing/subscriptions` | POST | ✅ | ✅(header) | ❌ |
| 120 | `admin/billing/subscriptions/[id]` | PUT/PATCH | ✅ | ✅(header) | ❌ |
| 121 | `admin/billing/subscriptions/[id]/cancel` | POST | ✅ | ✅(header) | ❌ |
| 122 | `admin/companies/[id]` | PUT/PATCH | ✅ | ✅(header) | ❌ |
| 123 | `admin/companies/[id]/activate` | POST | ✅ | ✅(header) | ❌ |
| 124 | `admin/companies/[id]/features` | POST/DELETE | ✅ | ✅(header) | ❌ |
| 125 | `admin/companies/[id]/suspend` | POST | ✅ | ✅(header) | ❌ |
| 126 | `admin/features/[id]` | PUT/DELETE | ✅ | ✅(header) | ❌ |
| 127 | `admin/job-queue` | POST | ✅ | ✅(header) | ❌ |
| 128 | `admin/settings` | POST/PUT | ✅ | ✅(header) | ❌ |
| 129 | `admin/trials` | POST/PUT | ✅ | ✅(header) | ❌ |
| 130 | `admin/users/[id]` | PUT/PATCH | ✅ | ✅(header) | ❌ |
| 131 | `admin/users/[id]/activate` | POST | ✅ | ✅(header) | ❌ |
| 132 | `admin/users/[id]/add-to-company` | POST | ✅ | ✅(header) | ❌ |
| 133 | `admin/users/[id]/force-logout` | POST | ✅ | ✅(header) | ❌ |
| 134 | `admin/users/[id]/remove-from-company` | POST | ✅ | ✅(header) | ❌ |
| 135 | `admin/users/[id]/reset-onboarding` | POST | ✅ | ✅(header) | ❌ |
| 136 | `admin/users/[id]/reset-password` | POST | ✅ | ✅(header) | ❌ |
| 137 | `admin/users/[id]/suspend` | POST | ✅ | ✅(header) | ❌ |
| 138 | `admin/webhooks/[id]` | PUT/DELETE | ✅ | ✅(header) | ❌ |

---

## Gaps Summary by Severity

### P0 — 21 money-moving routes missing withCsrf

**Highest risk — must fix before next pentest:**

1. `accounting/journal-entries` — POST creates journal entries without CSRF
2. `accounting/credit-notes` — POST creates credit notes without CSRF
3. `accounting/supplier-invoices` — POST creates supplier invoices without CSRF
4. `accounting/supplier-invoices-detail` — PUT/PATCH modifies supplier invoices without CSRF
5. `accounting/supplier-credit-notes` — POST creates supplier credit notes without CSRF
6. `accounting/customer-allocations` — POST creates customer allocations without CSRF
7. `accounting/supplier-allocations` — POST creates supplier allocations without CSRF
8. `accounting/bank-reconciliations` — POST creates reconciliations without CSRF
9. `accounting/batch-payments` — POST creates batch payments without CSRF
10. `accounting/write-offs` — POST creates write-offs without CSRF
11. `accounting/vat-adjustments` — POST creates VAT adjustments without CSRF
12. `accounting/adjustments` — POST creates adjustments without CSRF
13. **`accounting/year-end`** — POST triggers year-end close without CSRF (CRITICAL)
14. `accounting/opening-balances` — POST sets opening balances without CSRF
15. `accounting/payment-gateway` — POST/PUT configures payment gateway without CSRF
16. `accounting/batch-payments-action` — POST approve/process without CSRF
17. `accounting/bank-reconciliations-action` — POST reconcile/undo without CSRF
18. `accounting/customer-payments-action` — POST approve/reverse without CSRF
19. `accounting/supplier-payments-action` — POST approve/reverse without CSRF
20. `accounting/vat-adjustments-action` — POST submit/undo without CSRF
21. `accounting/adjustments-action` — POST approve/reverse without CSRF

### P1 — 8 auth-sensitive routes missing Zod (BL-33 partial)

1. `auth/2fa-disable` — no input validation
2. `auth/2fa-setup` — no input validation on TOTP secret delivery
3. `auth/2fa-verify` — public endpoint, no input validation
4. `auth/2fa-verify-setup` — no input validation
5. `auth/change-password` — no password strength/format validation
6. `auth/profile` — no validation on PUT body
7. `auth/preferences` — no validation on preference key/value
8. `invite/[token]` — no validation on POST accept body

### P2 — 101 non-money routes missing withCsrf

All accounting CRUD routes not in P0, payroll routes, company management, SARS routes, portal routes. Full list in Per-route Classification above.

### Admin routes — Acceptable risk (custom CSRF pattern)

The 26 `pages/api/admin/` routes use `withAdmin` which enforces `X-Admin-Request: true` header check on all mutating methods. This is a valid lightweight CSRF mitigation for an admin-only, same-origin API. No standard `withCsrf` needed but **Zod validation is missing on all 26 admin routes** (tracked as P2).

---

## Clean Sample

Routes demonstrating correct controls (withCompany + withCsrf + Zod):

```
pages/api/accounting/bank-transactions-action.ts  — withCompany + withCsrf + z.object (BL-22/BL-33)
pages/api/accounting/customer-payments.ts         — withCompany + withCsrf + z.object (BL-22/BL-33)
pages/api/accounting/supplier-payments.ts         — withCompany + withCsrf + z.object (BL-22/BL-33)
pages/api/accounting/customer-invoices-detail.ts  — withCompany + withCsrf + z.object (BL-22/BL-33)
pages/api/accounting/journal-entries-action.ts    — withCompany + withCsrf + z.object (BL-22/BL-33)
```

---

## Recommended Remediation Order

1. **BL-34 (P0):** Apply `withCsrf` to the 21 money-moving routes above — year-end first.
2. **BL-35 (P1):** Apply Zod schemas to 8 auth-sensitive routes (2FA, change-password, profile, preferences, invite).
3. **BL-36 (P2):** Batch-apply `withCsrf` to remaining 101 non-money routes; Zod for all admin routes.
4. **BL-37 (P2):** Add Zod to all 21 P0 routes once CSRF is applied (combine with BL-34 for efficiency).
