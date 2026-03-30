# ISAFlow — Complete Feature Reference

> Last updated: 2026-03-30 | 163 pages | 218 API routes | 91 services | 44 migrations

---

## Core Accounting

### General Ledger
- Hierarchical chart of accounts (57+ accounts, grouped by Assets/Liabilities/Equity/Revenue/Expenses)
- Double-entry journal entries with auto-balance enforcement
- Recurring journal templates with flexible schedules
- Fiscal period management (open/close periods, year-end closing)
- Default account mappings for automated posting
- Opening balances and year-end procedures
- Cost centres (2-dimensional) and business units

### Multi-Currency
- Currency management with ZAR as base
- Exchange rate tables with effective dates
- Multi-currency transactions across all modules

---

## Customers & Accounts Receivable

### Customer Management
- Customer list with search, categories, and status tracking
- Full customer profile (contact, addresses, VAT/reg numbers, credit limits, payment terms)
- Customer categories for segmentation

### Invoicing
- Professional tax invoice creation with line items, VAT, and discounts
- Invoice PDF generation and email delivery
- Recurring invoices with configurable schedules
- Credit notes and write-off management
- Customer quotes with status workflow (Draft → Sent → Accepted → Declined → Converted)
- Sales orders

### Collections
- Customer payments (receipts) with allocation to invoices
- Customer allocations — match payments to outstanding invoices
- AR aging analysis (Current / 30 / 60 / 90+ days)
- Customer statements and batch statement runs
- Automated dunning notifications
- Debtors manager dashboard
- Smart collections with AI-driven prioritization

---

## Suppliers & Accounts Payable

### Supplier Management
- Supplier list with categories, payment terms, bank details
- Full supplier profile with VAT/reg numbers

### Purchasing
- Purchase orders with status workflow (Draft → Sent → Received → Invoiced)
- Supplier invoice capture with 3-way matching (PO / receipt / invoice)
- Supplier payments with allocation
- Batch payments — process multiple payments in one run
- EFT file generation for SA banks (Standard Bank, FNB, ABSA, Nedbank, Capitec)
- Supplier returns and credit notes

### AP Management
- Supplier allocations — match payments to invoices
- AP aging analysis (Current / 30 / 60 / 90+ days)
- Supplier statements

---

## Banking & Cash Management

### Bank Accounts
- Multi-account management with balance tracking
- Bank transaction list with filtering and search

### Bank Reconciliation
- Statement import (CSV from FNB, Standard Bank, Nedbank, ABSA, Capitec + OFX/QIF)
- 4-tier smart auto-matching (rules → reference → amount+date → amount)
- Bank reconciliation workflow with match/unmatch
- Reconciliation rules engine with live preview
- Split transactions across multiple GL accounts

### Bank Feeds
- Stitch.money integration for automatic transaction syncing
- OAuth connection flow
- Real-time transaction import

### Bank Transfers
- Inter-account transfers with automatic double-entry posting

---

## Items & Inventory

### Product Management
- Items and products with code, description, unit, pricing
- Item categories
- Cost price and selling price management
- Tax rate assignment per item

### Stock Control
- Stock levels tracking with quantities on hand
- Stock adjustments (write-up, write-down, count)
- Item opening balances
- Item pricing management

### Inventory Reports
- Item listing, item movement
- Item valuation, item quantities
- Sales by item, purchases by item

---

## VAT & Tax Compliance

### VAT Management
- 9 VAT types (standard 15%, zero-rated, exempt, DRC, and more)
- VAT adjustments with audit trail
- DRC (Domestic Reverse Charge) VAT support
- VAT return calculation and reporting

### SARS Compliance
- VAT201 return auto-generation
- EMP201 employee tax returns
- SARS submission tracking and history
- Compliance calendar with due dates and alerts
- eFiling integration ready

---

## Fixed Assets & Depreciation

### Asset Register
- Asset register with SARS wear-and-tear categories
- Asset detail (serial number, location, purchase date, cost, status)
- SARS categories with prescribed rates (Aircraft 25%, Buildings 5%, Computers 33.33%, etc.)

### Depreciation
- Monthly depreciation runs with GL posting
- Straight-line and declining balance methods
- Depreciation schedule and forecasting
- Asset disposals with profit/loss calculation

---

## Payroll

### Employee Management
- Employee list with personal and employment details
- Employment types, departments, cost centres

### Payroll Processing
- Payroll runs with automatic PAYE, UIF, and SDL calculations
- Payslip PDF generation
- GL auto-posting for payroll journals
- IRP5 certificate generation

### Leave Management
- Leave applications and approvals
- Leave balance tracking
- Leave types and policies

---

## Reporting & Analytics

### Financial Statements
- Income Statement (with comparatives and percentages)
- Balance Sheet (with comparatives)
- Cash Flow Statement
- Trial Balance (with drill-down)
- General Ledger detail

### Management Reports
- Budget vs Actual (variance analysis)
- Cash Flow Forecast (AI-powered and traditional)
- Trend Analysis (growth rates, moving averages, anomaly detection)
- Financial Analysis (30+ ratios: liquidity, profitability, efficiency, leverage)
- KPI Scorecard (traffic-light scoring)
- Project Profitability

### Executive Reports
- Executive Summary Dashboard (KPIs + charts + alerts)
- Management Pack with AI Commentary
- Report Packs (Board / Management / Monthly — pre-built collections)
- Waterfall Charts (profit, cashflow, variance)
- 3-Way Forecast (linked P&L + Balance Sheet + Cash Flow)
- Ratio Trends (multi-period tracking)

### Transactional Reports
- Customer reports, supplier reports
- Sales by customer/item, purchases by supplier/item
- Bank transactions, account transactions
- Audit trail
- Unallocated payments/receipts
- AR aging, AP aging

### Export
- CSV export for all reports
- PDF generation for invoices, credit notes, statements
- Excel-compatible exports

---

## AI & Automation

### Document Capture
- Upload receipts, invoices, and documents
- Vision Language Model (VLM) extraction via Qwen3-VL-8B
- OCR processing with field confidence scoring
- Automatic data extraction (vendor, date, amount, line items)
- Document validation and review workflow

### Smart Categorization
- AI-powered bank transaction categorization
- 50+ pre-seeded South African merchant patterns
- Multi-strategy approach (rules → patterns → AI)
- Confidence scoring on every suggestion
- Learning from historical decisions

### AI Invoice Pipeline
- Document capture → invoice creation → GL posting (automated)
- Receipt-to-journal conversion (expense photos → journal entries)
- Supplier fuzzy matching for vendor identification

### AI Analytics
- AI-generated management commentary on financial results
- Key driver identification and risk assessment
- Natural language queries against financial data
- Anomaly detection in transactions
- Cash flow forecasting with AI

### Intelligent Matching
- Multi-document matching (PO / delivery note / invoice)
- VLM-powered bank statement matching
- Contract extraction from PDFs
- Payslip verification against payroll records

---

## Workflow & Automation

### Approval Workflows
- Configurable approval rules by document type and amount threshold
- Multi-stage approval chains
- Approval status tracking with full audit trail
- Supported: invoices, payments, journal entries, credit notes

### Continuous Close
- Automated period-end processing
- Transaction categorization, matching, and approval automation
- Close state monitoring and progress tracking
- Month-end close wizard

---

## Multi-Company & Group

### Company Groups
- Holding company and subsidiary management
- Ownership percentage tracking
- Consolidation method selection

### Consolidated Reporting
- Group trial balance
- Consolidated income statement
- Consolidated balance sheet
- Intercompany transaction tracking
- Elimination adjustments
- COA cross-mapping between entities

---

## Data Migration

### Migration Wizard
- Step-by-step guided migration from legacy systems
- Chart of accounts import with mapping
- Customer and supplier import
- AR and AP invoice import
- Opening balance import
- Pre/post-migration validation and reconciliation
- Session tracking with error recovery

### Sage Import
- Dedicated Sage accounting migration tool
- Chart of accounts, customers, suppliers, transactions
- Sage customer import with field mapping

### Bank Statement Import
- Multi-format import (CSV, OFX, QIF)
- Bank-specific parsers for major SA banks
- Automatic classification and categorization

---

## Customer Portal
- Self-service invoice viewing and download
- Statement access
- Online payment links (payment gateway integration)
- Portal chatbot for customer queries

---

## Tools & Administration

### Settings
- Company settings (logo, details, tax numbers, banking)
- Accounting settings (reporting currency, fiscal year)
- User access control and permissions
- Audit trail for all changes

### Productivity
- Time tracking and project accounting
- Budget management with year-over-year copy
- Cost centres (2-dimensional) and business units

### Integrations
- Bank feeds via Stitch.money
- Payment gateway integration
- SARS eFiling (submission ready)
- Email delivery for invoices and statements

---

## Technical Specs

| Metric | Value |
|--------|-------|
| UI Pages | 163 |
| API Endpoints | 218 |
| Business Services | 91 |
| DB Migrations | 44 |
| Unit Tests | 730+ |
| E2E Tests | 253 |
| Framework | Next.js 14 + TypeScript |
| Database | PostgreSQL (Neon) |
| Styling | Tailwind CSS |
| Charts | Recharts |
| AI/VLM | Qwen3-VL-8B via vLLM |
| Auth | JWT + bcrypt |
| Deployment | Standalone + systemd |
