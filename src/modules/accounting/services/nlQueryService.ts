/**
 * Natural Language Financial Query Service
 * Text-to-SQL with Claude, validation, formatting.
 * Pure business logic — no database dependencies.
 */

export interface SchemaTable {
  name: string;
  columns: string[];
  description: string;
}

export interface ParsedSQL {
  sql: string;
  explanation: string;
}

export interface SQLValidation {
  valid: boolean;
  error?: string;
  sanitizedSQL: string;
}

export type QueryIntent = 'revenue' | 'expense' | 'customer' | 'supplier' | 'cash' | 'tax' | 'payroll' | 'inventory' | 'general';

export interface QueryResult {
  rows: Record<string, unknown>[];
  columns: string[];
  numericColumns: string[];
  summary: string;
  rowCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA DESCRIPTION
// ═══════════════════════════════════════════════════════════════════════════

export function buildSchemaDescription(tables: SchemaTable[]): string {
  return tables.map(t =>
    `TABLE: ${t.name} (${t.columns.join(', ')}) — ${t.description}`
  ).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT-TO-SQL PROMPT
// ═══════════════════════════════════════════════════════════════════════════

export function buildTextToSQLPrompt(question: string, schemaDesc: string, companyId?: string): string {
  const companyFilter = companyId
    ? `CRITICAL: Every query MUST include WHERE company_id = '${companyId}' on ALL tables that have a company_id column. Never omit this filter — omitting it is a security violation.`
    : '';

  return `You are a South African accounting database assistant. Generate a read-only PostgreSQL SELECT query to answer the user's question.

Database Schema:
${schemaDesc}

User Question: ${question}

Rules:
- Generate ONLY read-only SELECT queries (no INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE)
- Use proper SQL aggregation (SUM, COUNT, AVG, etc.) where appropriate
- Use ZAR currency context (South African Rand)
- Format dates as YYYY-MM-DD
- Limit results to 100 rows max unless the user asks for a specific count
- Use table aliases for readability
${companyFilter}

Respond in JSON format:
{"sql": "SELECT ...", "explanation": "Brief explanation of what this query returns"}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// SQL RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════

export function parseSQLResponse(response: string): ParsedSQL | null {
  if (!response || response.trim() === '') return null;

  // Try JSON parse first
  try {
    const jsonMatch = response.match(/\{[\s\S]*"sql"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.sql && typeof parsed.sql === 'string' && parsed.sql.trim().toUpperCase().startsWith('SELECT') || parsed.sql.trim().toUpperCase().startsWith('WITH')) {
        return { sql: parsed.sql.trim(), explanation: String(parsed.explanation || '') };
      }
    }
  } catch { /* not JSON */ }

  // Try SQL code block
  const sqlBlock = response.match(/```(?:sql)?\s*\n?([\s\S]*?)\n?```/);
  if (sqlBlock) {
    const sql = sqlBlock[1]!.trim();
    if (sql.toUpperCase().startsWith('SELECT') || sql.toUpperCase().startsWith('WITH')) {
      const explanationMatch = response.replace(sqlBlock[0], '').trim();
      return { sql, explanation: explanationMatch.slice(0, 200) };
    }
  }

  // Try plain SQL
  const trimmed = response.trim();
  if (trimmed.toUpperCase().startsWith('SELECT') || trimmed.toUpperCase().startsWith('WITH')) {
    return { sql: trimmed, explanation: '' };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SQL VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

// DML/DDL keywords that must never appear in a read-only query
const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE',
  'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'UNION', 'INFORMATION_SCHEMA',
  'PG_CATALOG', 'INTO OUTFILE', 'LOAD_FILE',
  // PostgreSQL administrative / file-access / control keywords
  'COPY', 'DO', 'CALL', 'PREPARE', 'LISTEN', 'NOTIFY', 'LOAD', 'IMPORT',
  // PostgreSQL file-access and server-control functions
  'PG_READ_FILE', 'PG_READ_BINARY_FILE', 'PG_LS_DIR',
  'LO_IMPORT', 'LO_EXPORT', 'PG_SLEEP',
  // Runtime configuration manipulation
  'CURRENT_SETTING', 'SET_CONFIG', 'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND',
];

// Dangerous function-call patterns that warrant a separate regex sweep
const FORBIDDEN_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  // Any pg_ function invocation (covers pg_read_file, pg_ls_dir, etc.)
  { label: 'pg_ function call', regex: /\bpg_\w+\s*\(/i },
  // dblink — cross-database tunnelling
  { label: 'dblink call', regex: /\bdblink\s*\(/i },
  // COPY with TO or FROM (data exfiltration / injection)
  { label: 'COPY TO/FROM', regex: /\bCOPY\b[\s\S]*?\b(TO|FROM)\b/i },
];

const MAX_LIMIT = 100;

export function validateGeneratedSQL(sql: string): SQLValidation {
  if (!sql || sql.trim() === '') {
    return { valid: false, error: 'Empty SQL', sanitizedSQL: '' };
  }

  const upper = sql.toUpperCase().trim();

  // Must start with SELECT or WITH
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return { valid: false, error: 'Query must be a SELECT statement', sanitizedSQL: '' };
  }

  // Check for forbidden keywords using word-boundary, case-insensitive match
  for (const kw of FORBIDDEN_KEYWORDS) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    if (regex.test(sql)) {
      return { valid: false, error: `Forbidden keyword: ${kw}`, sanitizedSQL: '' };
    }
  }

  // Check for dangerous function-call patterns
  for (const { label, regex } of FORBIDDEN_PATTERNS) {
    if (regex.test(sql)) {
      return { valid: false, error: `Forbidden pattern detected: ${label}`, sanitizedSQL: '' };
    }
  }

  // Reject multiple statements
  const statements = sql.split(';').filter(s => s.trim().length > 0);
  if (statements.length > 1) {
    return { valid: false, error: 'Multiple statements not allowed', sanitizedSQL: '' };
  }

  // Add LIMIT if not present
  let sanitizedSQL = sql.trim().replace(/;$/, '');
  if (!/\bLIMIT\b/i.test(sanitizedSQL)) {
    sanitizedSQL += ` LIMIT ${MAX_LIMIT}`;
  }

  return { valid: true, sanitizedSQL };
}

// ═══════════════════════════════════════════════════════════════════════════
// QUERY INTENT CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

const INTENT_PATTERNS: Array<{ intent: QueryIntent; patterns: RegExp[] }> = [
  { intent: 'revenue', patterns: [/\brevenue\b/i, /\bsales\b/i, /\bincome\b/i, /\bturnover\b/i, /\bbilling\b/i] },
  { intent: 'expense', patterns: [/\bexpens/i, /\bcost\b/i, /\bspend/i, /\bpurchas/i] },
  { intent: 'customer', patterns: [/\bcustomer/i, /\bclient/i, /\bdebtor/i, /\breceivable/i] },
  { intent: 'supplier', patterns: [/\bsupplier/i, /\bvendor/i, /\bcreditor/i, /\bpayable/i] },
  { intent: 'cash', patterns: [/\bcash\b/i, /\bbank\b/i, /\bbalance\b/i, /\bliquidity/i] },
  { intent: 'tax', patterns: [/\bvat\b/i, /\btax\b/i, /\bsars\b/i, /\bpaye\b/i] },
  { intent: 'payroll', patterns: [/\bpayroll\b/i, /\bsalary\b/i, /\bwage/i, /\bemploee/i] },
  { intent: 'inventory', patterns: [/\binventory\b/i, /\bstock\b/i, /\bproduct/i] },
];

export function classifyQueryIntent(question: string): QueryIntent {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some(p => p.test(question))) return intent;
  }
  return 'general';
}

// ═══════════════════════════════════════════════════════════════════════════
// RESULT FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

export function formatQueryResult(rows: Record<string, unknown>[], question: string): QueryResult {
  if (!rows || rows.length === 0) {
    return { rows: [], columns: [], numericColumns: [], summary: 'No results found for your query.', rowCount: 0 };
  }

  const columns = Object.keys(rows[0]!);
  const numericColumns = columns.filter(col =>
    rows.some(r => typeof r[col] === 'number' || (typeof r[col] === 'string' && !isNaN(Number(r[col])) && r[col] !== ''))
  );

  let summary: string;
  if (rows.length === 1 && columns.length === 1) {
    const value = rows[0]![columns[0]!];
    summary = `Result: ${value}`;
  } else if (rows.length === 1) {
    summary = columns.map(c => `${c}: ${rows[0]![c]}`).join(', ');
  } else {
    summary = `${rows.length} result${rows.length === 1 ? '' : 's'} returned.`;
  }

  return { rows, columns, numericColumns, summary, rowCount: rows.length };
}
