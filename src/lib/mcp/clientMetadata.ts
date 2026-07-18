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

/** Read tools (Phase 2). Write tools append here in Phase 3. */
export const CLIENT_MCP_TOOL_NAMES = [
  'company_profile',
  'trial_balance',
  'profit_and_loss',
  'balance_sheet',
  'aged_debtors',
  'aged_creditors',
  'search_gl',
  'list_invoices',
  'get_invoice',
  'list_quotes',
  'list_customers',
  'list_suppliers',
  'bank_accounts_status',
  'list_bank_transactions',
  'vat_status',
] as const;
