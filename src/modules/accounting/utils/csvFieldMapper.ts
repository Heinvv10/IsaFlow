/**
 * CSV Field Mapper
 * PRD: Customer Migration Wizard — Phase 1
 *
 * Auto-maps CSV column headers to ISAFlow field names based on known
 * aliases per source system. Used in the wizard's field mapping step.
 */

export type MigrationStep =
  | 'chart-of-accounts'
  | 'customers'
  | 'suppliers'
  | 'opening-balances'
  | 'ar-invoices'
  | 'ap-invoices';

// ── Alias tables per source system ───────────────────────────────────────────

// Each entry: [normalized header alias] → ISAFlow field name
// Keys are lowercase and stripped of spaces/underscores for loose matching.

const GENERIC_COA_ALIASES: Record<string, string> = {
  'accountnumber':    'account_code',
  'accountcode':      'account_code',
  'acctcode':         'account_code',
  'code':             'account_code',
  'accountname':      'account_name',
  'acctname':         'account_name',
  'name':             'account_name',
  'description':      'description',
  'type':             'account_type',
  'accounttype':      'account_type',
  'category':         'account_type',
  'normalbalance':    'normal_balance',
  'balance':          'normal_balance',
  'drcrtype':         'normal_balance',
  'parentcode':       'parent_code',
  'parentaccount':    'parent_code',
  'parent':           'parent_code',
  'subtype':          'account_subtype',
  'accountsubtype':   'account_subtype',
};

const SAGE_CLOUD_COA_ALIASES: Record<string, string> = {
  ...GENERIC_COA_ALIASES,
  'accountnumber':    'account_code',  // Sage Cloud header
  'ledgercode':       'account_code',
  'mainaccount':      'account_code',
};

const SAGE_50_COA_ALIASES: Record<string, string> = {
  ...GENERIC_COA_ALIASES,
  'masteraccount':    'account_code',
  'nominalcode':      'account_code',
  'groupheader':      'parent_code',
};

const XERO_COA_ALIASES: Record<string, string> = {
  ...GENERIC_COA_ALIASES,
  'code':             'account_code',
  'taxtype':          'account_subtype',
};

const QUICKBOOKS_COA_ALIASES: Record<string, string> = {
  ...GENERIC_COA_ALIASES,
  'acctnumber':       'account_code',
  'accttype':         'account_type',
};

const GENERIC_CUSTOMER_ALIASES: Record<string, string> = {
  'customername':     'name',
  'companyname':      'name',
  'client':           'name',
  'clientname':       'name',
  'emailaddress':     'email',
  'email':            'email',
  'telephone':        'phone',
  'phonenumber':      'phone',
  'cellphone':        'phone',
  'vatnumber':        'vat_number',
  'taxnumber':        'vat_number',
  'vatreg':           'vat_number',
  'regnumber':        'registration_number',
  'companyreg':       'registration_number',
  'billingaddress':   'billing_address',
  'address':          'billing_address',
  'contactperson':    'contact_person',
  'contact':          'contact_person',
  'paymentterms':     'payment_terms',
  'terms':            'payment_terms',
  'creditlimit':      'credit_limit',
  'notes':            'notes',
  'memo':             'notes',
};

const GENERIC_SUPPLIER_ALIASES: Record<string, string> = {
  ...GENERIC_CUSTOMER_ALIASES,
  'suppliername':     'name',
  'vendorname':       'name',
  'bankname':         'bank_name',
  'bank':             'bank_name',
  'bankaccount':      'bank_account_number',
  'accountnumber':    'bank_account_number',
  'branchcode':       'bank_branch_code',
  'bankbranchcode':   'bank_branch_code',
  'accounttype':      'bank_account_type',
};

const GENERIC_OB_ALIASES: Record<string, string> = {
  'accountcode':      'account_code',
  'accountnumber':    'account_code',
  'code':             'account_code',
  'accountname':      'account_name',
  'name':             'account_name',
  'debit':            'debit_balance',
  'debitbalance':     'debit_balance',
  'dr':               'debit_balance',
  'credit':           'credit_balance',
  'creditbalance':    'credit_balance',
  'cr':               'credit_balance',
};

const GENERIC_AR_ALIASES: Record<string, string> = {
  'invoicenumber':    'invoice_number',
  'invoiceno':        'invoice_number',
  'invnumber':        'invoice_number',
  'customername':     'customer_name',
  'client':           'customer_name',
  'clientname':       'customer_name',
  'invoicedate':      'invoice_date',
  'date':             'invoice_date',
  'duedate':          'due_date',
  'paymentdue':       'due_date',
  'subtotal':         'subtotal',
  'nettamount':       'subtotal',
  'exclusiveamount':  'subtotal',
  'taxamount':        'tax_amount',
  'vatamount':        'tax_amount',
  'vat':              'tax_amount',
  'totalamount':      'total_amount',
  'invoicetotal':     'total_amount',
  'total':            'total_amount',
  'amountpaid':       'amount_paid',
  'paid':             'amount_paid',
  'reference':        'reference',
  'poref':            'reference',
};

const GENERIC_AP_ALIASES: Record<string, string> = {
  ...GENERIC_AR_ALIASES,
  'suppliername':     'supplier_name',
  'vendor':           'supplier_name',
  'vendorname':       'supplier_name',
};

// ── Source system → step → alias map ────────────────────────────────────────

type AliasMap = Record<string, Record<string, Record<string, string>>>;

const ALIAS_MAP: AliasMap = {
  sage_cloud: {
    'chart-of-accounts': SAGE_CLOUD_COA_ALIASES,
    customers:            GENERIC_CUSTOMER_ALIASES,
    suppliers:            GENERIC_SUPPLIER_ALIASES,
    'opening-balances':   GENERIC_OB_ALIASES,
    'ar-invoices':        GENERIC_AR_ALIASES,
    'ap-invoices':        GENERIC_AP_ALIASES,
  },
  sage_50: {
    'chart-of-accounts': SAGE_50_COA_ALIASES,
    customers:            GENERIC_CUSTOMER_ALIASES,
    suppliers:            GENERIC_SUPPLIER_ALIASES,
    'opening-balances':   GENERIC_OB_ALIASES,
    'ar-invoices':        GENERIC_AR_ALIASES,
    'ap-invoices':        GENERIC_AP_ALIASES,
  },
  pastel: {
    'chart-of-accounts': SAGE_50_COA_ALIASES,
    customers:            GENERIC_CUSTOMER_ALIASES,
    suppliers:            GENERIC_SUPPLIER_ALIASES,
    'opening-balances':   GENERIC_OB_ALIASES,
    'ar-invoices':        GENERIC_AR_ALIASES,
    'ap-invoices':        GENERIC_AP_ALIASES,
  },
  xero: {
    'chart-of-accounts': XERO_COA_ALIASES,
    customers:            GENERIC_CUSTOMER_ALIASES,
    suppliers:            GENERIC_SUPPLIER_ALIASES,
    'opening-balances':   GENERIC_OB_ALIASES,
    'ar-invoices':        GENERIC_AR_ALIASES,
    'ap-invoices':        GENERIC_AP_ALIASES,
  },
  quickbooks: {
    'chart-of-accounts': QUICKBOOKS_COA_ALIASES,
    customers:            GENERIC_CUSTOMER_ALIASES,
    suppliers:            GENERIC_SUPPLIER_ALIASES,
    'opening-balances':   GENERIC_OB_ALIASES,
    'ar-invoices':        GENERIC_AR_ALIASES,
    'ap-invoices':        GENERIC_AP_ALIASES,
  },
  other: {
    'chart-of-accounts': GENERIC_COA_ALIASES,
    customers:            GENERIC_CUSTOMER_ALIASES,
    suppliers:            GENERIC_SUPPLIER_ALIASES,
    'opening-balances':   GENERIC_OB_ALIASES,
    'ar-invoices':        GENERIC_AR_ALIASES,
    'ap-invoices':        GENERIC_AP_ALIASES,
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Auto-map CSV column headers to ISAFlow field names.
 *
 * @param headers     Array of raw header strings from the CSV
 * @param sourceSystem Source system key (e.g. 'sage_cloud', 'xero')
 * @param step        Wizard step key (e.g. 'chart-of-accounts', 'customers')
 * @returns           Record<csvHeader, isafieldName> for matched columns.
 *                    Unrecognized headers are returned as-is (identity mapping).
 */
export function autoMapFields(
  headers: string[],
  sourceSystem: string,
  step: string,
): Record<string, string> {
  const aliases =
    ALIAS_MAP[sourceSystem]?.[step] ??
    ALIAS_MAP['other']?.[step] ??
    {};

  const result: Record<string, string> = {};

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const mapped = aliases[normalized];
    result[header] = mapped ?? header;
  }

  return result;
}

function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, '')   // strip spaces, underscores, dashes, dots
    .replace(/[^a-z0-9]/g, '');   // strip remaining non-alphanumeric
}
