/**
 * Migration Template Service
 * PRD: Customer Migration Wizard — Phase 1
 *
 * Returns downloadable CSV templates per source system and wizard step.
 * Source-specific formats adapt column names and example data to the
 * numbering conventions customers already know.
 */

export type MigrationSourceSystem =
  | 'sage_cloud'
  | 'sage_50'
  | 'xero'
  | 'quickbooks'
  | 'pastel'
  | 'other';

export type MigrationStep =
  | 'chart-of-accounts'
  | 'customers'
  | 'suppliers'
  | 'opening-balances'
  | 'ar-invoices'
  | 'ap-invoices';

// ── Template definitions ─────────────────────────────────────────────────────

const COA_GENERIC = `account_code,account_name,account_type,normal_balance,parent_code,description
# account_code: unique identifier (any format); account_type: asset/liability/equity/revenue/expense; normal_balance: debit/credit
1000,Assets,asset,debit,,Top-level asset category
1100,Current Assets,asset,debit,1000,Short-term assets
1110,Bank - Primary,asset,debit,1100,Main operating bank account
1120,Accounts Receivable,asset,debit,1100,Trade debtors
2000,Liabilities,liability,credit,,Top-level liability category
2110,Accounts Payable,liability,credit,2000,Trade creditors
3200,Retained Earnings,equity,credit,,Accumulated profits
4100,Sales Revenue,revenue,credit,,Primary revenue account
5100,Cost of Sales,expense,debit,,Direct costs
`;

const COA_SAGE_CLOUD = `account_code,account_name,account_type,normal_balance,parent_code,description
# Sage Business Cloud uses 3-digit account codes (001-999)
100,Assets,asset,debit,,
110,Current Assets,asset,debit,100,
111,Bank Account,asset,debit,110,Primary bank
120,Trade Debtors,asset,debit,110,Accounts receivable
200,Liabilities,liability,credit,,
211,Trade Creditors,liability,credit,200,Accounts payable
320,Retained Income,equity,credit,,Retained earnings
410,Sales,revenue,credit,,Revenue
510,Cost of Sales,expense,debit,,Direct costs
`;

const COA_SAGE_50 = `account_code,account_name,account_type,normal_balance,parent_code,description
# Sage 50/Pastel Partner uses 7-digit codes (1000000–9999999)
1000000,ASSETS,asset,debit,,
1100000,Current Assets,asset,debit,1000000,
1110000,Bank,asset,debit,1100000,Primary bank
1120000,Debtors Control,asset,debit,1100000,Trade debtors
2000000,LIABILITIES,liability,credit,,
2110000,Creditors Control,liability,credit,2000000,Trade creditors
3200000,Retained Earnings,equity,credit,,
4100000,Sales,revenue,credit,,
5100000,Purchases,expense,debit,,
`;

const COA_XERO = `account_code,account_name,account_type,normal_balance,parent_code,description
# Xero uses flexible 3-6 digit codes; account_type maps directly
090,Bank,asset,debit,,Current account
200,Sales,revenue,credit,,Revenue
310,Accounts Receivable,asset,debit,,Debtors
800,Accounts Payable,liability,credit,,Creditors
820,Tax Payable,liability,credit,,VAT output
970,Retained Earnings,equity,credit,,
`;

const COA_QUICKBOOKS = `account_code,account_name,account_type,normal_balance,parent_code,description
# QuickBooks Online — account codes are optional (1-7 digits)
1000,Checking,asset,debit,,Bank account
1100,Accounts Receivable,asset,debit,,Trade debtors
2000,Accounts Payable,liability,credit,,Trade creditors
2200,VAT Payable,liability,credit,,VAT output
3000,Retained Earnings,equity,credit,,
4000,Sales,revenue,credit,,
5000,Cost of Goods Sold,expense,debit,,
`;

const CUSTOMERS_TEMPLATE = `name,email,phone,vat_number,registration_number,billing_address,contact_person,payment_terms,credit_limit,notes
# name: required; vat_number: 10-digit SA format; payment_terms: days (default 30)
Acme Corp,accounts@acme.co.za,011-555-1234,4123456789,2020/123456/07,"123 Main St, Sandton, 2196",Jane Smith,30,50000,Key account
Beta Supplies,info@beta.co.za,021-555-9876,,,,,30,,
`;

const SUPPLIERS_TEMPLATE = `name,email,phone,vat_number,registration_number,billing_address,contact_person,payment_terms,bank_name,bank_account_number,bank_branch_code,bank_account_type,notes
# name: required; bank fields optional but recommended for EFT payments
Widget Factory,orders@widgets.co.za,011-444-0001,9876543210,2019/654321/07,"456 Park Ave, Johannesburg",Bob Jones,30,FNB,62012345678,250655,current,Preferred supplier
Office Supplies Ltd,invoices@office.co.za,,,,,,,Standard Bank,10198765432,051001,current,
`;

const OPENING_BALANCES_TEMPLATE = `account_code,account_name,debit_balance,credit_balance
# Enter your trial balance as at your migration date. Total debits must equal total credits.
1110,Bank - Primary,125000.00,0.00
1120,Accounts Receivable,45000.00,0.00
1140,VAT Input,3200.00,0.00
2110,Accounts Payable,0.00,32000.00
2120,VAT Output,0.00,4800.00
3200,Retained Earnings,0.00,136400.00
`;

const AR_INVOICES_TEMPLATE = `invoice_number,customer_name,invoice_date,due_date,subtotal,tax_amount,total_amount,amount_paid,reference
# customer_name must match an imported customer (fuzzy match supported)
# Dates: YYYY-MM-DD format; amounts: decimal numbers
INV-001,Acme Corp,2026-01-15,2026-02-14,10000.00,1500.00,11500.00,5000.00,PO-2026-042
INV-002,Beta Supplies,2026-02-01,2026-03-02,5000.00,750.00,5750.00,0.00,
`;

const AP_INVOICES_TEMPLATE = `invoice_number,supplier_name,invoice_date,due_date,subtotal,tax_amount,total_amount,amount_paid,reference
# supplier_name must match an imported supplier (fuzzy match supported)
SUP-0101,Widget Factory,2026-01-20,2026-02-19,8000.00,1200.00,9200.00,9200.00,WF-2026-011
SUP-0102,Office Supplies Ltd,2026-02-05,2026-03-06,1500.00,225.00,1725.00,0.00,
`;

// ── Template map ─────────────────────────────────────────────────────────────

type TemplateMap = Record<MigrationStep, Partial<Record<MigrationSourceSystem | 'default', string>>>;

const TEMPLATES: TemplateMap = {
  'chart-of-accounts': {
    sage_cloud:  COA_SAGE_CLOUD,
    sage_50:     COA_SAGE_50,
    pastel:      COA_SAGE_50,
    xero:        COA_XERO,
    quickbooks:  COA_QUICKBOOKS,
    other:       COA_GENERIC,
    default:     COA_GENERIC,
  },
  'customers': {
    default: CUSTOMERS_TEMPLATE,
  },
  'suppliers': {
    default: SUPPLIERS_TEMPLATE,
  },
  'opening-balances': {
    default: OPENING_BALANCES_TEMPLATE,
  },
  'ar-invoices': {
    default: AR_INVOICES_TEMPLATE,
  },
  'ap-invoices': {
    default: AP_INVOICES_TEMPLATE,
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns a CSV template string for a given source system and wizard step.
 * Falls back to the generic/default template when no source-specific version exists.
 */
export function getTemplate(sourceSystem: string, step: string): string {
  const stepTemplates = TEMPLATES[step as MigrationStep];
  if (!stepTemplates) {
    throw new Error(`Unknown migration step: ${step}`);
  }

  const specific = stepTemplates[sourceSystem as MigrationSourceSystem];
  if (specific) return specific;

  const fallback = stepTemplates['default'];
  if (fallback) return fallback;

  throw new Error(`No template found for step: ${step}`);
}

/**
 * Returns a suggested filename for the downloaded template CSV.
 */
export function getTemplateFilename(sourceSystem: string, step: string): string {
  const sys = sourceSystem.replace('_', '-');
  return `isaflow-migration-${step}-${sys}-template.csv`;
}
