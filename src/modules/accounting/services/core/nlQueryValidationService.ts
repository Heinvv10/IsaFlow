/**
 * NL Query Validation Service
 * SQL safety validation extracted from nlQueryService.ts.
 */

export interface SQLValidation {
  valid: boolean;
  error?: string;
  sanitizedSQL: string;
}

// DML/DDL keywords that must never appear in a read-only query
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE',
  'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'INFORMATION_SCHEMA',
  'PG_CATALOG', 'INTO OUTFILE', 'LOAD_FILE',
  'COPY', 'DO', 'CALL', 'PREPARE', 'LISTEN', 'NOTIFY', 'LOAD', 'IMPORT',
  'PG_READ_FILE', 'PG_READ_BINARY_FILE', 'PG_LS_DIR',
  'LO_IMPORT', 'LO_EXPORT', 'PG_SLEEP',
  'CURRENT_SETTING', 'SET_CONFIG', 'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND',
  'VACUUM', 'EXPLAIN',
];

const FORBIDDEN_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'pg_ reference', regex: /\bpg_/i },
  { label: 'information_schema reference', regex: /\binformation_schema\b/i },
  { label: 'dblink call', regex: /\bdblink\s*\(/i },
  { label: 'COPY TO/FROM', regex: /\bCOPY\b[\s\S]*?\b(TO|FROM)\b/i },
  { label: 'SET statement', regex: /\bSET\s+\w/i },
  { label: 'DO $$ block', regex: /\bDO\s*\$\$/i },
  { label: 'UNION (without ALL)', regex: /\bUNION\b(?!\s+ALL\b)/i },
];

// Tables that NL queries are permitted to access
const ALLOWED_TABLES = new Set([
  'gl_journal_entries', 'gl_journal_lines', 'gl_accounts', 'gl_account_balances',
  'recurring_journals',
  'customers', 'customer_invoices', 'customer_invoice_items',
  'customer_payments', 'customer_payment_allocations',
  'customer_quotes', 'customer_quote_lines',
  'customer_sales_orders', 'customer_sales_order_items',
  'customer_write_offs', 'customer_categories', 'credit_notes',
  'recurring_invoices', 'dunning_templates', 'dunning_sends',
  'suppliers', 'supplier_invoices', 'supplier_invoice_items',
  'supplier_payments', 'supplier_payment_allocations', 'supplier_payment_batches',
  'supplier_purchase_orders', 'supplier_purchase_order_items',
  'purchase_orders', 'supplier_categories',
  'bank_transactions', 'bank_accounts', 'bank_reconciliations',
  'bank_categorisation_rules', 'bank_import_batches',
  'items', 'item_categories', 'stock_items', 'stock_adjustments',
  'products', 'product_categories',
  'vat_returns', 'vat_adjustments', 'sars_submissions',
  'assets', 'asset_categories', 'asset_depreciation_schedule', 'asset_disposals',
  'fiscal_periods', 'accounting_budgets', 'currencies', 'exchange_rates',
  'projects', 'project_time_entries', 'time_entries',
  'cost_centres', 'business_units',
  'payroll_runs', 'payslips', 'employees', 'leave_types',
  'leave_balances', 'leave_applications',
  'captured_documents',
]);

const MAX_LIMIT = 100;

export function validateGeneratedSQL(sql: string): SQLValidation {
  if (!sql || sql.trim() === '') {
    return { valid: false, error: 'Empty SQL', sanitizedSQL: '' };
  }

  const upper = sql.toUpperCase().trim();

  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return { valid: false, error: 'Query must be a SELECT statement', sanitizedSQL: '' };
  }

  for (const kw of FORBIDDEN_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    if (regex.test(sql)) {
      return { valid: false, error: `Forbidden keyword: ${kw}`, sanitizedSQL: '' };
    }
  }

  for (const { label, regex } of FORBIDDEN_PATTERNS) {
    if (regex.test(sql)) {
      return { valid: false, error: `Forbidden pattern detected: ${label}`, sanitizedSQL: '' };
    }
  }

  const withoutTrailingSemicolon = sql.trimEnd().replace(/;$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    return { valid: false, error: 'Multiple statements not allowed', sanitizedSQL: '' };
  }

  // Extract CTE aliases so they pass the table allowlist
  const cteAliases = new Set<string>();
  const ctePattern = /\bWITH\s+(\w+)\s+AS\b/gi;
  let cteMatch: RegExpExecArray | null;
  while ((cteMatch = ctePattern.exec(sql)) !== null) {
    cteAliases.add(cteMatch[1]!.toLowerCase());
  }

  // Table allowlist check — only at top-level (paren depth 0)
  const kwPattern = /\b(FROM|JOIN)\s+(\w+)/gi;
  let kwMatch: RegExpExecArray | null;
  while ((kwMatch = kwPattern.exec(sql)) !== null) {
    let depth = 0;
    for (let i = 0; i < kwMatch.index; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
    }
    if (depth > 0) continue;

    const tableName = kwMatch[2]!.toLowerCase();
    if (!ALLOWED_TABLES.has(tableName) && !cteAliases.has(tableName)) {
      return { valid: false, error: `Table '${kwMatch[2]}' not allowed`, sanitizedSQL: '' };
    }
  }

  let sanitizedSQL = sql.trim().replace(/;$/, '');
  if (!/\bLIMIT\b/i.test(sanitizedSQL)) {
    sanitizedSQL += ` LIMIT ${MAX_LIMIT}`;
  }

  return { valid: true, sanitizedSQL };
}
