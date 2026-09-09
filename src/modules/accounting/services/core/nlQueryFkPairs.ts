/**
 * Verified FK->PK column pairs among the NL-query allowlisted tables, each stored
 * as a lexicographically-sorted `tableA.colA|tableB.colB` string so lookup is
 * orientation-independent. Only pairs whose parent column is the primary key.
 *
 * Generated from the live schema (real FOREIGN KEY constraints among the NL-query
 * allowlisted tables). Regenerate when those foreign keys change. Tables/edges
 * absent here are simply unreachable -> their queries are rejected, never leaked.
 *
 * Consumed by nlQueryScopeGuard.ts to decide which `A.col = B.col` predicates may
 * propagate tenant scope across a join.
 */
export const FK_PAIRS = new Set<string>([
  'accounting_budgets.gl_account_id|gl_accounts.id',
  'asset_categories.gl_asset_account_id|gl_accounts.id',
  'asset_categories.gl_depreciation_account_id|gl_accounts.id',
  'asset_categories.gl_expense_account_id|gl_accounts.id',
  'asset_categories.id|assets.category_id',
  'asset_depreciation_schedule.asset_id|assets.id',
  'asset_depreciation_schedule.journal_entry_id|gl_journal_entries.id',
  'asset_disposals.asset_id|assets.id',
  'asset_disposals.journal_entry_id|gl_journal_entries.id',
  'assets.gl_asset_account_id|gl_accounts.id',
  'assets.gl_depreciation_account_id|gl_accounts.id',
  'assets.gl_expense_account_id|gl_accounts.id',
  'bank_accounts.gl_account_id|gl_accounts.id',
  'bank_categorisation_rules.gl_account_id|gl_accounts.id',
  'bank_categorisation_rules.supplier_id|suppliers.id',
  'bank_reconciliations.bank_account_id|gl_accounts.id',
  'bank_reconciliations.id|bank_transactions.reconciliation_id',
  'bank_transactions.bank_account_id|gl_accounts.id',
  'bank_transactions.matched_journal_line_id|gl_journal_lines.id',
  'bank_transactions.predicted_supplier_id|suppliers.id',
  'bank_transactions.provisional_je_id|gl_journal_entries.id',
  'captured_documents.id|customer_invoices.source_document_id',
  'captured_documents.id|dunning_sends.source_document_id',
  'captured_documents.id|gl_journal_entries.source_document_id',
  'captured_documents.id|supplier_invoices.source_document_id',
  'cost_centres.id|cost_centres.parent_id',
  'credit_notes.client_id|customers.id',
  'credit_notes.customer_invoice_id|customer_invoices.id',
  'credit_notes.gl_journal_entry_id|gl_journal_entries.id',
  'credit_notes.supplier_id|suppliers.id',
  'credit_notes.supplier_invoice_id|supplier_invoices.id',
  'customer_invoice_items.invoice_id|customer_invoices.id',
  'customer_invoice_items.time_entry_id|time_entries.id',
  'customer_invoices.customer_id|customers.id',
  'customer_invoices.id|customer_payment_allocations.invoice_id',
  'customer_invoices.id|customer_quotes.converted_invoice_id',
  'customer_invoices.id|customer_sales_orders.invoice_id',
  'customer_invoices.id|customer_write_offs.invoice_id',
  'customer_invoices.id|dunning_sends.customer_invoice_id',
  'customer_payment_allocations.payment_id|customer_payments.id',
  'customer_payments.bank_account_id|gl_accounts.id',
  'customer_payments.client_id|customers.id',
  'customer_payments.gl_journal_entry_id|gl_journal_entries.id',
  'customer_quote_lines.quote_id|customer_quotes.id',
  'customer_quotes.client_id|customers.id',
  'customer_sales_order_items.sales_order_id|customer_sales_orders.id',
  'customer_sales_orders.customer_id|customers.id',
  'customer_write_offs.client_id|customers.id',
  'customer_write_offs.gl_journal_entry_id|gl_journal_entries.id',
  'customers.id|projects.client_id',
  'customers.id|recurring_invoices.client_id',
  'dunning_sends.template_id|dunning_templates.id',
  'fiscal_periods.id|gl_account_balances.fiscal_period_id',
  'fiscal_periods.id|gl_journal_entries.fiscal_period_id',
  'gl_account_balances.gl_account_id|gl_accounts.id',
  'gl_accounts.id|gl_accounts.parent_account_id',
  'gl_accounts.id|gl_journal_lines.gl_account_id',
  'gl_accounts.id|product_categories.gl_cogs_account_id',
  'gl_accounts.id|product_categories.gl_inventory_account_id',
  'gl_accounts.id|product_categories.gl_revenue_account_id',
  'gl_accounts.id|products.gl_cogs_account_id',
  'gl_accounts.id|products.gl_inventory_account_id',
  'gl_accounts.id|products.gl_revenue_account_id',
  'gl_accounts.id|supplier_invoice_items.gl_account_id',
  'gl_accounts.id|supplier_payment_batches.bank_account_id',
  'gl_accounts.id|supplier_payments.bank_account_id',
  'gl_journal_entries.id|gl_journal_entries.reversal_of_id',
  'gl_journal_entries.id|gl_journal_lines.journal_entry_id',
  'gl_journal_entries.id|stock_adjustments.journal_entry_id',
  'gl_journal_entries.id|supplier_invoices.gl_journal_entry_id',
  'gl_journal_entries.id|supplier_payment_batches.gl_journal_entry_id',
  'gl_journal_entries.id|supplier_payments.gl_journal_entry_id',
  'gl_journal_entries.id|vat_adjustments.gl_journal_entry_id',
  'gl_journal_entries.id|vat_returns.journal_entry_id',
  'leave_applications.leave_type_id|leave_types.id',
  'leave_balances.leave_type_id|leave_types.id',
  'product_categories.id|product_categories.parent_id',
  'product_categories.id|products.category_id',
  'products.id|stock_adjustments.product_id',
  'project_time_entries.project_id|projects.id',
  'purchase_orders.supplier_id|suppliers.id',
  'supplier_invoice_items.supplier_invoice_id|supplier_invoices.id',
  'supplier_invoices.id|supplier_payment_allocations.invoice_id',
  'supplier_invoices.supplier_id|suppliers.id',
  'supplier_payment_allocations.payment_id|supplier_payments.id',
  'supplier_payments.supplier_id|suppliers.id',
  'supplier_purchase_order_items.purchase_order_id|supplier_purchase_orders.id',
  'supplier_purchase_orders.supplier_id|suppliers.id',
]);

// Invariant: the tenant key `company_id` is NEVER a modeled FK edge. An edge
// exists only to propagate scope across a real FK->PK join; allowing a
// `company_id` column as an edge endpoint would let a non-tenant-preserving
// join mark an alias reachable. Fail loudly at load if regeneration violates it.
for (const pair of FK_PAIRS) {
  if (/(^|\|)[a-z_]+\.company_id($|\|)/.test(pair)) {
    throw new Error(`nlQueryScopeGuard: FK_PAIRS must not contain a company_id edge: ${pair}`);
  }
}

/**
 * Allowlisted tables that carry no company_id column (verified against the
 * live schema). Rows in these tables are either global reference data
 * (asset_categories, leave_types) or children bound to a tenant only through
 * their parent. Scope may flow INTO such a table from a tenant-scoped parent,
 * but never OUT of it: a global row is shared by every tenant, so a join back
 * through it (assets -> asset_categories -> assets) would reach other tenants.
 */
export const NO_COMPANY_TABLES = new Set<string>([
  'asset_categories', 'asset_depreciation_schedule', 'asset_disposals',
  'customer_invoice_items', 'customer_payment_allocations', 'customer_quote_lines',
  'customer_sales_order_items', 'gl_account_balances', 'leave_balances', 'leave_types',
  'supplier_invoice_items', 'supplier_payment_allocations', 'supplier_purchase_order_items',
]);
