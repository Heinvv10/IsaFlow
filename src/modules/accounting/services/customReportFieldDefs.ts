/**
 * Custom Report Builder — Field Definitions per Data Source
 * WS-7.1: Safe whitelist of allowed columns — never interpolate user input.
 */

export type FieldType = 'text' | 'number' | 'date' | 'currency';

export interface FieldDef {
  field: string;
  label: string;
  type: FieldType;
  sortable: boolean;
  filterable: boolean;
  totalable: boolean;
  sqlExpr: string; // safe SQL expression — only used from this whitelist
}

const GL_TRANSACTIONS: FieldDef[] = [
  { field: 'entry_date',    label: 'Entry Date',     type: 'date',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'je.entry_date' },
  { field: 'entry_number',  label: 'Entry Number',   type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'je.entry_number' },
  { field: 'account_code',  label: 'Account Code',   type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'a.code' },
  { field: 'account_name',  label: 'Account Name',   type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'a.name' },
  { field: 'account_type',  label: 'Account Type',   type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'a.type' },
  { field: 'description',   label: 'Description',    type: 'text',     sortable: false, filterable: true,  totalable: false, sqlExpr: 'jl.description' },
  { field: 'reference',     label: 'Reference',      type: 'text',     sortable: false, filterable: true,  totalable: false, sqlExpr: 'je.reference' },
  { field: 'debit',         label: 'Debit',          type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'jl.debit_amount' },
  { field: 'credit',        label: 'Credit',         type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'jl.credit_amount' },
  { field: 'vat_type',      label: 'VAT Type',       type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'jl.vat_type' },
  { field: 'cost_centre',   label: 'Cost Centre',    type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'jl.cost_centre_id' },
  { field: 'project',       label: 'Project',        type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'jl.project_id' },
  { field: 'status',        label: 'Status',         type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'je.status' },
  { field: 'source',        label: 'Source',         type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'je.source' },
  { field: 'created_by',   label: 'Created By',     type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'je.created_by' },
];

const CUSTOMER_INVOICES: FieldDef[] = [
  { field: 'invoice_number',  label: 'Invoice Number',  type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'ci.invoice_number' },
  { field: 'customer_name',   label: 'Customer',        type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'c.name' },
  { field: 'invoice_date',    label: 'Invoice Date',    type: 'date',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'ci.invoice_date' },
  { field: 'due_date',        label: 'Due Date',        type: 'date',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'ci.due_date' },
  { field: 'total',           label: 'Total',           type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'ci.total_amount' },
  { field: 'tax',             label: 'Tax',             type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'ci.tax_amount' },
  { field: 'status',          label: 'Status',          type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'ci.status' },
  { field: 'amount_paid',     label: 'Amount Paid',     type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'ci.amount_paid' },
  { field: 'balance',         label: 'Balance',         type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: '(ci.total_amount - ci.amount_paid)' },
];

const SUPPLIER_INVOICES: FieldDef[] = [
  { field: 'invoice_number',  label: 'Invoice Number',  type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'si.invoice_number' },
  { field: 'supplier_name',   label: 'Supplier',        type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 's.name' },
  { field: 'invoice_date',    label: 'Invoice Date',    type: 'date',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'si.invoice_date' },
  { field: 'due_date',        label: 'Due Date',        type: 'date',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'si.due_date' },
  { field: 'total',           label: 'Total',           type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'si.total_amount' },
  { field: 'tax',             label: 'Tax',             type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'si.tax_amount' },
  { field: 'status',          label: 'Status',          type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'si.status' },
  { field: 'amount_paid',     label: 'Amount Paid',     type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'si.amount_paid' },
  { field: 'balance',         label: 'Balance',         type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: '(si.total_amount - si.amount_paid)' },
];

const BANK_TRANSACTIONS: FieldDef[] = [
  { field: 'date',          label: 'Date',          type: 'date',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'bt.transaction_date' },
  { field: 'description',   label: 'Description',   type: 'text',     sortable: false, filterable: true,  totalable: false, sqlExpr: 'bt.description' },
  { field: 'reference',     label: 'Reference',     type: 'text',     sortable: false, filterable: true,  totalable: false, sqlExpr: 'bt.reference' },
  { field: 'amount',        label: 'Amount',        type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'bt.amount' },
  { field: 'status',        label: 'Status',        type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'bt.status' },
  { field: 'bank_account',  label: 'Bank Account',  type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'ba.name' },
];

const CUSTOMERS: FieldDef[] = [
  { field: 'name',           label: 'Name',           type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'c.name' },
  { field: 'account_number', label: 'Account Number', type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'c.account_number' },
  { field: 'email',          label: 'Email',          type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'c.email' },
  { field: 'phone',          label: 'Phone',          type: 'text',     sortable: false, filterable: true,  totalable: false, sqlExpr: 'c.phone' },
  { field: 'vat_number',     label: 'VAT Number',     type: 'text',     sortable: false, filterable: true,  totalable: false, sqlExpr: 'c.vat_number' },
  { field: 'balance',        label: 'Balance',        type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'c.balance' },
  { field: 'credit_limit',   label: 'Credit Limit',   type: 'currency', sortable: true,  filterable: true,  totalable: false, sqlExpr: 'c.credit_limit' },
];

const SUPPLIERS: FieldDef[] = [
  { field: 'name',           label: 'Name',           type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 's.name' },
  { field: 'account_number', label: 'Account Number', type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 's.account_number' },
  { field: 'email',          label: 'Email',          type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 's.email' },
  { field: 'phone',          label: 'Phone',          type: 'text',     sortable: false, filterable: true,  totalable: false, sqlExpr: 's.phone' },
  { field: 'vat_number',     label: 'VAT Number',     type: 'text',     sortable: false, filterable: true,  totalable: false, sqlExpr: 's.vat_number' },
  { field: 'balance',        label: 'Balance',        type: 'currency', sortable: true,  filterable: true,  totalable: true,  sqlExpr: 's.balance' },
  { field: 'credit_limit',   label: 'Credit Limit',   type: 'currency', sortable: true,  filterable: true,  totalable: false, sqlExpr: 's.credit_limit' },
];

const ITEMS: FieldDef[] = [
  { field: 'item_code',          label: 'Item Code',         type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'i.item_code' },
  { field: 'item_name',          label: 'Item Name',         type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'i.name' },
  { field: 'category',           label: 'Category',          type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'i.category' },
  { field: 'unit_cost',          label: 'Unit Cost',         type: 'currency', sortable: true,  filterable: true,  totalable: false, sqlExpr: 'i.unit_cost' },
  { field: 'selling_price',      label: 'Selling Price',     type: 'currency', sortable: true,  filterable: true,  totalable: false, sqlExpr: 'i.selling_price' },
  { field: 'quantity_on_hand',   label: 'Qty on Hand',       type: 'number',   sortable: true,  filterable: true,  totalable: true,  sqlExpr: 'i.quantity_on_hand' },
];

const FIELD_MAP: Record<string, FieldDef[]> = {
  gl_transactions:   GL_TRANSACTIONS,
  customer_invoices: CUSTOMER_INVOICES,
  supplier_invoices: SUPPLIER_INVOICES,
  bank_transactions: BANK_TRANSACTIONS,
  customers:         CUSTOMERS,
  suppliers:         SUPPLIERS,
  items:             ITEMS,
};

export function getAvailableFields(dataSource: string): FieldDef[] {
  return FIELD_MAP[dataSource] ?? [];
}

export function getFieldDef(dataSource: string, field: string): FieldDef | undefined {
  return getAvailableFields(dataSource).find(f => f.field === field);
}

/** Returns the base FROM/JOIN clause for a data source */
export function getBaseQuery(dataSource: string): string {
  switch (dataSource) {
    case 'gl_transactions':
      return `FROM gl_journal_entries je
        JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
        JOIN gl_accounts a ON a.id = jl.account_id`;
    case 'customer_invoices':
      return `FROM customer_invoices ci
        LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)`;
    case 'supplier_invoices':
      return `FROM supplier_invoices si
        LEFT JOIN suppliers s ON s.id = si.supplier_id`;
    case 'bank_transactions':
      return `FROM bank_transactions bt
        LEFT JOIN bank_accounts ba ON ba.id = bt.bank_account_id`;
    case 'customers':
      return `FROM customers c`;
    case 'suppliers':
      return `FROM suppliers s`;
    case 'items':
      return `FROM items i`;
    default:
      return '';
  }
}

/** Returns the company_id WHERE fragment alias for a data source */
export function getCompanyAlias(dataSource: string): string {
  switch (dataSource) {
    case 'gl_transactions':   return 'je';
    case 'customer_invoices': return 'ci';
    case 'supplier_invoices': return 'si';
    case 'bank_transactions': return 'bt';
    case 'customers':         return 'c';
    case 'suppliers':         return 's';
    case 'items':             return 'i';
    default:                  return '';
  }
}
