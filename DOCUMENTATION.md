# ISAFlow Accounting - Complete Documentation

**Version:** 0.1.0
**Last Updated:** 2026-03-27
**Platform:** Next.js 14.2.18 | TypeScript 5.2.0 | PostgreSQL (Neon Serverless)
**URL:** https://app.isaflow.co.za
**Port:** 3101 (local development)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Technology Stack](#2-technology-stack)
3. [Architecture](#3-architecture)
4. [Authentication & Security](#4-authentication--security)
5. [Module Reference](#5-module-reference)
   - [General Ledger](#51-general-ledger)
   - [Accounts Receivable (Customers)](#52-accounts-receivable-customers)
   - [Accounts Payable (Suppliers)](#53-accounts-payable-suppliers)
   - [Banking & Reconciliation](#54-banking--reconciliation)
   - [Inventory & Items](#55-inventory--items)
   - [VAT & Tax Compliance](#56-vat--tax-compliance)
   - [SARS Compliance](#57-sars-compliance)
   - [Financial Reports](#58-financial-reports)
   - [Payroll](#59-payroll)
   - [Document Capture](#510-document-capture)
   - [Approval Workflows](#511-approval-workflows)
   - [Customer Portal](#512-customer-portal)
   - [Bank Feeds](#513-bank-feeds)
   - [Sage Migration](#514-sage-migration)
6. [Navigation Structure](#6-navigation-structure)
7. [API Reference](#7-api-reference)
8. [Database Schema](#8-database-schema)
9. [Services Reference](#9-services-reference)
10. [Components Reference](#10-components-reference)
11. [Configuration & Deployment](#11-configuration--deployment)
12. [Design Patterns](#12-design-patterns)

---

## 1. Overview

ISAFlow is a standalone, production-grade accounting system built for South African businesses. It provides a full double-entry general ledger, accounts receivable/payable management, bank reconciliation with smart categorisation, payroll with SARS tax compliance, VAT returns, financial reporting, and a customer self-service portal.

### Key Capabilities

- **Double-entry General Ledger** with hierarchical chart of accounts
- **Accounts Receivable** - customer invoicing, receipts, credit notes, statements, write-offs, dunning
- **Accounts Payable** - supplier invoices with 3-way matching, payments, batch payments, returns
- **Bank Reconciliation** - multi-format statement import (FNB, Standard Bank, Nedbank, ABSA, Capitec, OFX, QIF, PDF), auto-matching with confidence scoring, categorisation rules
- **Smart Categorisation** - AI/pattern-based transaction categorisation with 50+ pre-seeded SA merchant patterns
- **VAT Compliance** - standard/zero-rated/exempt/DRC VAT, adjustments, VAT201 returns
- **SARS Integration** - VAT201, EMP201, compliance calendar, submission tracking
- **Payroll** - SA PAYE, UIF, SDL calculations, payslip generation, GL auto-posting
- **Financial Reports** - Income Statement, Balance Sheet, Cash Flow, Trial Balance, Budget vs Actual, Project Profitability, Aging Reports, Audit Trail
- **Multi-currency** support with exchange rate management
- **Cost Centres & Business Units** for dimensional reporting
- **Budgets** with period-level breakdown and variance analysis
- **Recurring Invoices & Journals** with scheduled auto-generation
- **Document Capture** - OCR-based receipt/invoice scanning with data extraction
- **Approval Workflows** - configurable rules by document type and amount threshold
- **Customer Portal** - self-service access to invoices, statements, and payment links
- **Bank Feed Integration** via Stitch.money OAuth
- **Sage Migration** - import chart of accounts, transactions, invoices from Sage
- **PDF Generation** - invoices, credit notes, payslips, statements, reconciliation reports
- **Email Delivery** - invoice emailing with PDF attachments via SMTP

---

## 2. Technology Stack

### Frontend
| Technology | Version | Purpose |
|---|---|---|
| Next.js | 14.2.18 | React framework (standalone output mode) |
| React | 18.2.0 | UI library |
| TypeScript | 5.2.0 | Type safety |
| Tailwind CSS | 3.4.17 | Utility-first styling with dark mode |
| Recharts | 3.6.0 | Financial charts and dashboards |
| Lucide React | 0.279.0 | Icon library |
| React Hook Form | 7.45.0 | Form state management |
| React Hot Toast / Sonner | 2.6.0 / 2.0.7 | Notification system |
| Radix UI | Various | Accessible select/slot components |
| class-variance-authority | 0.7.1 | Component variant styling |

### Backend
| Technology | Version | Purpose |
|---|---|---|
| Neon Serverless | 1.0.1 | PostgreSQL with connection pooling |
| pg | 8.20.0 | PostgreSQL client |
| jose | 6.1.3 | JWT token management |
| bcryptjs | 3.0.3 | Password hashing |
| Zod | 3.22.0 | Schema validation |
| Nodemailer | 8.0.4 | Email delivery |
| Formidable | 3.5.4 | File upload handling |

### Documents & Data
| Technology | Version | Purpose |
|---|---|---|
| jsPDF | 4.2.0 | PDF generation |
| jspdf-autotable | 5.0.7 | PDF table formatting |
| PapaParse | 5.5.3 | CSV parsing |
| pdf-parse | 2.4.5 | PDF text extraction |
| JSZip | 3.10.1 | File compression |

### Testing & Tooling
| Technology | Version | Purpose |
|---|---|---|
| Playwright | 1.58.2 | E2E testing |
| ESLint | 8.48.0 | Code linting |
| Bun | - | Package manager & runtime |

---

## 3. Architecture

### Application Structure

```
pages/                          # Next.js page routes
  accounting/                   # All accounting UI pages (~98 pages)
  payroll/                      # Payroll UI pages (6 pages)
  portal/                       # Customer portal (1 page)
  api/                          # API routes (serverless functions)
    accounting/                 # Accounting APIs (~137 endpoints)
    payroll/                    # Payroll APIs (6 endpoints)
    portal/                     # Portal APIs (4 endpoints)
    bank-feeds/                 # Bank feed APIs (3 endpoints)
    auth/                       # Login/logout (2 endpoints)

src/
  components/
    accounting/                 # Accounting-specific components (13 files)
    layout/                     # App layout & navigation (2 files)
    ui/                         # Shared UI components (1 file)
    dashboard/                  # Dashboard widgets (1 file)
  lib/                          # Core infrastructure
    neon.ts                     # Database client with pooling & transactions
    logger.ts                   # Structured logging (no console.log)
    apiResponse.ts              # Standardised API response helpers
    api-error-handler.ts        # Error handling middleware
  modules/
    accounting/
      services/                 # Business logic services (~30 files)
      types/                    # TypeScript type definitions (5 files)
      utils/                    # Utility functions (10+ files)
    payroll/                    # Payroll module (3 files)
  utils/                        # Shared utilities
    formatters.ts               # Currency/date formatting (ZAR)
    toast.tsx                   # Notification helpers

scripts/
  deploy.sh                     # Deployment to Velocity server
  migrations/                   # Database migration SQL files (19 files)
```

### Data Flow

```
Browser → Next.js Pages → API Routes → Services → Neon PostgreSQL
                ↓                          ↓
          React Components          GL Cross-Module Hooks
                ↓                    (auto-journal creation)
          Recharts / jsPDF
```

### Key Architectural Decisions

1. **Standalone Output** - `output: standalone` in Next.js config for self-contained deployment
2. **Serverless Database** - Neon PostgreSQL with WebSocket transport and connection pooling
3. **Cookie-based Auth** - JWT tokens via `ff_auth_token` cookie, verified by edge middleware
4. **Zero-Tolerance Logging** - Structured logger singleton, no `console.log` allowed
5. **GL Cross-Module Hooks** - All transactional modules auto-post journal entries to the GL
6. **Dark/Light Theme** - CSS variable-based theming with Tailwind class toggle

---

## 4. Authentication & Security

### Login Flow
1. User submits email + password on `/login`
2. API verifies credentials with bcrypt hash comparison
3. JWT token set as `ff_auth_token` cookie
4. Middleware checks cookie on all `/accounting/*` routes
5. Unauthenticated requests redirect to `/login?returnTo=[path]`

### User Roles
| Role | Description |
|---|---|
| `super_admin` | Full system access |
| `admin` | Company-level administration |
| `manager` | Approve transactions, view reports |
| `accountant` | Full accounting operations |
| `bookkeeper` | Day-to-day transaction entry |
| `viewer` | Read-only access |
| `system` | Internal system operations |

### Security Headers
- `X-Frame-Options: DENY` (clickjacking protection)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- CORS whitelisting for `fin.fibreflow.app` + localhost in dev

---

## 5. Module Reference

### 5.1 General Ledger

The core accounting engine providing double-entry bookkeeping with hierarchical chart of accounts.

#### Features
- **Chart of Accounts** - Multi-level hierarchy (parent/child), account types (Asset, Liability, Equity, Revenue, Expense), subtypes (bank, receivable, payable, tax, inventory, fixed_asset, accumulated_depreciation, cost_of_sales), system vs. user-defined accounts
- **Journal Entries** - Manual and auto-generated entries, draft/posted/reversed status, balanced entry enforcement via database triggers, entry numbers auto-generated as `JE-YYYY-NNNNN`
- **Fiscal Periods** - Year/month management, status progression (open → closing → closed → locked)
- **Account Balances** - Cached per-period balances auto-updated on journal line changes
- **Cost Centres** - Dimensional allocation on journal lines
- **Business Units** - Additional dimensional tracking
- **Multi-Currency** - Currency definitions with exchange rates, ZAR base currency
- **Default Accounts** - Configurable default GL mappings for system operations
- **Opening Balances** - Initial balance entry for new financial years
- **Recurring Journals** - Scheduled auto-generation (weekly/monthly/quarterly/annually)
- **Depreciation** - Fixed asset depreciation calculations with auto-GL posting
- **Year-End** - Period closing process with retained earnings transfer

#### Pages
| Page | Path | Description |
|---|---|---|
| Dashboard | `/accounting` | Overview with KPI metrics, charts, tabbed navigation |
| Chart of Accounts | `/accounting/chart-of-accounts` | GL account tree with CRUD |
| Journal Entries | `/accounting/journal-entries` | List/filter entries by status, source, period |
| New Journal Entry | `/accounting/journal-entries/new` | Multi-line debit/credit entry form |
| Journal Entry Detail | `/accounting/journal-entries/[entryId]` | View/edit/post/reverse entry |
| Fiscal Periods | `/accounting/fiscal-periods` | Period lifecycle management |
| Cost Centres | `/accounting/cost-centres` | Cost centre CRUD |
| Business Units | `/accounting/business-units` | Business unit configuration |
| Default Accounts | `/accounting/default-accounts` | System GL account mappings |
| Currencies | `/accounting/currencies` | Currency and exchange rate management |
| Opening Balances | `/accounting/opening-balances` | Opening balance entry |
| Recurring Journals | `/accounting/recurring-journals` | Scheduled journal templates |
| Depreciation | `/accounting/depreciation` | Asset depreciation processing |
| Year-End | `/accounting/year-end` | Year-end closing |
| Adjustments | `/accounting/adjustments` | Period-end adjustments |
| Budgets | `/accounting/budgets` | Budget creation and tracking |
| Settings | `/accounting/accounting-settings` | Accounting configuration |
| Company Settings | `/accounting/company-settings` | Company details and preferences |

---

### 5.2 Accounts Receivable (Customers)

Full customer lifecycle from quoting through invoicing, receipts, allocations, credit notes, write-offs, and dunning.

#### Features
- **Customer Master Data** - Name, contact details, VAT number, billing/shipping addresses, payment terms, credit limits, categorisation
- **Customer Categories** - Grouping for reporting and analysis
- **Quotes** - Pre-sale quotation management
- **Tax Invoices** - Full invoicing with line items, GL account mapping per line, VAT calculation, status workflow (draft → pending_approval → approved → sent → partially_paid → paid → overdue → cancelled)
- **Recurring Invoices** - Scheduled auto-generation with configurable frequency
- **Customer Receipts (Payments)** - Record receipts via EFT/cheque/cash/card, auto-generated payment numbers (`CP-YYYY-NNNNN`), GL auto-posting
- **Payment Allocation** - Allocate receipts to specific invoices with over/under-payment tracking
- **Credit Notes** - Customer credit memos with status workflow (draft → approved → applied → cancelled), auto-generated numbers (`CN-YYYY-NNNNN`)
- **Write-Offs** - Bad debt write-offs with GL journal creation, auto-generated numbers (`WO-YYYY-NNNNN`)
- **Customer Statements** - Generate and email account statements
- **Statement Runs** - Bulk statement generation for all customers
- **Dunning** - Automated overdue payment follow-up management
- **Debtors Manager** - Dashboard for managing outstanding debts
- **AR Aging** - Age analysis with buckets (current, 30, 60, 90+ days)
- **Invoice PDF** - Server-side PDF generation with company branding, line items, payment terms, bank details
- **Invoice Email** - SMTP delivery with optional PDF attachment

#### Pages
| Page | Path | Description |
|---|---|---|
| Customer List | `/accounting/customers` | Browse, search, filter customers |
| New Customer | `/accounting/customers/new` | Customer creation form |
| Customer Categories | `/accounting/customer-categories` | Category management |
| Customer Invoices | `/accounting/customer-invoices` | Invoice list with status filtering |
| New Invoice | `/accounting/customer-invoices/new` | Multi-line invoice creation |
| Invoice Detail | `/accounting/customer-invoices/[invoiceId]` | View/edit/approve/email invoice |
| Customer Quotes | `/accounting/customer-quotes` | Quote management |
| Recurring Invoices | `/accounting/recurring-invoices` | Recurring invoice templates |
| Customer Payments | `/accounting/customer-payments` | Receipt list |
| New Payment | `/accounting/customer-payments/new` | Record customer receipt |
| Payment Detail | `/accounting/customer-payments/[paymentId]` | View/edit receipt |
| Customer Allocations | `/accounting/customer-allocations` | Allocate receipts to invoices |
| Credit Notes | `/accounting/credit-notes` | Credit note list |
| New Credit Note | `/accounting/credit-notes/new` | Create credit note |
| Credit Note Detail | `/accounting/credit-notes/[creditNoteId]` | View/edit credit note |
| Customer Credit Notes | `/accounting/customer-credit-notes` | Customer credit management |
| Write-Offs | `/accounting/write-offs` | Bad debt write-off management |
| Customer Statements | `/accounting/customer-statements` | Statement generation hub |
| Statement Detail | `/accounting/customer-statements/[clientId]` | Individual customer statement |
| Statement Run | `/accounting/statement-run` | Bulk statement generation |
| AR Aging | `/accounting/ar-aging` | Accounts receivable aging report |
| Customer Age Analysis | `/accounting/customer-age-analysis` | Detailed customer aging |
| Debtors Manager | `/accounting/debtors-manager` | Outstanding debt dashboard |
| Dunning | `/accounting/dunning` | Overdue payment management |

---

### 5.3 Accounts Payable (Suppliers)

Full supplier management with 3-way matching, batch payments, and allocation tracking.

#### Features
- **Supplier Master Data** - Name, contact details, VAT number, bank details (account, branch code, account type), categorisation
- **Supplier Categories** - Materials, Services, Equipment, Subcontractor, Utilities, Professional Services, Logistics, Other
- **Supplier Invoices** - AP invoice entry with line-level GL account mapping and VAT classification, 3-way matching (PO → GRN → Invoice), status workflow (draft → pending_approval → approved → partially_paid → paid → disputed → cancelled)
- **Supplier Payments** - Individual or batch payments via EFT/cheque/cash/card, auto-generated numbers (`SP-YYYY-NNNNN`), GL auto-posting
- **Batch Payments** - Process multiple supplier payments in one batch, auto-generated numbers (`BAT-YYYY-NNNNN`)
- **Payment Allocation** - Allocate payments to specific supplier invoices
- **Supplier Credit Notes** - Process credit notes from suppliers
- **Supplier Returns** - Track returned goods to suppliers
- **Supplier Statements** - Generate and reconcile supplier statements
- **AP Aging** - Age analysis with vendor breakdown (current, 30, 60, 90+ days)

#### Pages
| Page | Path | Description |
|---|---|---|
| Supplier List | `/accounting/suppliers` | Browse, search, filter suppliers |
| New Supplier | `/accounting/suppliers/new` | Supplier creation form |
| Supplier Categories | `/accounting/supplier-categories` | Category management |
| Supplier Invoices | `/accounting/supplier-invoices` | Invoice list with status/match filtering |
| New Supplier Invoice | `/accounting/supplier-invoices/new` | Multi-line AP invoice entry |
| Invoice Detail | `/accounting/supplier-invoices/[invoiceId]` | View/edit supplier invoice |
| Supplier Payments | `/accounting/supplier-payments` | Payment list |
| New Payment | `/accounting/supplier-payments/new` | Record supplier payment |
| Payment Detail | `/accounting/supplier-payments/[paymentId]` | View/edit payment |
| Batch Payments | `/accounting/batch-payments` | Batch payment list |
| New Batch | `/accounting/batch-payments/new` | Create batch payment |
| Batch Detail | `/accounting/batch-payments/[batchId]` | View/edit batch |
| Supplier Allocations | `/accounting/supplier-allocations` | Allocate payments to invoices |
| Supplier Credit Notes | `/accounting/supplier-credit-notes` | Supplier credit management |
| Supplier Returns | `/accounting/supplier-returns` | Return tracking |
| Supplier Statements | `/accounting/supplier-statements` | Statement reconciliation hub |
| Statement Detail | `/accounting/supplier-statements/[supplierId]` | Individual supplier statement |
| AP Aging | `/accounting/ap-aging` | Accounts payable aging report |
| Supplier Age Analysis | `/accounting/supplier-age-analysis` | Detailed supplier aging |

---

### 5.4 Banking & Reconciliation

Multi-format bank statement import with smart auto-matching, categorisation rules, and bank feed integration.

#### Features
- **Bank Accounts** - Setup and manage bank GL accounts
- **Bank Statement Import** - Supports 7+ formats:
  - FNB CSV
  - Standard Bank CSV
  - Nedbank CSV
  - ABSA CSV
  - Capitec CSV
  - OFX (Open Financial Exchange)
  - QIF (Quicken Interchange Format)
  - PDF bank statements
- **Bank Transactions** - View, filter, and manage imported transactions, status progression (imported → matched → reconciled → excluded)
- **Auto-Matching** - 4-tier matching strategy:
  - Tier 0: Rule-based matches (confidence 1.0)
  - Tier 1: Exact reference/description match (confidence 0.95-1.0)
  - Tier 2: Amount + date within 3 days (confidence 0.9)
  - Tier 3: Amount only match (confidence 0.7)
- **Categorisation Rules** - Create rules for automatic transaction categorisation with match types (contains, starts_with, regex), preview matching count
- **Smart Categorisation** - AI-powered categorisation using patterns, historical learning, and confidence scoring, 50+ pre-seeded SA merchant patterns (Woolworths, Engen, MTN, ESKOM, etc.)
- **Manual Allocation** - Inline allocation to GL accounts, suppliers, or customers with VAT code selection
- **Bank Reconciliation** - Reconciliation sessions with statement vs GL balance tracking, difference calculation, completion status
- **Split Transactions** - Split a single bank transaction across multiple GL accounts
- **Find Match** - Search for matching GL entries to link to bank transactions
- **Exclude Transactions** - Exclude with reason (Duplicate, Personal, Bank Fee, Transfer, Other)
- **Attachments** - Upload receipts/documents to bank transactions (JPG, PNG, PDF, max 2MB)
- **Bank Transfers** - Track inter-account transfers
- **Confidence Indicators** - Visual dots (green >= 85%, amber >= 60%, gray < 60%) for ML suggestions
- **Reconciliation Reports** - PDF generation of reconciliation status

#### Pages
| Page | Path | Description |
|---|---|---|
| Bank Accounts | `/accounting/bank-accounts` | Bank account setup |
| Bank Transactions | `/accounting/bank-transactions` | Transaction list with inline allocation |
| New Transaction | `/accounting/bank-transactions/new` | Manual bank transaction entry |
| Bank Reconciliation | `/accounting/bank-reconciliation` | Reconciliation session list |
| New Reconciliation | `/accounting/bank-reconciliation/new` | Start new reconciliation |
| Reconciliation Detail | `/accounting/bank-reconciliation/[reconId]` | View/complete reconciliation |
| Import Statement | `/accounting/bank-reconciliation/import` | Upload bank statement files |
| Mapping Rules | `/accounting/bank-reconciliation/rules` | Categorisation rule management |
| Bank Transfers | `/accounting/bank-transfers` | Inter-account transfer tracking |
| Bank Feeds | `/accounting/bank-feeds` | Bank feed connection management |
| Cashbook | `/accounting/cashbook` | Cashbook view |

---

### 5.5 Inventory & Items

Basic inventory tracking with opening balances, pricing, and stock adjustments.

#### Features
- **Item Opening Balances** - Set initial stock quantities and values
- **Item Pricing** - Manage selling prices
- **Item Adjustments** - Record stock adjustments with GL posting

#### Reports
- Item Listing, Sales by Item, Purchases by Item, Item Movement, Item Valuation, Item Quantities

#### Pages
| Page | Path | Description |
|---|---|---|
| Item Opening Balances | `/accounting/item-opening-balances` | Opening stock entry |
| Item Pricing | `/accounting/item-pricing` | Price management |
| Item Adjustments | `/accounting/item-adjustments` | Stock adjustments |

---

### 5.6 VAT & Tax Compliance

Comprehensive South African VAT handling with support for standard, zero-rated, exempt, DRC, and other VAT types.

#### Features
- **VAT Types** - standard (15%), zero_rated, exempt, capital_goods, export, imported, reverse_charge, bad_debt, no_vat
- **VAT on Journal Lines** - Every GL journal line tracks VAT type for SARS reporting
- **VAT Adjustments** - Input/output adjustments with categories (bad_debt, import, prior_period, change_in_use, other), approval workflow, auto-generated numbers (`VA-YYYY-NNNNN`)
- **DRC VAT** - Domestic Reverse Charge VAT compliance
- **VAT Return** - VAT201 return calculation and generation

#### Pages
| Page | Path | Description |
|---|---|---|
| VAT Adjustments | `/accounting/vat-adjustments` | VAT adjustment CRUD |
| DRC VAT | `/accounting/drc-vat` | Domestic Reverse Charge management |

---

### 5.7 SARS Compliance

South African Revenue Service integration for tax filing and compliance tracking.

#### Features
- **VAT201** - VAT return preparation and generation
- **EMP201** - Monthly employer tax return data
- **Submission Tracking** - Track submissions with status (draft → generated → submitted → accepted → rejected)
- **Compliance Calendar** - Due date tracking for VAT201, EMP201, EMP501, Provisional Tax
- **Compliance Events** - Automated pending/completed/overdue status tracking

#### Pages
| Page | Path | Description |
|---|---|---|
| SARS Hub | `/accounting/sars` | SARS compliance overview |
| VAT201 | `/accounting/sars/vat201` | VAT return preparation |
| EMP201 | `/accounting/sars/emp201` | Employee tax return |
| Submissions | `/accounting/sars/submissions` | Submission history |

---

### 5.8 Financial Reports

Comprehensive financial reporting with export capabilities and drill-down analysis.

#### Reports Available

| Report | Description | Export |
|---|---|---|
| **Income Statement** | Revenue, expenses, and profit/loss with period-over-period comparison | Yes |
| **Balance Sheet** | Assets, liabilities, and equity at a point in time | Yes |
| **Cash Flow Statement** | Cash inflows/outflows by operating, investing, financing activities | Yes |
| **Cash Flow Forecast** | Projected cash position based on outstanding invoices and payments | - |
| **Trial Balance** | Debit/credit totals per GL account with drill-down | Yes |
| **Budget vs Actual** | Budget variance analysis by GL account and period | Yes |
| **Project Profitability** | Revenue/cost/profit analysis by project | - |
| **General Ledger** | Detailed transaction listing per GL account | - |
| **Account Transactions** | Transaction detail with opening/closing balances | Yes |
| **Customer Reports** | Sales analysis, outstanding balances, payment history | Yes |
| **Supplier Reports** | Purchase analysis, outstanding balances, payment history | Yes |
| **Sales by Customer** | Revenue breakdown by customer | - |
| **Sales by Item** | Revenue breakdown by item | - |
| **Purchases by Supplier** | Cost breakdown by supplier | - |
| **Purchases by Item** | Cost breakdown by item | - |
| **Bank Transactions** | Bank transaction report with reconciliation status | - |
| **AR Aging** | Accounts receivable aging (current/30/60/90+ days) | Yes |
| **AP Aging** | Accounts payable aging (current/30/60/90+ days) | Yes |
| **VAT Return** | VAT201 calculation with input/output VAT breakdown | Yes |
| **Audit Trail** | Complete audit log of all system transactions | - |
| **Unallocated Receipts** | Customer payments not yet allocated to invoices | - |
| **Unallocated Payments** | Supplier payments not yet allocated to invoices | - |
| **Item Listing** | Complete item catalogue with details | - |
| **Item Movement** | Stock movement history | - |
| **Item Quantities** | Current stock levels | - |
| **Item Valuation** | Inventory value report | - |

#### Dashboard KPIs
- Revenue (current period)
- Expenses (current period)
- Net Profit / Profit Margin
- Cash Position
- Outstanding Receivables
- Outstanding Payables
- Recent Activity Metrics
- Trend Charts (line, bar, pie via Recharts)

---

### 5.9 Payroll

South African payroll processing with PAYE, UIF, and SDL calculations.

#### Features
- **Employee Management** - Master data (personal details, ID number, tax number, bank details), employment types (permanent/contract/temporary), department and position tracking, status management (active/inactive)
- **Pay Structures** - Basic salary + allowances (travel, housing, cell, other), deductions (medical aid, retirement fund, custom), effective date tracking for pay history
- **Payroll Runs** - Monthly batch processing, status workflow (draft → processing → completed → reversed), automatic tax calculations:
  - **PAYE** - Using SARS tax tables (2024-2025), age-based rebates extracted from ID number
  - **UIF** - 1% employee + 1% employer
  - **SDL** - 0.5% for payroll >= R500k/year
- **Payslips** - Per-employee breakdown with all earnings, deductions, and YTD totals
- **Payslip PDF** - Server-side PDF generation
- **GL Integration** - Auto-posts payroll journals to GL with expense account mapping

#### Pages
| Page | Path | Description |
|---|---|---|
| Employees | `/payroll/employees` | Employee list |
| New Employee | `/payroll/employees/new` | Employee creation |
| Employee Detail | `/payroll/employees/[employeeId]` | View/edit employee |
| Payroll Runs | `/payroll/runs` | Payroll run list |
| New Run | `/payroll/runs/new` | Create payroll run |
| Run Detail | `/payroll/runs/[runId]` | View/process run |

---

### 5.10 Document Capture

OCR-based document scanning and data extraction for invoices, receipts, and statements.

#### Features
- **Document Upload** - Support for PDF and image files
- **Data Extraction** - Pattern-based OCR extraction of:
  - Vendor name and VAT number
  - Document date and reference number
  - Line items with descriptions and amounts
  - Subtotal, VAT, and total amounts
  - Confidence scoring per extracted field
- **Document Matching** - Link captured documents to invoices or bank transactions
- **Status Workflow** - pending → reviewed → matched → rejected

#### Pages
| Page | Path | Description |
|---|---|---|
| Document Capture | `/accounting/document-capture` | Upload and view documents |
| Document Detail | `/accounting/document-capture/[docId]` | Review extracted data |

---

### 5.11 Approval Workflows

Configurable transaction approval system based on document type and amount thresholds.

#### Features
- **Approval Rules** - Configure by document type (customer_invoice, supplier_invoice, payment, journal_entry, credit_note), condition (amount greater than threshold or any), approver role assignment, priority ordering
- **Approval Requests** - Track status (pending → approved → rejected → cancelled), decision audit trail with notes
- **Document Types Supported** - Customer invoices, supplier invoices, payments, journal entries, credit notes

#### Pages
| Page | Path | Description |
|---|---|---|
| Approvals | `/accounting/approvals` | Pending approval queue |

---

### 5.12 Customer Portal

Self-service portal for customers to view invoices, statements, and make payments.

#### Features
- **Portal Authentication** - Separate credential system for customer access
- **Invoice Viewing** - Customers can view their invoices online
- **Statement Access** - View account statements
- **Payment Links** - Generate secure payment links with 30-day expiration, unique token-based URLs

#### Pages & APIs
| Endpoint | Description |
|---|---|
| `/portal` | Portal landing/login |
| `/api/portal/auth` | Portal authentication |
| `/api/portal/invoices` | Customer invoice list |
| `/api/portal/statement` | Customer statement data |
| `/api/portal/payment-link` | Generate payment link |

---

### 5.13 Bank Feeds

Automated bank transaction synchronisation via Stitch.money OAuth integration.

#### Features
- **Provider Support** - Stitch.money (primary), Investec (direct), manual import
- **OAuth Connection** - Connect/callback flow for bank account linking
- **Automatic Sync** - Incremental transaction fetching with cursor tracking
- **Sync Logging** - Audit trail of fetched/imported/skipped transaction counts
- **Connection Management** - Status tracking (pending, syncing, synced, error)

#### APIs
| Endpoint | Description |
|---|---|
| `/api/bank-feeds/connect` | Initiate bank connection |
| `/api/bank-feeds/connections` | Manage connections |
| `/api/bank-feeds/callback` | OAuth callback handler |

---

### 5.14 Sage Migration

Import tool for migrating data from Sage accounting software.

#### Features
- **Chart of Accounts Import** - Map Sage accounts to ISAFlow GL accounts
- **Ledger Transaction Import** - Convert Sage transactions to GL journal entries
- **Supplier Invoice Import** - Map Sage AP invoices
- **Customer Invoice Import** - Map Sage AR invoices
- **Migration Runs** - Track status (running/succeeded/failed/skipped) with counts
- **Reconciliation** - Pre/post-migration balance comparison

#### Pages
| Page | Path | Description |
|---|---|---|
| Sage Migration | `/accounting/sage-migration` | Migration tool |

---

## 6. Navigation Structure

The app uses a hierarchical tab-based navigation with 3-level flyout menus.

### Primary Tabs

1. **Dashboard** → `/accounting`
2. **Customers** → Customer lists, transactions (quotes, invoices, recurring invoices, receipts, credit notes, write-offs, allocations, adjustments), reports (sales, aging, statements, unallocated receipts), special (statement run, dunning, debtors manager)
3. **Suppliers** → Supplier lists, transactions (invoices, returns, payments, batch payments, allocations, adjustments), reports (purchases, aging, statements, unallocated payments)
4. **Items** → Transactions (adjustments, pricing), opening balances, reports (listing, sales/purchases by item, movement, valuation, quantities)
5. **Banking** → Bank accounts, transactions, import, reconcile, transfers, mapping rules, bank feeds
6. **Accounts** → Chart of accounts, default accounts, currencies, exchange rates, journal entries, recurring journals, fiscal periods
7. **VAT** → VAT return, VAT adjustments, DRC VAT
8. **Accountant's Area** → VAT section, management reports (income statement, balance sheet, trial balance, budget vs actual), transaction reports, audit tools, depreciation, year-end, cost centres, business units, budgets
9. **Reports** → Financial (income statement, balance sheet, cash flow, forecast), management (budget vs actual, project profitability, trial balance), transactional (customer, supplier, bank, account, VAT, audit trail)
10. **SARS** → VAT201, EMP201, compliance calendar, submission history
11. **Tools** → Document capture, approvals, company settings
12. **Data Import** → Sage migration
13. **Payroll** → Employees, payroll runs

---

## 7. API Reference

All API routes follow the pattern `/api/accounting/*` and return standardised responses.

### Response Format

```typescript
// Success
{ success: true, data: T }

// Error
{ success: false, error: { code: string, message: string, details?: any } }

// Paginated
{ success: true, data: T[], total: number, page: number, pageSize: number }
```

### Error Codes
`BAD_REQUEST` | `UNAUTHORIZED` | `FORBIDDEN` | `NOT_FOUND` | `VALIDATION_ERROR` | `RATE_LIMIT` | `DATABASE_ERROR` | `INTERNAL_ERROR` | `CONFLICT` | `METHOD_NOT_ALLOWED` | `TIMEOUT` | `SERVICE_UNAVAILABLE` | `UNPROCESSABLE` | `PAYLOAD_TOO_LARGE` | `TOO_MANY_REQUESTS`

### Core Endpoints (152+ total)

#### Authentication (2)
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/login` | Email/password authentication |
| POST | `/api/auth/logout` | Session termination |

#### General Ledger (20+)
| Method | Endpoint | Description |
|---|---|---|
| GET/POST | `/api/accounting/chart-of-accounts` | GL account CRUD |
| GET | `/api/accounting/chart-of-accounts-detail` | Account detail |
| GET/POST | `/api/accounting/journal-entries` | Journal entry CRUD |
| GET | `/api/accounting/journal-entries-detail` | Entry detail |
| POST | `/api/accounting/journal-entries-action` | Post/reverse entries |
| GET/POST | `/api/accounting/fiscal-periods` | Period management |
| POST | `/api/accounting/fiscal-periods-action` | Open/close/lock periods |
| GET/POST | `/api/accounting/cost-centres` | Cost centre CRUD |
| POST | `/api/accounting/cost-centres-action` | Cost centre actions |
| GET/POST | `/api/accounting/currencies` | Currency management |
| GET/POST | `/api/accounting/exchange-rates` | FX rate management |
| GET/POST | `/api/accounting/default-accounts` | Default GL mappings |
| GET/POST | `/api/accounting/opening-balances` | Opening balance entry |
| GET/POST | `/api/accounting/recurring-journals` | Recurring journal CRUD |
| POST | `/api/accounting/recurring-journals-action` | Generate/pause/cancel |
| GET/POST | `/api/accounting/budgets` | Budget CRUD |
| POST | `/api/accounting/budgets-action` | Budget actions |
| POST | `/api/accounting/run-depreciation` | Execute depreciation |
| GET/POST | `/api/accounting/year-end` | Year-end processing |
| GET/POST | `/api/accounting/adjustments` | Period adjustments |
| POST | `/api/accounting/adjustments-action` | Adjustment actions |
| GET/POST | `/api/accounting/accounting-settings` | Settings management |
| GET | `/api/accounting/companies` | Company list |
| GET | `/api/accounting/dashboard-stats` | Dashboard KPIs |
| GET | `/api/accounting/kpi-dashboard` | Extended KPI data |

#### Accounts Receivable (25+)
| Method | Endpoint | Description |
|---|---|---|
| GET/POST | `/api/accounting/customers` | Customer CRUD |
| GET/POST | `/api/accounting/customer-categories` | Category CRUD |
| GET | `/api/accounting/customer-invoices-list` | Invoice list |
| POST | `/api/accounting/customer-invoices-create` | Create invoice |
| GET | `/api/accounting/customer-invoices-detail` | Invoice detail |
| GET | `/api/accounting/customer-invoices-gl` | Invoice GL impact |
| GET/POST | `/api/accounting/customer-payments` | Payment CRUD |
| POST | `/api/accounting/customer-payments-action` | Confirm/reconcile/cancel |
| GET/POST | `/api/accounting/customer-allocations` | Allocate receipts |
| GET/POST | `/api/accounting/credit-notes` | Credit note CRUD |
| POST | `/api/accounting/credit-notes-action` | Approve/apply/cancel |
| GET/POST | `/api/accounting/customer-quotes` | Quote CRUD |
| POST | `/api/accounting/customer-quotes-action` | Accept/reject quotes |
| GET/POST | `/api/accounting/customer-statements` | Statement generation |
| GET | `/api/accounting/customer-statement-detail` | Statement data |
| GET/POST | `/api/accounting/recurring-invoices` | Recurring invoice CRUD |
| POST | `/api/accounting/recurring-invoices-action` | Generate/pause/cancel |
| GET/POST | `/api/accounting/dunning` | Dunning management |
| GET/POST | `/api/accounting/write-offs` | Write-off CRUD |
| POST | `/api/accounting/write-offs-action` | Approve/cancel |
| GET | `/api/accounting/ar-aging` | AR aging report |
| POST | `/api/accounting/invoice-pdf` | Generate invoice PDF |
| POST | `/api/accounting/credit-note-pdf` | Generate credit note PDF |
| POST | `/api/accounting/invoice-email` | Email invoice |

#### Accounts Payable (20+)
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/accounting/suppliers-list` | Supplier list |
| GET/POST | `/api/accounting/suppliers` | Supplier CRUD |
| GET/POST | `/api/accounting/supplier-categories` | Category CRUD |
| GET/POST | `/api/accounting/supplier-invoices` | Invoice CRUD |
| GET | `/api/accounting/supplier-invoices-detail` | Invoice detail |
| POST | `/api/accounting/supplier-invoices-action` | Approve/dispute/cancel |
| GET/POST | `/api/accounting/supplier-payments` | Payment CRUD |
| POST | `/api/accounting/supplier-payments-action` | Approve/process |
| GET/POST | `/api/accounting/supplier-allocations` | Allocate payments |
| GET/POST | `/api/accounting/batch-payments` | Batch payment CRUD |
| POST | `/api/accounting/batch-payments-action` | Approve/process batch |
| GET | `/api/accounting/supplier-statements` | Statement generation |
| GET | `/api/accounting/supplier-statement-detail` | Statement data |
| GET/POST | `/api/accounting/supplier-returns` | Return tracking |
| GET | `/api/accounting/ap-aging` | AP aging report |
| GET | `/api/accounting/debtors-manager` | Debtor management |

#### Banking (20+)
| Method | Endpoint | Description |
|---|---|---|
| GET/POST | `/api/accounting/bank-accounts` | Bank account setup |
| GET/POST | `/api/accounting/bank-transactions` | Transaction list |
| POST | `/api/accounting/bank-transactions-action` | Match/reconcile/exclude |
| POST | `/api/accounting/bank-transactions-import` | Import from bank feed |
| POST | `/api/accounting/bank-transactions-import-classified` | Pre-classified import |
| POST | `/api/accounting/bank-transactions-manual` | Manual entry |
| GET/POST | `/api/accounting/bank-tx-attachments` | Transaction attachments |
| GET/POST | `/api/accounting/bank-reconciliations` | Reconciliation CRUD |
| POST | `/api/accounting/bank-reconciliations-action` | Complete/cancel recon |
| GET | `/api/accounting/bank-reconciliation-report` | Reconciliation report |
| GET | `/api/accounting/bank-import-batches` | Import batch list |
| GET/POST | `/api/accounting/bank-rules` | Rule CRUD |
| POST | `/api/accounting/bank-rules-action` | Activate/deactivate rules |
| GET | `/api/accounting/bank-rules-preview` | Preview rule matches |
| POST | `/api/accounting/bank-rules-seed` | Seed default rules |
| GET | `/api/accounting/bank-match-candidates` | Match suggestions |
| POST | `/api/accounting/bank-match-confirm` | Confirm match |
| POST | `/api/accounting/bank-match-asset` | Asset-related match |
| POST | `/api/accounting/bank-match-fleet` | Fleet-related match |
| GET/POST | `/api/accounting/bank-transfers` | Transfer tracking |
| POST | `/api/accounting/smart-categorize` | AI categorisation |

#### Financial Reports (20+)
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/accounting/reports-trial-balance` | Trial balance |
| GET | `/api/accounting/reports-balance-sheet` | Balance sheet |
| GET | `/api/accounting/reports-income-statement` | Income statement |
| GET | `/api/accounting/reports-cash-flow` | Cash flow |
| GET | `/api/accounting/reports-budget-vs-actual` | Budget comparison |
| GET | `/api/accounting/reports-customer` | Customer reports |
| GET | `/api/accounting/reports-supplier` | Supplier reports |
| GET | `/api/accounting/reports-account-transactions` | Account GL detail |
| GET | `/api/accounting/reports-bank-transactions` | Bank transaction report |
| GET | `/api/accounting/reports-audit-trail` | Audit report |
| GET | `/api/accounting/reports-vat-return` | VAT report |
| GET | `/api/accounting/reports-project-profitability` | Project profitability |
| GET | `/api/accounting/reports/item-listing` | Item listing |
| GET | `/api/accounting/reports/item-movement` | Item movement |
| GET | `/api/accounting/reports/item-quantities` | Item quantities |
| GET | `/api/accounting/reports/item-valuation` | Inventory valuation |
| GET | `/api/accounting/reports/purchases-by-item` | Purchases by item |
| GET | `/api/accounting/reports/purchases-by-supplier` | Purchases by supplier |
| GET | `/api/accounting/reports/sales-by-customer` | Sales by customer |
| GET | `/api/accounting/reports/sales-by-item` | Sales by item |
| GET | `/api/accounting/cash-flow-forecast` | Cash flow forecast |

#### Export Endpoints (15+)
| Endpoint | Format |
|---|---|
| `/api/accounting/trial-balance-export` | CSV/Excel |
| `/api/accounting/balance-sheet-export` | CSV/Excel |
| `/api/accounting/income-statement-export` | CSV/Excel |
| `/api/accounting/cash-flow-export` | CSV/Excel |
| `/api/accounting/budget-vs-actual-export` | CSV/Excel |
| `/api/accounting/account-transactions-export` | CSV/Excel |
| `/api/accounting/ar-aging-export` | CSV/Excel |
| `/api/accounting/ap-aging-export` | CSV/Excel |
| `/api/accounting/customer-invoices-export` | CSV/Excel |
| `/api/accounting/customer-payments-export` | CSV/Excel |
| `/api/accounting/customer-allocations-export` | CSV/Excel |
| `/api/accounting/customer-report-export` | CSV/Excel |
| `/api/accounting/supplier-report-export` | CSV/Excel |
| `/api/accounting/bank-transactions-export` | CSV/Excel |
| `/api/accounting/cost-centres-export` | CSV/Excel |
| `/api/accounting/opening-balances-export` | CSV/Excel |
| `/api/accounting/vat-adjustments-export` | CSV/Excel |
| `/api/accounting/vat-return-export` | CSV/Excel |
| `/api/accounting/drc-vat-export` | CSV/Excel |
| `/api/accounting/depreciation-export` | CSV/Excel |
| `/api/accounting/year-end-export` | CSV/Excel |

---

## 8. Database Schema

### Tables Summary (60+)

#### Authentication & Users
| Table | Purpose |
|---|---|
| `users` | System user accounts with roles and permissions |
| `user_sessions` | Active JWT sessions with expiry |
| `user_permissions` | Granular resource/action permission grants |

#### Master Data
| Table | Purpose |
|---|---|
| `customers` | Customer master data (AR) |
| `suppliers` | Supplier master data (AP) |
| `companies` | Multi-entity company definitions |
| `company_users` | User-to-company role mappings |
| `currencies` | Currency definitions with exchange rates |
| `cost_centres` | Cost centre definitions |

#### General Ledger
| Table | Purpose |
|---|---|
| `gl_accounts` | Chart of accounts (hierarchical) |
| `gl_journal_entries` | Journal entry headers |
| `gl_journal_lines` | Journal entry line items (debit/credit) |
| `gl_account_balances` | Cached period balances |
| `fiscal_periods` | Fiscal year/period management |
| `accounting_budgets` | Budget data per GL account |

#### Accounts Receivable
| Table | Purpose |
|---|---|
| `customer_invoices` | Customer tax invoices |
| `customer_invoice_items` | Invoice line items |
| `customer_payments` | Customer receipts |
| `customer_payment_allocations` | Receipt-to-invoice allocation |
| `credit_notes` | Customer & supplier credit notes (polymorphic) |
| `customer_write_offs` | Bad debt write-offs |
| `recurring_invoices` | Recurring invoice templates |

#### Accounts Payable
| Table | Purpose |
|---|---|
| `supplier_invoices` | Supplier invoices with 3-way matching |
| `supplier_invoice_items` | Invoice line items with VAT classification |
| `supplier_payments` | Supplier payments |
| `payment_allocations` | Payment-to-invoice allocation |
| `supplier_payment_batches` | Batch payment processing |
| `recurring_journals` | Recurring journal templates |

#### Banking
| Table | Purpose |
|---|---|
| `bank_reconciliations` | Reconciliation sessions |
| `bank_transactions` | Imported/matched bank transactions |
| `bank_categorisation_rules` | Auto-categorisation rules |
| `bank_feed_connections` | OAuth bank feed connections |
| `bank_feed_sync_log` | Sync operation audit trail |
| `categorization_patterns` | Smart categorisation patterns (50+ SA merchants) |

#### Adjustments
| Table | Purpose |
|---|---|
| `accounting_adjustments` | Customer/supplier debit/credit adjustments |
| `vat_adjustments` | VAT input/output adjustments |

#### Tax & Compliance
| Table | Purpose |
|---|---|
| `sars_submissions` | SARS form submissions (VAT201, EMP201, etc.) |
| `sars_compliance_events` | Compliance deadline tracking |

#### Payroll
| Table | Purpose |
|---|---|
| `employees` | Employee master data |
| `pay_structures` | Salary/allowance/deduction definitions |
| `payroll_runs` | Monthly payroll batch processing |
| `payslips` | Individual payslip calculations |

#### Document Capture
| Table | Purpose |
|---|---|
| `captured_documents` | Scanned documents with OCR data |

#### Approvals
| Table | Purpose |
|---|---|
| `approval_rules` | Configurable approval workflow rules |
| `approval_requests` | Approval request tracking |

#### Customer Portal
| Table | Purpose |
|---|---|
| `portal_access` | Customer portal credentials |
| `portal_payment_links` | Secure payment links (30-day expiry) |

#### Migration
| Table | Purpose |
|---|---|
| `sage_accounts` | Imported Sage COA cache |
| `sage_ledger_transactions` | Imported Sage transactions |
| `sage_supplier_invoices` | Imported Sage AP invoices |
| `sage_customer_invoices` | Imported Sage AR invoices |
| `gl_migration_runs` | Migration execution tracking |
| `gl_migration_comparisons` | Pre/post-migration reconciliation |

### Auto-Generated Document Numbers
| Format | Document Type |
|---|---|
| `JE-YYYY-NNNNN` | Journal entries |
| `CP-YYYY-NNNNN` | Customer payments |
| `SP-YYYY-NNNNN` | Supplier payments |
| `CN-YYYY-NNNNN` | Credit notes |
| `WO-YYYY-NNNNN` | Write-offs |
| `ADJ-YYYY-NNNNN` | Adjustments |
| `VA-YYYY-NNNNN` | VAT adjustments |
| `BAT-YYYY-NNNNN` | Batch payments |

### Database Triggers
| Trigger | Purpose |
|---|---|
| `trg_gl_je_entry_number` | Auto-generate journal entry numbers |
| `trg_gl_je_balanced` | Enforce balanced entries on posting |
| `trg_gl_jl_balance_update` | Auto-update account balances on line changes |
| Various `generate_*_number()` | Auto-generate document numbers |
| `update_updated_at_column()` | Maintain updated_at timestamps |

---

## 9. Services Reference

### Core Infrastructure Services

| Service | File | Purpose |
|---|---|---|
| Database Client | `src/lib/neon.ts` | Neon PostgreSQL with connection pooling, WebSocket transport, transactions (ReadCommitted), retry logic (exponential backoff) |
| Logger | `src/lib/logger.ts` | Structured logging singleton (debug/info/warn/error), component-scoped via `createLogger()`, Pino-style API |
| API Response | `src/lib/apiResponse.ts` | Standardised success/error/paginated responses, CORS handling, request/response logging |
| Error Handler | `src/lib/api-error-handler.ts` | Error classification, HTTP status mapping, dev/prod error detail masking |

### Accounting Services

| Service | File | Key Functions |
|---|---|---|
| Chart of Accounts | `chartOfAccountsService.ts` | CRUD, hierarchical tree, account codes, VAT defaults |
| Journal Entries | `journalEntryService.ts` | Create/post/reverse, double-entry validation, status filtering |
| Fiscal Periods | `fiscalPeriodService.ts` | Year/month management, status lifecycle |
| Cost Centres | `costCentreService.ts` | Cost centre definitions and allocation |
| Adjustments | `adjustmentService.ts` | Ad-hoc GL adjustments with approval |
| Customer Payments | `customerPaymentService.ts` | Receipt entry, allocation, GL posting |
| AR Aging | `arAgingService.ts` | Age analysis with date bucketing |
| Recurring Invoices | `recurringInvoiceService.ts` | Scheduled invoice generation |
| Write-Offs | `writeOffService.ts` | Bad debt write-offs, GL journal creation |
| Credit Notes | `creditNoteService.ts` | Credit memo creation and application |
| Supplier Invoices | `supplierInvoiceService.ts` | AP entry, 3-way matching, VAT classification |
| Supplier Payments | `supplierPaymentService.ts` | Payment batching, GL posting |
| AP Aging | `apAgingService.ts` | AP aging with vendor analysis |
| Batch Payments | `batchPaymentService.ts` | Multi-invoice payment processing |
| Bank Reconciliation | `bankReconciliationService.ts` | Multi-format import, auto-matching |
| Bank Feeds | `bankFeedService.ts` | Stitch.money OAuth integration |
| Bank Rules | `bankRulesService.ts` | Categorisation rule engine |
| Smart Categorisation | `smartCategorizationService.ts` | AI-powered categorisation, confidence scoring |
| Financial Reporting | `financialReportingService.ts` | P&L, Balance Sheet, VAT Return, Project Profitability |
| Transaction Reporting | `transactionReportingService.ts` | Ledger detail reports |
| Cash Flow Forecast | `cashFlowForecastService.ts` | Cash flow projections |
| KPI Service | `kpiService.ts` | Dashboard KPIs and metrics |
| Invoice PDF | `invoicePdfService.ts` | PDF generation (jsPDF) with branding |
| OCR Service | `ocrService.ts` | Pattern-based document data extraction |
| Portal Service | `portalService.ts` | Customer portal access and delivery |
| SARS Service | `sarsService.ts` | VAT return calculation and filing |
| DRC VAT | `drcVatService.ts` | Domestic Reverse Charge handling |
| VAT Adjustments | `vatAdjustmentService.ts` | VAT input/output adjustments |
| Approval Service | `approvalService.ts` | Configurable approval rules and requests |
| Email Service | `emailService.ts` | SMTP delivery with PDF attachments |
| Company Service | `companyService.ts` | Company settings management |
| GL Cross-Module Hooks | `glCrossModuleHooks.ts` | Auto-journal creation from AR/AP/Bank/Payroll |
| Sage Import | `sageImportService.ts` | Sage data migration |
| Sage Migration | `sageMigrationService.ts` | Migration run tracking |

### Payroll Services

| Service | File | Purpose |
|---|---|---|
| Payroll Service | `payrollService.ts` | Employee CRUD, pay structures, payroll runs, payslips, GL integration |
| Tax Tables | `taxTables.ts` | SARS PAYE/UIF/SDL calculations (2024-2025) |

### Accounting Utilities

| Utility | File | Purpose |
|---|---|---|
| Double Entry Validation | `doubleEntry.ts` | Journal line and entry balance validation (fixed-point arithmetic) |
| Auto Match | `autoMatch.ts` | 4-tier bank transaction matching strategy |
| Payment Allocation | `paymentAllocation.ts` | Overpayment/duplicate detection, balance calculation |
| Bank CSV Parsers | `bankCsvParsers.ts` | FNB, Standard Bank, Nedbank, ABSA, Capitec CSV parsing |
| Bank OFX Parser | `bankOfxParser.ts` | OFX statement parsing |
| Bank QIF Parser | `bankQifParser.ts` | QIF statement parsing |
| Bank PDF Parser | `bankPdfParser.ts` | PDF statement extraction |
| Three-Way Match | `threeWayMatch.ts` | PO/GRN/Invoice matching validation |
| Aging | `aging.ts` | Aging bucket calculations |
| Statement PDF | `statementPdf.ts` | Customer/supplier statement PDF generation |
| Recon Report PDF | `reconReportPdf.ts` | Bank reconciliation report PDF generation |

---

## 10. Components Reference

### Accounting Components (`src/components/accounting/`)

| Component | Lines | Description |
|---|---|---|
| `AccountingNav.tsx` | 11 | Navigation wrapper delegating to ModuleNav with teal accent |
| `accountingNavConfig.ts` | 500 | Full navigation schema (11 tabs, flyout menus, route resolution) |
| `BankTxTable.tsx` | 543 | Bank transaction table with inline allocation, VAT selection, confidence dots, split/match/exclude actions |
| `StatementBalanceWidget.tsx` | 195 | Bank import batch display with GL balance comparison |
| `AccountDrillDown.tsx` | 165 | Lazy-loaded account transaction drill-down for reports |
| `SupplierForm.tsx` | 300 | Reusable supplier creation/editing form |
| `CustomerForm.tsx` | 242 | Reusable customer creation/editing form |
| `ExcludeReasonModal.tsx` | 167 | Exclusion reason capture (Duplicate, Personal, Bank Fee, Transfer, Other) |
| `BankTxAttachmentsModal.tsx` | 330 | Drag-and-drop file upload for bank transaction receipts |
| `CreateEntityModal.tsx` | 150+ | Inline GL Account/Supplier/Customer creation from allocation |
| `CreateRuleModal.tsx` | 150+ | Bank categorisation rule creation with live preview |
| `FindMatchModal.tsx` | - | Search and link GL entries to bank transactions |
| `SplitTransactionModal.tsx` | - | Split bank transaction across multiple GL accounts |

### Currency Components (`src/components/accounting/currencies/`)

| Component | Description |
|---|---|
| `CurrencyList.tsx` | Currency management list |
| `ExchangeRatesPanel.tsx` | Exchange rate view/edit panel |

### Layout Components (`src/components/layout/`)

| Component | Lines | Description |
|---|---|---|
| `AppLayout.tsx` | 200+ | Main layout with collapsible sidebar, top header, theme toggle, user menu, 8 primary nav links |
| `ModuleNav.tsx` | 200+ | Generic horizontal navigation bar with 3-level flyout support, 8 accent colour options |

### Dashboard Components (`src/components/dashboard/`)

| Component | Lines | Description |
|---|---|---|
| `EnhancedStatCard.tsx` | 238 | KPI stat card with trend indicators, loading/error states, click-through navigation, 3 variants (default/compact/detailed). Includes `StatsGrid` helper for responsive grid layout (2-6 columns) |

### UI Components (`src/components/ui/`)

| Component | Lines | Description |
|---|---|---|
| `LoadingSpinner.tsx` | 35 | Spinning circle with sm/md/lg sizes, teal accent |

---

## 11. Configuration & Deployment

### Next.js Configuration (`next.config.js`)
- `reactStrictMode: true`
- `poweredByHeader: false`
- `output: 'standalone'` (self-contained deployment)
- Security headers on all routes (X-Frame-Options: DENY, nosniff, referrer policy, permissions policy)
- Webpack client-side fallback exclusions (fs, net, tls, crypto)
- Package import optimisation for lucide-react

### Tailwind Configuration (`tailwind.config.mjs`)
- Dark mode via CSS class toggle
- Custom colour scales: primary (blue), secondary (slate), accent (purple), semantic (success/warning/error/info)
- Font families: Inter (sans), Georgia (serif), Monaco/Consolas (mono)
- Custom animations: fade-in, slide-up, slide-down, pulse-subtle, spin-slow, spin-fast, shimmer
- HSL CSS variables for dynamic theming

### ESLint Configuration (`.eslintrc.json`)
- TypeScript + React + React Hooks plugins
- Warn on unused variables (ignore underscore-prefixed)
- Warn on `any` types and `console` usage
- Ignore: node_modules, .next, out

### Playwright Configuration (`playwright.config.ts`)
- Test directory: `./tests/e2e`
- 30-second timeout, 0 retries
- Base URL: `http://localhost:3101`
- Chromium only, headless mode

### Deployment (`scripts/deploy.sh`)

**Target:** Velocity server via rsync + systemd

1. Rsync files to `/home/velo/isaflow` (excludes: node_modules, .next, .git, .env.local, tests)
2. Copy `.env.local` if not present
3. Install production dependencies
4. Build with `NODE_OPTIONS=--max-old-space-size=4096`
5. Install systemd service (`isaflow.service`)
6. Install nginx config (`app-isaflow`) with SSL
7. Restart service and verify
8. Live at `https://app.isaflow.co.za`

### Build Commands
```bash
bun run dev          # Development server (hot reload)
bun run build        # Production build (4GB heap)
bun run start        # Start production server
bun run lint         # ESLint check
bun run type-check   # TypeScript validation
bun run test:e2e     # Playwright E2E tests
```

---

## 12. Design Patterns

### GL Cross-Module Integration
Every transactional module (AR, AP, Bank, Payroll) auto-creates GL journal entries via `glCrossModuleHooks.ts`. The `source` field on journal entries tracks origin (auto_invoice, auto_payment, auto_bank_recon, auto_payroll, etc.).

### Double-Entry Enforcement
Database triggers enforce balanced entries (total debits = total credits) on posting. Fixed-point arithmetic in validation utilities prevents floating-point errors.

### Smart Categorisation Pipeline
Multi-strategy approach for bank transaction categorisation:
1. **Rules** - User-defined categorisation rules (confidence 1.0)
2. **Patterns** - 50+ pre-seeded SA merchant patterns with learned additions
3. **History** - Historical categorisation learning

### Three-Way Matching
Supplier invoices support progressive matching: unmatched → PO matched → GRN matched → fully matched.

### Approval Workflow
Configurable rules by document type and amount threshold. Requests track full audit trail (who requested, who decided, when, notes).

### Document Number Generation
All key documents use database triggers to auto-generate year-based sequential numbers (e.g., `JE-2026-00001`).

### Polymorphic Tables
- `credit_notes` serves both AR and AP via `type` field
- `accounting_adjustments` handles customer and supplier adjustments
- `sars_submissions` supports multiple form types

### Multi-Currency Architecture
All monetary transactions default to ZAR with optional currency override. Exchange rates maintained separately with `last_updated` tracking.

### Transactional Integrity
Multi-query operations use Neon transactions with `ReadCommitted` isolation level. Exponential backoff retry logic for transient database failures.

---

*This documentation covers all features, functions, APIs, database tables, services, components, and configuration of the ISAFlow Accounting system as of 2026-03-27.*
