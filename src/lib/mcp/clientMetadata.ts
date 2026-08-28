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

/** All MCP tool names (18 read + 12 write). Drift-guarded against toolIndex. */
export const CLIENT_MCP_TOOL_NAMES = [
  // read
  'company_profile',
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
] as const;
