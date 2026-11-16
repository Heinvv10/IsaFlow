/**
 * The tables and columns the NL-query prompt shows the model. The prompt tells it to filter `company_id` on every table
 * that has the column, and the tenant guard (nlQueryScopeGuard) now needs every alias seeded across an id-only FK, so a
 * table listed WITHOUT its `company_id` makes a compliant model write a query the guard refuses. Every table that has
 * the column must list it (tests/unit/ai/nlQuerySchemaTables.test.ts reads the schema baseline).
 */
import type { SchemaTable } from './nlQueryService';

export const SCHEMA_TABLES: SchemaTable[] = [
  { name: 'customer_invoices', columns: ['id', 'customer_id', 'invoice_number', 'invoice_date', 'due_date', 'total_amount', 'amount_paid', 'status', 'company_id'], description: 'Customer/sales invoices' },
  { name: 'customers', columns: ['id', 'name', 'email', 'payment_terms', 'payment_terms_type', 'is_active', 'company_id'], description: 'Customer master data' },
  { name: 'supplier_invoices', columns: ['id', 'supplier_id', 'invoice_number', 'invoice_date', 'total_amount', 'amount_paid', 'status', 'company_id'], description: 'Supplier/purchase invoices' },
  { name: 'suppliers', columns: ['id', 'name', 'email', 'is_active', 'company_id'], description: 'Supplier master data' },
  { name: 'gl_accounts', columns: ['id', 'account_code', 'account_name', 'account_type', 'is_active', 'company_id'], description: 'Chart of accounts (GL)' },
  { name: 'gl_journal_entries', columns: ['id', 'entry_number', 'entry_date', 'description', 'status', 'source', 'company_id'], description: 'Journal entries' },
  { name: 'gl_journal_lines', columns: ['id', 'journal_entry_id', 'gl_account_id', 'debit', 'credit', 'description', 'company_id'], description: 'Journal entry lines (debits/credits)' },
  { name: 'bank_transactions_posted', columns: ['id', 'bank_account_id', 'transaction_date', 'description', 'amount', 'status', 'company_id'], description: 'Bank statement lines (posted at the bank only) — has company_id, filter directly' },
  { name: 'products', columns: ['id', 'code', 'name', 'cost_price', 'selling_price', 'current_stock', 'company_id'], description: 'Products/inventory items' },
  { name: 'employees', columns: ['id', 'first_name', 'last_name', 'email', 'basic_salary', 'employment_type', 'company_id'], description: 'Employee master data' },
  { name: 'payslips', columns: ['id', 'employee_id', 'payroll_run_id', 'gross_pay', 'net_pay', 'paye', 'uif_employee'], description: 'Payslips per payroll run' },
  { name: 'projects', columns: ['id', 'project_number', 'name', 'client_id', 'status', 'budget_amount', 'total_revenue', 'total_cost', 'company_id'], description: 'Projects/jobs' },
];
