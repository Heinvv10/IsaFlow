/**
 * Client-safe MCP constants — ZERO imports (ApexGEO bundle-safety pattern).
 * Safe to import from client components, docs pages, and the connect panel
 * without dragging server-only code into the browser bundle.
 *
 * CLIENT_MCP_TOOL_NAMES must track toolIndex.ts — a drift-guard test
 * (tests/unit/mcp/clientMetadata.test.ts) enforces the match.
 */

export const MCP_PATH = '/api/mcp';
export const MCP_PROD_ORIGIN = 'https://app.isaflow.co.za';
export const MCP_PROD_ENDPOINT = `${MCP_PROD_ORIGIN}${MCP_PATH}`;
export const MCP_AUTH_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';
export const MCP_PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** All MCP tool names (43 read + 33 write). Drift-guarded against toolIndex. */
export const CLIENT_MCP_TOOL_NAMES = [
  // read
  'company_profile',
  'list_companies',
  'trial_balance',
  'profit_and_loss',
  'balance_sheet',
  'aged_debtors',
  'aged_creditors',
  'search_gl',
  'list_gl_accounts',
  'list_invoices',
  'get_invoice',
  'list_quotes',
  'list_customers',
  'list_suppliers',
  'bank_accounts_status',
  'list_bank_transactions',
  'get_match_candidates',
  'vat_status',
  'list_agent_postings',
  'list_supplier_invoices',
  'get_supplier_invoice',
  'list_bank_rules',
  'get_bank_rule',
  'list_import_batches',
  'list_journals',
  'list_bank_reconciliations',
  'list_practice_clients',
  'list_job_categories',
  'list_work_items',
  'list_time_entries',
  'list_credit_notes',
  'get_credit_note',
  'list_employees',
  'list_pay_runs',
  'customer_statement',
  'project_profitability',
  'wip_report',
  'list_fixed_assets',
  'asset_register',
  'list_items',
  'stock_valuation',
  'supplier_statement',
  'job_cost_report',
  // write
  'create_draft_invoice',
  'create_draft_quote',
  'create_draft_journal',
  'suggest_bank_allocation',
  'post_journal',
  'finalize_invoice',
  'allocate_bank_transaction',
  'reverse_bank_allocation',
  'bulk_allocate_bank_transactions',
  'reverse_bank_allocation_batch',
  'import_bank_statement',
  'undo_bank_import',
  'create_gl_account',
  'update_gl_account',
  'deactivate_gl_account',
  'create_supplier_invoice',
  'approve_supplier_invoice',
  'create_bank_rule',
  'update_bank_rule',
  'disable_bank_rule',
  'reverse_allocations',
  'set_opening_balance',
  'attach_document',
  'cancel_bank_reconciliation',
  'create_job_category',
  'create_work_item',
  'log_time_entry',
  'submit_time_entries',
  'create_credit_note',
  'approve_credit_note',
  'cancel_credit_note',
  'create_pay_run',
  'post_payroll_journal',
] as const;
