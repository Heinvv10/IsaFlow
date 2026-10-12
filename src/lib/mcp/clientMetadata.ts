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

/**
 * All MCP tool names — 74 read + 83 write = 157. Drift-guarded against
 * toolIndex.ts by tests/unit/mcp/clientMetadata.test.ts, which compares the
 * ARRAY rather than this comment; the comment is the part that can rot, so it
 * is derived by counting `MCP_TOOLS.filter(t => !t.write)` and not by hand.
 */
export const CLIENT_MCP_TOOL_NAMES = [
  // read
  'company_profile',
  'list_companies',
  'trial_balance',
  'profit_and_loss',
  'balance_sheet',
  'aged_debtors',
  'aged_creditors',
  'reconcile_subledger',
  'general_ledger',
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
  'vat_reconciliation',
  'vat201_export',
  'vat_exceptions',
  'data_integrity_checks',
  'chart_of_accounts_health',
  'lock_vat_period',
  'mark_vat_declared_elsewhere',
  'list_agent_postings',
  'audit_trail',
  'entity_history',
  'list_documents',
  'get_document',
  'list_unsupported_transactions',
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
  'suggest_receipt_matches',
  'list_unapplied_receipts',
  'list_unapplied_payments',
  'list_supplier_payments',
  'list_fiscal_periods',
  'get_fiscal_period',
  'period_close_checklist',
  'bank_statement_coverage',
  'get_opening_balances',
  'list_employees',
  'get_employee',
  'list_payroll_components',
  'list_employee_components',
  'list_pay_runs',
  'emp201_status',
  'irp5_data',
  'customer_statement',
  'project_profitability',
  'wip_report',
  'list_fixed_assets',
  'asset_register',
  'reconcile_fixed_assets',
  'run_depreciation',
  'list_items',
  'stock_valuation',
  'supplier_statement',
  'job_cost_report',
  'budget_variance',
  'propose_reclassification',
  'list_cost_centres',
  'list_business_units',
  'export_gl_lines',
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
  'post_reclassification_batch',
  'import_bank_statement',
  'undo_bank_import',
  'create_gl_account',
  'update_gl_account',
  'deactivate_gl_account',
  'merge_gl_accounts',
  'create_supplier_invoice',
  'approve_supplier_invoice',
  'bulk_create_supplier_invoices',
  'bulk_approve_supplier_invoices',
  'bulk_finalize_invoices',
  'bulk_approve_credit_notes',
  'bulk_create_customer_invoices',
  'void_receipt',
  'void_payment',
  'create_employee',
  'update_employee',
  'assign_employee_component',
  'end_employee_component',
  'calculate_pay_run',
  'approve_pay_run',
  'create_bank_rule',
  'update_bank_rule',
  'disable_bank_rule',
  'reverse_allocations',
  'set_opening_balance',
  'attach_document',
  'cancel_bank_reconciliation',
  'reopen_bank_reconciliation',
  'create_job_category',
  'create_work_item',
  'log_time_entry',
  'submit_time_entries',
  'create_credit_note',
  'approve_credit_note',
  'cancel_credit_note',
  'apply_receipt_to_invoice',
  'apply_payment_to_supplier_invoice',
  'auto_apply_unapplied',
  'apply_credit_note',
  'cancel_supplier_invoice',
  'update_supplier_invoice',
  'unapply_supplier_payment',
  'unapply_credit_note',
  'reverse_journal_entry',
  'settle_by_contra',
  'create_customer',
  'update_customer',
  'create_supplier',
  'update_supplier',
  'close_fiscal_period',
  'reopen_fiscal_period',
  'year_end_close',
  'perform_bank_reconciliation',
  'create_pay_run',
  'post_payroll_journal',
  'link_document_to_journal',
  'create_cost_centre',
  'create_business_unit',
  'update_cost_centre',
  'delete_cost_centre',
  'update_business_unit',
  'delete_business_unit',
  'set_gl_account_reporting_attributes',
  'set_customer_default_fno',
  'set_bank_account_default_dimensions',
  'split_allocate_bank_transaction',
  'tag_journal_lines',
  'reverse_dimension_tag_batch',
] as const;

export function appOrigin(): string {
  // Trailing slash would double up in every `${base}/path` below.
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.isaflow.co.za').replace(/\/+$/, '');
}

/**
 * Server branding for the client's connector list (SEP-973, spec revision
 * 2025-11-25 — declared ahead of MCP_PROTOCOL_VERSION; the 2025-06-18
 * Implementation schema sets no additionalProperties:false, so clients that
 * predate the field pass it through). Absolute URIs: a remote client has no
 * base to resolve a relative path against. Both PNGs are the white-on-teal
 * mark from public/icons/, which reads on light and dark, so no `theme` split.
 *
 * Motivation: with no server-supplied icon, a client falls back to scraping a
 * favicon off the domain. On 2026-08-09 claude.ai's connector list rendered the
 * .co.za registry's logo (ZA Central Registry) next to IsaFlow — the icon was
 * byte-matched to registry.net.za's favicon. Our own /favicon.ico is correct
 * and served, so the fallback, not our assets, produced it.
 */
export function serverIcons(): Array<{ src: string; mimeType: string; sizes: string[] }> {
  const base = appOrigin();
  return [
    { src: `${base}/icons/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'] },
    { src: `${base}/icons/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] },
  ];
}
