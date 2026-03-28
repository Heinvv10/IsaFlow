/**
 * TDD: Natural Language Financial Query Tests
 * RED phase.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTextToSQLPrompt,
  parseSQLResponse,
  validateGeneratedSQL,
  formatQueryResult,
  buildSchemaDescription,
  classifyQueryIntent,
  type SchemaTable,
  type QueryResult,
  type QueryIntent,
} from '@/modules/accounting/services/nlQueryService';

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA DESCRIPTION
// ═══════════════════════════════════════════════════════════════════════════

describe('Schema Description Building', () => {
  const tables: SchemaTable[] = [
    { name: 'customer_invoices', columns: ['id', 'customer_id', 'invoice_date', 'total_amount', 'status'], description: 'Customer invoices' },
    { name: 'suppliers', columns: ['id', 'name', 'email', 'is_active'], description: 'Supplier master data' },
  ];

  it('builds human-readable schema', () => {
    const desc = buildSchemaDescription(tables);
    expect(desc).toContain('customer_invoices');
    expect(desc).toContain('total_amount');
    expect(desc).toContain('suppliers');
  });

  it('includes column names', () => {
    const desc = buildSchemaDescription(tables);
    expect(desc).toContain('invoice_date');
    expect(desc).toContain('is_active');
  });

  it('includes table descriptions', () => {
    const desc = buildSchemaDescription(tables);
    expect(desc).toContain('Customer invoices');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEXT-TO-SQL PROMPT
// ═══════════════════════════════════════════════════════════════════════════

describe('Text-to-SQL Prompt Building', () => {
  it('includes user question', () => {
    const prompt = buildTextToSQLPrompt('What were total sales last month?', 'schema here');
    expect(prompt).toContain('total sales last month');
  });

  it('includes schema context', () => {
    const prompt = buildTextToSQLPrompt('test query', 'TABLE: customers (id, name)');
    expect(prompt).toContain('TABLE: customers');
  });

  it('requests SQL output', () => {
    const prompt = buildTextToSQLPrompt('test', 'schema');
    expect(prompt.toLowerCase()).toContain('sql');
    expect(prompt.toLowerCase()).toContain('select');
  });

  it('enforces read-only (no INSERT/UPDATE/DELETE)', () => {
    const prompt = buildTextToSQLPrompt('test', 'schema');
    expect(prompt.toLowerCase()).toContain('read-only');
  });

  it('requests JSON format for explanation', () => {
    const prompt = buildTextToSQLPrompt('test', 'schema');
    expect(prompt.toLowerCase()).toContain('json');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SQL RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════

describe('SQL Response Parsing', () => {
  it('extracts SQL from response', () => {
    const response = '```sql\nSELECT SUM(total_amount) FROM customer_invoices WHERE invoice_date >= \'2026-01-01\'\n```\nThis query sums all invoices.';
    const result = parseSQLResponse(response);
    expect(result).toBeDefined();
    expect(result!.sql).toContain('SELECT');
    expect(result!.sql).toContain('SUM');
  });

  it('extracts explanation', () => {
    const response = '{"sql": "SELECT COUNT(*) FROM customers", "explanation": "Counts all customers"}';
    const result = parseSQLResponse(response);
    expect(result).toBeDefined();
    expect(result!.explanation).toContain('customer');
  });

  it('handles plain SQL without markdown', () => {
    const response = 'SELECT name, SUM(total_amount) as total FROM customer_invoices GROUP BY name';
    const result = parseSQLResponse(response);
    expect(result).toBeDefined();
    expect(result!.sql).toContain('SELECT');
  });

  it('returns null for non-SQL response', () => {
    expect(parseSQLResponse('I cannot answer that')).toBeNull();
    expect(parseSQLResponse('')).toBeNull();
  });

  it('handles JSON with sql field', () => {
    const response = '{"sql": "SELECT * FROM gl_accounts LIMIT 10", "explanation": "Lists GL accounts"}';
    const result = parseSQLResponse(response);
    expect(result!.sql).toContain('gl_accounts');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SQL VALIDATION (security)
// ═══════════════════════════════════════════════════════════════════════════

describe('SQL Validation', () => {
  it('allows SELECT queries', () => {
    expect(validateGeneratedSQL('SELECT * FROM customers').valid).toBe(true);
  });

  it('allows aggregate queries', () => {
    expect(validateGeneratedSQL('SELECT SUM(total_amount) FROM customer_invoices').valid).toBe(true);
  });

  it('rejects INSERT statements', () => {
    expect(validateGeneratedSQL('INSERT INTO customers (name) VALUES (\'hack\')').valid).toBe(false);
  });

  it('rejects UPDATE statements', () => {
    expect(validateGeneratedSQL('UPDATE customers SET name = \'hack\'').valid).toBe(false);
  });

  it('rejects DELETE statements', () => {
    expect(validateGeneratedSQL('DELETE FROM customers').valid).toBe(false);
  });

  it('rejects DROP statements', () => {
    expect(validateGeneratedSQL('DROP TABLE customers').valid).toBe(false);
  });

  it('rejects ALTER statements', () => {
    expect(validateGeneratedSQL('ALTER TABLE customers ADD COLUMN hack TEXT').valid).toBe(false);
  });

  it('rejects TRUNCATE', () => {
    expect(validateGeneratedSQL('TRUNCATE customers').valid).toBe(false);
  });

  it('rejects multiple statements (semicolons)', () => {
    expect(validateGeneratedSQL('SELECT 1; DROP TABLE customers').valid).toBe(false);
  });

  it('allows WITH (CTE) queries', () => {
    expect(validateGeneratedSQL('WITH totals AS (SELECT SUM(amount) FROM invoices) SELECT * FROM totals').valid).toBe(true);
  });

  it('rejects empty SQL', () => {
    expect(validateGeneratedSQL('').valid).toBe(false);
  });

  it('adds LIMIT if not present', () => {
    const result = validateGeneratedSQL('SELECT * FROM customers');
    expect(result.sanitizedSQL).toContain('LIMIT');
  });

  it('preserves existing LIMIT', () => {
    const result = validateGeneratedSQL('SELECT * FROM customers LIMIT 5');
    expect(result.sanitizedSQL).toContain('LIMIT 5');
    // Should not add a second LIMIT
    expect(result.sanitizedSQL.match(/LIMIT/gi)?.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// QUERY INTENT CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

describe('Query Intent Classification', () => {
  it('detects revenue queries', () => {
    expect(classifyQueryIntent('What was our total revenue last month?')).toBe('revenue');
  });

  it('detects expense queries', () => {
    expect(classifyQueryIntent('Show me top expenses this quarter')).toBe('expense');
  });

  it('detects customer queries', () => {
    expect(classifyQueryIntent('List all customers with outstanding balances')).toBe('customer');
  });

  it('detects supplier queries', () => {
    expect(classifyQueryIntent('Which suppliers did we pay the most?')).toBe('supplier');
  });

  it('detects cash/bank queries', () => {
    expect(classifyQueryIntent('What is our current bank balance?')).toBe('cash');
  });

  it('detects tax/VAT queries', () => {
    expect(classifyQueryIntent('How much VAT did we collect?')).toBe('tax');
  });

  it('defaults to general for ambiguous queries', () => {
    expect(classifyQueryIntent('Show me a summary')).toBe('general');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RESULT FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

describe('Query Result Formatting', () => {
  it('formats single value result', () => {
    const result = formatQueryResult([{ total: 150000 }], 'What is total revenue?');
    expect(result.summary).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('formats tabular results', () => {
    const rows = [
      { name: 'Customer A', total: 50000 },
      { name: 'Customer B', total: 30000 },
    ];
    const result = formatQueryResult(rows, 'Top customers');
    expect(result.rows).toHaveLength(2);
    expect(result.columns).toContain('name');
    expect(result.columns).toContain('total');
  });

  it('handles empty results', () => {
    const result = formatQueryResult([], 'Any data?');
    expect(result.rows).toHaveLength(0);
    expect(result.summary).toContain('No results');
  });

  it('detects numeric columns for formatting', () => {
    const result = formatQueryResult([{ amount: 15000.5 }], 'test');
    expect(result.numericColumns).toContain('amount');
  });
});
