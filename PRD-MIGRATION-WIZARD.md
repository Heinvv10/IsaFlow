# PRD: Customer Migration Wizard

## Overview

A guided, step-by-step migration flow that lets customers onboard to ISAFlow from any accounting system (Sage, Xero, QuickBooks, Pastel, or manual CSV). The system is now code-agnostic — all GL posting resolves accounts by `account_subtype`, not by account code numbers — so customers can keep their existing numbering scheme.

## Problem

Switching accounting software is the #1 barrier to customer acquisition. Customers fear data loss, broken workflows, and the manual effort of re-entering years of data. ISAFlow needs a frictionless migration path that:

1. Accepts data from the most common SA accounting systems
2. Preserves the customer's existing chart of accounts numbering
3. Imports contacts, opening balances, and outstanding invoices
4. Validates data integrity before and after migration
5. Provides clear progress feedback throughout

## Prerequisites (COMPLETED)

- [x] `systemAccountResolver.ts` — GL services resolve accounts by subtype, not code
- [x] Migration 254 — backfills `account_subtype` on all system accounts
- [x] Seed data updated with subtypes in `200_accounting_foundation.sql`
- [x] 40+ hardcoded account code references refactored across 13 service files
- [x] `GLAccountSubtype` type extended with `vat_input`, `vat_output`, `default_revenue`, etc.
- [x] Bank statement import already supports FNB, Standard Bank, Nedbank, ABSA, Capitec, OFX, QIF
- [x] Sage migration module exists (needs polish, not rebuild)

---

## Scope

### Phase 1: Universal CSV Import Wizard (This PRD)

**Target:** Any customer from any accounting system can migrate via CSV files.

### Phase 2: Sage API Connector (Future)
### Phase 3: Xero/QuickBooks API Connectors (Future)

---

## Phase 1 Implementation

### 1. Migration Hub Page

**Route:** `/accounting/migration`

**UI:** A dashboard showing migration steps as a vertical stepper/wizard. Each step can be completed independently but the recommended order is enforced visually.

**Steps:**
1. Choose Source System
2. Chart of Accounts
3. Customers
4. Suppliers
5. Opening Balances
6. Outstanding Customer Invoices (AR)
7. Outstanding Supplier Invoices (AP)
8. Validation & Go-Live

**State tracking:** Store migration progress in a `migration_sessions` table so users can resume later.

### 2. Database: Migration Session

```sql
CREATE TABLE migration_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  source_system VARCHAR(50), -- 'sage_cloud', 'sage_50', 'xero', 'quickbooks', 'pastel', 'other'
  status VARCHAR(20) DEFAULT 'in_progress', -- in_progress, completed, abandoned
  steps_completed JSONB DEFAULT '{}', -- { "coa": true, "customers": true, ... }
  coa_records_imported INT DEFAULT 0,
  customers_imported INT DEFAULT 0,
  suppliers_imported INT DEFAULT 0,
  opening_balances_set BOOLEAN DEFAULT false,
  ar_invoices_imported INT DEFAULT 0,
  ap_invoices_imported INT DEFAULT 0,
  errors JSONB DEFAULT '[]',
  started_by UUID NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  notes TEXT
);
```

### 3. Step 1: Choose Source System

**UI:** Card selection grid with logos/icons for:
- Sage Business Cloud Accounting
- Sage 50 / Pastel Partner
- Xero
- QuickBooks Online
- Wave / FreshBooks
- Other / Manual CSV

**Effect:** Sets `source_system` on the migration session. Determines which CSV templates and field mappings are shown in subsequent steps.

### 4. Step 2: Chart of Accounts Import

**Route:** `/accounting/migration/chart-of-accounts`

**Features:**
- Download CSV template (pre-filled with ISAFlow defaults as example)
- Upload CSV with columns: `account_code`, `account_name`, `account_type`, `account_subtype`, `parent_code`, `normal_balance`, `description`
- Field mapping UI — user maps their CSV columns to ISAFlow fields if headers don't match
- Auto-detect: if source system is known, pre-map fields automatically
- Preview table showing parsed accounts with validation status per row
- Validation rules:
  - `account_code` unique, required, max 20 chars
  - `account_type` must be one of: asset, liability, equity, revenue, expense
  - `normal_balance` must be debit or credit
  - Parent codes must reference existing accounts
- System account mapping: prompt user to identify which of their accounts maps to each system subtype (bank, receivable, payable, vat_input, vat_output, retained_earnings, default_revenue, default_expense, admin_expense)
- Import button: creates accounts and sets `account_subtype` + `is_system_account` on mapped accounts

**API:** `POST /api/accounting/migration/chart-of-accounts`

**Request body:**
```typescript
{
  sessionId: string;
  accounts: Array<{
    accountCode: string;
    accountName: string;
    accountType: GLAccountType;
    accountSubtype?: string;
    parentCode?: string;
    normalBalance: 'debit' | 'credit';
    description?: string;
    isSystemAccount?: boolean;
  }>;
  systemAccountMap: {
    bank: string;           // account_code the user chose
    receivable: string;
    payable: string;
    vat_input: string;
    vat_output: string;
    retained_earnings: string;
    default_revenue: string;
    default_expense: string;
    admin_expense: string;
  };
}
```

**Logic:**
1. Validate all accounts
2. Create parent accounts first (level 1, then level 2, then level 3+)
3. Set `account_subtype` and `is_system_account = true` on system-mapped accounts
4. Clear `systemAccountResolver` cache
5. Return import results with success/failure per row

**CSV templates per source system:**

| Source | Code Format | Notes |
|--------|-------------|-------|
| Sage Cloud | 3-digit (001-999) | Type inferred from range |
| Sage 50/Pastel | 7-digit (1000000-9999999) | Group headers in first column |
| Xero | 3-6 digit flexible | Type column present |
| QuickBooks | 1-7 digit optional | Account Type column maps directly |
| Generic | Any | All fields required |

### 5. Step 3: Customer Import

**Route:** `/accounting/migration/customers`

**Features:**
- Download CSV template
- Upload CSV: `name`, `email`, `phone`, `vat_number`, `registration_number`, `billing_address`, `shipping_address`, `contact_person`, `payment_terms`, `credit_limit`, `notes`
- Preview with duplicate detection (match on name + email)
- Skip/overwrite/merge options for duplicates
- Bulk insert

**API:** `POST /api/accounting/migration/customers`

**Validation:**
- `name` required
- `vat_number` if present: 10-digit SA format
- `payment_terms` default: 30
- Duplicate detection: fuzzy match on name (80%+ similarity)

### 6. Step 4: Supplier Import

**Route:** `/accounting/migration/suppliers`

**Same pattern as customers with additional fields:**
- `bank_name`, `bank_account_number`, `bank_branch_code`, `bank_account_type`

**API:** `POST /api/accounting/migration/suppliers`

### 7. Step 5: Opening Balances

**Route:** `/accounting/migration/opening-balances`

**Features:**
- Upload trial balance CSV: `account_code`, `debit_balance`, `credit_balance`
- Or manual entry form with all accounts listed
- Auto-validate: total debits must equal total credits
- Set effective date (typically first day of new financial year)
- Creates a single journal entry (source: `auto_migration`) posting all opening balances

**API:** `POST /api/accounting/migration/opening-balances`

**Request body:**
```typescript
{
  sessionId: string;
  effectiveDate: string; // YYYY-MM-DD
  balances: Array<{
    accountCode: string;
    debit: number;
    credit: number;
  }>;
}
```

**Validation:**
- Sum of debits must equal sum of credits (balanced trial balance)
- All account codes must exist in chart of accounts
- Effective date must be within an open fiscal period
- Warn if retained earnings doesn't equal revenue - expenses from old system

### 8. Step 6: Outstanding Customer Invoices (AR)

**Route:** `/accounting/migration/ar-invoices`

**Features:**
- Upload CSV: `invoice_number`, `customer_name`, `invoice_date`, `due_date`, `subtotal`, `tax_amount`, `total_amount`, `amount_paid`, `reference`
- Match `customer_name` to imported customers (fuzzy match)
- Preview with match confidence indicators
- Manual match override for unmatched customers
- Creates customer invoices with `status = 'approved'` and sets `amount_paid`
- Posts GL entries: DR Accounts Receivable, CR Revenue + VAT Output
- Sets invoice status based on balance (paid, partially_paid, approved/overdue)

**API:** `POST /api/accounting/migration/ar-invoices`

### 9. Step 7: Outstanding Supplier Invoices (AP)

**Route:** `/accounting/migration/ap-invoices`

**Same pattern as AR with supplier matching.**

**Creates supplier invoices with `status = 'approved'`, posts GL entries: DR Expense + VAT Input, CR Accounts Payable.**

### 10. Step 8: Validation & Go-Live

**Route:** `/accounting/migration/validate`

**Features:**
- Run validation checks:
  - Trial balance is balanced (debits = credits)
  - AR total matches Accounts Receivable GL balance
  - AP total matches Accounts Payable GL balance
  - All system accounts are mapped and active
  - No orphan invoices (customer/supplier exists)
- Display results as pass/fail checklist
- "Complete Migration" button marks session as completed
- Optional: lock imported data to prevent accidental edits

**API:** `GET /api/accounting/migration/validate?sessionId=xxx`

---

## File Structure

```
pages/
  accounting/
    migration/
      index.tsx                    # Migration hub / stepper
      chart-of-accounts.tsx        # Step 2: COA import
      customers.tsx                # Step 3: Customer import
      suppliers.tsx                # Step 4: Supplier import
      opening-balances.tsx         # Step 5: Opening balances
      ar-invoices.tsx              # Step 6: AR import
      ap-invoices.tsx              # Step 7: AP import
      validate.tsx                 # Step 8: Validation

pages/api/accounting/migration/
  session.ts                       # GET/POST migration session
  chart-of-accounts.ts             # POST bulk COA import
  customers.ts                     # POST bulk customer import
  suppliers.ts                     # POST bulk supplier import
  opening-balances.ts              # POST opening balance journal
  ar-invoices.ts                   # POST AR invoice import
  ap-invoices.ts                   # POST AP invoice import
  validate.ts                      # GET validation results
  templates.ts                     # GET downloadable CSV templates

src/modules/accounting/
  services/
    migrationService.ts            # Core migration logic
    migrationTemplateService.ts    # CSV template generation per source system
    migrationValidationService.ts  # Pre/post migration validation
  utils/
    csvFieldMapper.ts              # Auto-detect and map CSV columns
    fuzzyMatcher.ts                # Fuzzy string matching for contacts
```

---

## CSV Templates

Each template is a downloadable CSV with:
- Header row with ISAFlow field names
- 2-3 example rows showing format
- Comments row (row 2) explaining each field

### Chart of Accounts Template
```csv
account_code,account_name,account_type,normal_balance,parent_code,description
1000,Assets,asset,debit,,Top-level asset category
1100,Current Assets,asset,debit,1000,
1110,Bank - Primary,asset,debit,1100,Main operating bank account
1120,Accounts Receivable,asset,debit,1100,Trade debtors
```

### Customers Template
```csv
name,email,phone,vat_number,registration_number,billing_address,contact_person,payment_terms,credit_limit,notes
Acme Corp,accounts@acme.co.za,011-555-1234,4123456789,2020/123456/07,"123 Main St, Sandton, 2196",Jane Smith,30,50000,Key account
```

### Opening Balances Template
```csv
account_code,account_name,debit_balance,credit_balance
1110,Bank - Primary,125000.00,0.00
1120,Accounts Receivable,45000.00,0.00
2110,Accounts Payable,0.00,32000.00
3200,Retained Earnings,0.00,138000.00
```

### Outstanding Invoices Template (AR)
```csv
invoice_number,customer_name,invoice_date,due_date,subtotal,tax_amount,total_amount,amount_paid,reference
INV-001,Acme Corp,2026-01-15,2026-02-14,10000.00,1500.00,11500.00,5000.00,PO-2026-042
```

---

## Navigation

Add to the accounting sidebar under a new "Setup" or "Tools" section:
```
Tools
  ├── Migration Wizard
  ├── Sage Migration (existing, link to /accounting/sage-migration)
  └── Bank Import (existing, link to /accounting/bank-reconciliation/import)
```

---

## System Account Mapping UI

The most critical step. After COA import, show a mapping screen:

```
┌─────────────────────────────────────────────────────────────┐
│  Map Your System Accounts                                    │
│                                                               │
│  ISAFlow needs to know which of your accounts serve           │
│  these system roles. Select from your imported accounts:      │
│                                                               │
│  Primary Bank Account    [▼ 1110 - Bank - Primary     ]      │
│  Accounts Receivable     [▼ 1120 - Accounts Receivable]      │
│  Accounts Payable        [▼ 2110 - Accounts Payable   ]      │
│  VAT Input (Claimable)   [▼ 1140 - VAT Input          ]      │
│  VAT Output (Payable)    [▼ 2120 - VAT Output         ]      │
│  Retained Earnings       [▼ 3200 - Retained Earnings  ]      │
│  Default Revenue         [▼ 4100 - Sales Revenue      ]      │
│  Default Expense         [▼ 5100 - Cost of Sales      ]      │
│  Admin/General Expense   [▼ 5600 - Admin Expenses     ]      │
│                                                               │
│  ○ Auto-detected from account names (8/9 matched)            │
│                                                               │
│  [Confirm Mapping]                                            │
└─────────────────────────────────────────────────────────────┘
```

Auto-detection logic:
- Match account names against known patterns: "bank", "receivable"/"debtors"/"trade debtors", "payable"/"creditors", "VAT input"/"input tax", "VAT output"/"output tax", "retained earnings", "revenue"/"sales"/"income", "materials"/"cost of sales", "admin"/"general expenses"
- Confidence: HIGH (exact match), MEDIUM (partial match), LOW (type-only match)
- Pre-select HIGH confidence matches, highlight MEDIUM for review

---

## Error Handling

- CSV parse errors: show line number + error message, allow fix and re-upload
- Duplicate detection: show side-by-side comparison, let user choose skip/overwrite/merge
- Validation failures: block import with clear error messages
- Partial failures: import valid rows, report failed rows with reasons
- Network errors: resume from last completed step (session-based)

---

## Testing

### Unit Tests
```
tests/unit/migration/
  migrationService.test.ts
  csvFieldMapper.test.ts
  fuzzyMatcher.test.ts
  migrationValidation.test.ts
```

### Test scenarios:
1. Import Sage Cloud CSV (3-digit codes) → system accounts mapped correctly
2. Import Sage 50/Pastel CSV (7-digit codes) → hierarchy preserved
3. Import Xero CSV (flexible codes) → all subtypes assigned
4. Import with duplicate customers → merge/skip works
5. Opening balances with imbalance → rejected with error
6. AR import with unmatched customers → manual match flow
7. Full migration flow → validation passes, GL balanced
8. Resume interrupted migration → session restored correctly

---

## Success Criteria

1. A Sage Business Cloud user can migrate their full dataset in under 30 minutes
2. No hardcoded account codes in any migration logic
3. Trial balance matches between source system and ISAFlow after migration
4. All system accounts (AR, AP, VAT, Bank) are correctly mapped regardless of numbering
5. Outstanding invoices appear in AR/AP aging reports immediately after migration
6. Migration can be resumed if interrupted
