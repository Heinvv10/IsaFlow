/**
 * What the Demo reseed deletes, in what order, and what it keeps. Data only.
 *
 * WIPE_STEPS is the catalog's foreign-key order over every public table with a
 * company_id that is not setup, plus the child tables without a company_id that
 * hang off them (PLAN 3.3): children first, so each DELETE meets no surviving
 * reference. Every step is scoped to the company: `company_id = $1`, or for a
 * child table without one, "a foreign key names a row of a Demo-scoped parent".
 * Table names come only from this file, never from input. The integration test
 * re-derives the order from the live catalog so a new migration cannot make it
 * stale silently, and the census guard refuses to run when a table holds Demo
 * rows and is in neither list.
 */

export interface WipeStep {
  table: string;
  /** For a table without company_id: [fk column, parent table] pairs; a row goes when any names a Demo parent row. */
  via?: ReadonlyArray<readonly [string, string]>;
  /** Rows of this table that must survive (an append-only row names them). */
  preserve?: string;
}

export const WIPE_STEPS: readonly WipeStep[] = [
  // Tier 1
  { table: 'accounting_adjustments' },
  { table: 'afs_generation_log' },
  { table: 'afs_section_comments' },
  { table: 'afs_uploaded_images' },
  { table: 'ap_payment_document_backfill' },
  { table: 'asset_depreciation_schedule', via: [['asset_id', 'assets'], ['journal_entry_id', 'gl_journal_entries']] },
  { table: 'asset_disposals', via: [['asset_id', 'assets'], ['journal_entry_id', 'gl_journal_entries']] },
  { table: 'asset_period_ledger' },
  { table: 'bank_allocation_batch_lines' },
  { table: 'bank_categorisation_rules' },
  { table: 'bank_feed_sync_log', via: [['connection_id', 'bank_feed_connections']] },
  { table: 'bank_feed_sync_logs' },
  { table: 'bank_feed_transaction_conflicts' },
  { table: 'bank_rules' },
  { table: 'bank_statement_imports' },
  { table: 'bank_transaction_attachments', via: [['bank_transaction_id', 'bank_transactions']] },
  { table: 'bank_transfer_link_log' },
  { table: 'bank_tx_queries' },
  { table: 'capture_whatsapp_claims' },
  { table: 'categorization_decisions' },
  { table: 'categorization_patterns' },
  { table: 'close_run_proposals' },
  { table: 'compliance_alerts' },
  { table: 'credit_note_allocations' },
  { table: 'credit_note_expense_allocations' },
  { table: 'credit_note_revenue_allocations' },
  { table: 'customer_activities' },
  { table: 'customer_contacts' },
  { table: 'customer_delivery_addresses' },
  { table: 'customer_dunning_overrides' },
  { table: 'customer_invoice_disputes' },
  { table: 'customer_invoice_views' },
  { table: 'customer_payment_allocations', via: [['invoice_id', 'customer_invoices'], ['payment_id', 'customer_payments']] },
  { table: 'customer_quote_lines', via: [['quote_id', 'customer_quotes']] },
  { table: 'customer_sales_order_items', via: [['sales_order_id', 'customer_sales_orders']] },
  { table: 'customer_write_offs' },
  { table: 'delivery_note_lines', via: [['delivery_note_id', 'delivery_notes']] },
  { table: 'dimension_tag_batch_bank_rows' },
  { table: 'dimension_tag_batch_lines' },
  { table: 'document_validation_results' },
  { table: 'dunning_sends' },
  { table: 'entity_udf_values' },
  { table: 'expected_invoice_alerts' },
  { table: 'expense_claim_lines' },
  { table: 'fraud_alerts' },
  { table: 'gl_entry_date_corrections' },
  { table: 'gl_journal_document_links' },
  { table: 'gl_migration_comparisons' },
  { table: 'gl_migration_runs' },
  { table: 'grn_items', via: [['grn_id', 'goods_received_notes'], ['product_id', 'products']] },
  { table: 'item_bundle_lines' },
  { table: 'leave_applications' },
  { table: 'loan_compliance_assessments' },
  { table: 'loan_events' },
  { table: 'loan_gl_postings' },
  { table: 'loan_payments' },
  { table: 'loan_period_locks' },
  { table: 'loan_rate_points', via: [['curve_id', 'loan_rate_curves']] },
  { table: 'loan_reclass_backfill_refusals' },
  { table: 'loan_reclass_postings' },
  { table: 'loan_schedule_rows', via: [['run_id', 'loan_schedule_runs']] },
  { table: 'migration_sessions' },
  { table: 'netcash_submissions' },
  { table: 'payment_allocations', via: [['invoice_id', 'supplier_invoices'], ['payment_id', 'supplier_payments']] },
  { table: 'payroll_bank_details' },
  { table: 'payroll_batch_lines', via: [['batch_id', 'payroll_batches'], ['employee_id', 'payroll_employees']] },
  { table: 'payroll_employee_components', via: [['employee_id', 'payroll_employees']] },
  { table: 'payroll_employee_cost_allocations' },
  { table: 'payroll_employee_fringe_benefits' },
  { table: 'payroll_employee_history' },
  { table: 'payroll_external_payslips' },
  { table: 'payroll_leave_balances' },
  { table: 'payroll_leave_requests' },
  { table: 'payroll_loan_payment_reversals' },
  { table: 'payroll_loan_payments', via: [['loan_id', 'payroll_loans'], ['run_id', 'payroll_run_headers']] },
  { table: 'payroll_run_directive_uses' },
  { table: 'payroll_run_lines', via: [['employee_id', 'payroll_employees'], ['run_id', 'payroll_run_headers']] },
  { table: 'pop_archive_attempts' },
  { table: 'pop_archive_copies' },
  { table: 'portal_access' },
  { table: 'portal_magic_links' },
  { table: 'practice_client_contacts' },
  { table: 'practice_client_rate_overrides' },
  { table: 'practice_entry_templates' },
  { table: 'practice_report_recipients' },
  { table: 'practice_tasks' },
  { table: 'project_expenses', via: [['project_id', 'projects']] },
  { table: 'project_time_entries' },
  { table: 'proof_of_payment_matches' },
  { table: 'reclassification_batch_lines' },
  { table: 'record_comments' },
  { table: 'recurring_invoices' },
  { table: 'recurring_journals' },
  { table: 'recurring_transaction_templates' },
  { table: 'report_annotations' },
  { table: 'report_commentary' },
  { table: 'sage_accounts' },
  { table: 'sage_customer_invoices' },
  { table: 'sage_ledger_transactions' },
  { table: 'sage_supplier_invoices' },
  { table: 'sales_reps' },
  { table: 'sars_compliance_events' },
  { table: 'sars_efiling_events' },
  { table: 'share_link_views' },
  { table: 'soft_delete_journal_reversals' },
  { table: 'stock_adjustments' },
  { table: 'stock_items' },
  // company_id since migration 1002 (rows of a product with no company have none and are nobody's).
  { table: 'stock_levels' },
  { table: 'stock_movements' },
  { table: 'supplier_activities' },
  { table: 'supplier_coding_history' },
  { table: 'supplier_coding_rules' },
  { table: 'supplier_contacts' },
  { table: 'supplier_invoice_items', via: [['supplier_invoice_id', 'supplier_invoices']] },
  { table: 'supplier_payment_allocations', via: [['invoice_id', 'supplier_invoices'], ['payment_id', 'supplier_payments']] },
  { table: 'supplier_purchase_order_items', via: [['purchase_order_id', 'supplier_purchase_orders']] },
  { table: 'supplier_statement_lines', via: [['matched_supplier_invoice_id', 'supplier_invoices'], ['reconciliation_id', 'supplier_statement_reconciliations']] },
  { table: 'tax_directive_payments' },
  { table: 'training_events' },
  { table: 'uif_declarations' },
  { table: 'user_notifications' },
  { table: 'vat_adjustments' },
  { table: 'vat_gate_overrides' },
  { table: 'vat_period_locks', preserve: 'id IN (SELECT vat_period_lock_id FROM tax_return_versions WHERE company_id = $1::uuid AND vat_period_lock_id IS NOT NULL)' },
  { table: 'vat_returns' },
  // Tier 2
  { table: 'afs_sections' },
  { table: 'bank_allocation_batches' },
  { table: 'bank_transactions' },
  { table: 'capture_events' },
  { table: 'close_runs' },
  { table: 'credit_notes' },
  { table: 'customer_invoice_items', via: [['invoice_id', 'customer_invoices'], ['project_id', 'projects'], ['time_entry_id', 'time_entries']] },
  { table: 'customer_payments' },
  { table: 'customer_quotes' },
  { table: 'delivery_notes' },
  { table: 'dimension_tag_batches' },
  { table: 'expense_claims' },
  { table: 'goods_received_notes' },
  { table: 'loan_schedule_runs' },
  { table: 'payroll_batches' },
  { table: 'payroll_external_imports' },
  { table: 'payroll_loan_schedule', via: [['loan_id', 'payroll_loans']] },
  { table: 'payroll_run_headers' },
  { table: 'po_items', via: [['product_id', 'products'], ['purchase_order_id', 'purchase_orders']] },
  // After every table whose lines name an item (po_items, the bill / invoice / quote lines, stock_movements): item_id FKs, migration 1002.
  { table: 'items' },
  { table: 'portal_contacts' },
  { table: 'project_tasks', via: [['project_id', 'projects']] },
  { table: 'proof_of_payments' },
  { table: 'reclassification_batches' },
  { table: 'sars_submissions', preserve: 'id IN (SELECT sars_submission_id FROM tax_return_versions WHERE company_id = $1::uuid AND sars_submission_id IS NOT NULL)' },
  { table: 'share_links' },
  { table: 'supplier_expectations' },
  { table: 'supplier_payment_batches' },
  { table: 'supplier_payments' },
  { table: 'supplier_purchase_orders' },
  { table: 'supplier_statement_reconciliations' },
  { table: 'tax_directives' },
  { table: 'warehouses' },
  // Tier 3
  { table: 'afs_documents' },
  { table: 'bank_auto_post_runs' },
  { table: 'bank_feed_connections' },
  { table: 'bank_import_batches' },
  { table: 'bank_reconciliations' },
  { table: 'customer_sales_orders' },
  { table: 'fleet_fuel_transactions' },
  { table: 'fleet_service_history' },
  { table: 'gl_journal_lines' },
  { table: 'loans' },
  { table: 'payroll_loans' },
  { table: 'products' },
  { table: 'projects' },
  { table: 'purchase_orders' },
  { table: 'supplier_invoices' },
  { table: 'time_entries' },
  // Tier 4
  { table: 'assets' },
  { table: 'customer_invoices' },
  { table: 'gl_journal_entries' },
  { table: 'loan_rate_curves' },
  { table: 'payroll_employees' },
  { table: 'practice_jobs' },
  { table: 'practice_work_items' },
  { table: 'suppliers' },
  // Tier 5
  { table: 'captured_documents' },
  { table: 'customers' },
  { table: 'practice_clients' },
  // Tier 6
  { table: 'practice_client_groups' },
];

/**
 * The balance cache: no company_id, keyed by account. Emptied AFTER the journals
 * (their delete trigger re-creates a missing cache row) and rebuilt after the seed.
 */
export const BALANCE_CACHE_STEP: WipeStep = { table: 'gl_account_balances', via: [['gl_account_id', 'gl_accounts']] };

/** Tables with a company_id the reseed never writes (PLAN 3.4): setup, plans, append-only history, billing. */
export const KEEP_TABLES: readonly string[] = [
  'bureau_companies', 'personal_access_tokens', 'oauth_authorisations', 'oauth_authorisation_codes', 'capture_api_keys',
  'capture_inboxes', 'webhook_endpoints',
  'gl_accounts', 'gl_account_merges', 'account_reporting_groups', 'account_external_mapping', 'afs_account_mappings',
  'afs_statement_lines', 'group_coa_mappings', 'fiscal_years', 'fiscal_periods', 'fiscal_year_end_changes', 'business_units',
  'cost_centres', 'cost_centre_aliases', 'cost_centre_gl_mappings',
  'accounting_settings', 'currencies', 'exchange_rates',
  'bank_auto_post_settings', 'bank_accounts', 'brand_profiles', 'dunning_settings', 'dunning_templates', 'management_pack_configs',
  'custom_report_templates', 'transaction_description_templates', 'customer_categories', 'supplier_categories', 'item_categories',
  'product_categories', 'asset_locations', 'practice_job_categories', 'practice_staff_rates', 'practice_staff_cost_rates',
  'payroll_company_settings', 'payroll_gl_accounts', 'payroll_components', 'payroll_leave_types', 'pay_scales', 'pay_packages',
  'pop_archive_targets', 'pop_trusted_payers', 'imap_mirror_connections', 'imap_mirror_scan_log', 'sent_mirror_connections',
  'sent_mirror_scan_log', 'disclosure_notes_manual', 'accounting_budgets',
  'entity_changes', 'bank_rule_changes',
  'bank_rule_change_decisions', 'tax_return_versions', 'flow_ledger', 'supplier_bank_verifications',
  'subscriptions', 'subscription_charges', 'subscription_mandates', 'admin_invoices', 'flow_wallet', 'flow_purchases',
  'paystack_payment_requests', 'stitch_payment_requests', 'payment_transactions', 'analytics_websites', 'page_visits',
  'mcp_tool_calls', 'http_idempotency_keys', 'background_jobs', 'email_log',
];

/**
 * Whole families kept by name prefix: the company's own identity and access tables, every budget
 * table, the audit history (append-only), and the approval configuration and request history
 * (approval requests are an audit trail of who approved what; the reseed never writes them).
 */
export const KEEP_PREFIXES: readonly string[] = ['company_', 'budget_', 'audit_', 'approval_'];

/** Append-only tables whose surviving rows post-check R1 reports as residual. */
export const PRESERVE_APPEND_ONLY: readonly string[] = [
  // The audit snapshot tables are kept by the audit_ prefix and counted in R2; only their own readers name them.
  'tax_return_versions',
  'entity_changes', 'bank_rule_changes',
];

/** The one configuration row family the wipe trims: the QA mailbox (and its scan log). */
export const QA_MAILBOX_NAME = 'QA Demo Mailbox';

/**
 * Kept billing tables whose invoice-payment requests name a Demo invoice. A customer_invoice request must
 * keep its invoice (CHECK *_pr_invoice_has_invoice), so those rows go with the invoices; the rest stay.
 */
export const INVOICE_PAYMENT_REQUEST_TABLES: readonly string[] = ['paystack_payment_requests', 'stitch_payment_requests'];

export function invoiceRequestWhere(): string {
  return "company_id = $1::uuid AND purpose = 'customer_invoice' AND customer_invoice_id IS NOT NULL";
}

/** Kept tables that are append-only history: their text is reported (R1), never failed on, since it cannot be changed. */
export function isAppendOnlyKept(table: string): boolean {
  return PRESERVE_APPEND_ONLY.includes(table) || table.startsWith('audit_');
}

export function isKept(table: string): boolean {
  return KEEP_TABLES.includes(table) || KEEP_PREFIXES.some((p) => table.startsWith(p));
}

/** The WHERE clause of a step; `$1` is always the company id, never interpolated. */
export function stepWhere(step: WipeStep): string {
  const scope = step.via
    ? step.via.map(([col, parent]) => `${col} IN (SELECT id FROM ${parent} WHERE company_id = $1::uuid)`).join(' OR ')
    : 'company_id = $1::uuid';
  return step.preserve ? `(${scope}) AND NOT (${step.preserve})` : scope;
}

/**
 * For a child step with more than one foreign key: rows the step would delete (a Demo parent) that ALSO name a
 * parent row of another company. Corrupt data the run refuses rather than deleting another tenant's link silently.
 */
export function crossTenantSql(step: WipeStep): string | null {
  if (!step.via || step.via.length < 2) return null;
  const foreign = step.via.map(([col, parent]) => `${col} IN (SELECT id FROM ${parent} WHERE company_id <> $1::uuid)`).join(' OR ');
  return `SELECT count(*)::int AS n FROM ${step.table} WHERE (${stepWhere(step)}) AND (${foreign})`;
}

/** Kept tables whose Demo rows a wiped parent removes by ON DELETE CASCADE: [table, fk column, parent]. Counted, not kept. */
export const CASCADE_WITH: ReadonlyArray<readonly [string, string, string]> = [
  ['supplier_bank_verifications', 'supplier_id', 'suppliers'],
];

export function countSql(step: WipeStep): string {
  return `SELECT count(*)::int AS n FROM ${step.table} WHERE ${stepWhere(step)}`;
}

export function deleteSql(step: WipeStep): string {
  return `DELETE FROM ${step.table} WHERE ${stepWhere(step)}`;
}
