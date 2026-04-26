/**
 * Natural Language Financial Query Service
 * Text-to-SQL with Claude, validation, formatting.
 * SQL validation extracted to nlQueryValidationService.ts.
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
    `TABLE: ${t.name} (${t.columns.join(', ')}) — ${t.description}`,
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

  try {
    const jsonMatch = response.match(/\{[\s\S]*"sql"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.sql && typeof parsed.sql === 'string' && (parsed.sql.trim().toUpperCase().startsWith('SELECT') || parsed.sql.trim().toUpperCase().startsWith('WITH'))) {
        return { sql: parsed.sql.trim(), explanation: String(parsed.explanation || '') };
      }
    }
  } catch { /* not JSON */ }

  const sqlBlock = response.match(/```(?:sql)?\s*\n?([\s\S]*?)\n?```/);
  if (sqlBlock) {
    const sql = sqlBlock[1]!.trim();
    if (sql.toUpperCase().startsWith('SELECT') || sql.toUpperCase().startsWith('WITH')) {
      const explanationMatch = response.replace(sqlBlock[0], '').trim();
      return { sql, explanation: explanationMatch.slice(0, 200) };
    }
  }

  const trimmed = response.trim();
  if (trimmed.toUpperCase().startsWith('SELECT') || trimmed.toUpperCase().startsWith('WITH')) {
    return { sql: trimmed, explanation: '' };
  }

  return null;
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

export function formatQueryResult(rows: Record<string, unknown>[], _question: string): QueryResult {
  if (!rows || rows.length === 0) {
    return { rows: [], columns: [], numericColumns: [], summary: 'No results found for your query.', rowCount: 0 };
  }

  const columns = Object.keys(rows[0]!);
  const numericColumns = columns.filter(col =>
    rows.some(r => typeof r[col] === 'number' || (typeof r[col] === 'string' && !isNaN(Number(r[col])) && r[col] !== '')),
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

// SQL validation re-exported from split file for backward compat
export { validateGeneratedSQL, type SQLValidation } from './nlQueryValidationService';
